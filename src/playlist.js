// HLS playlist parsing (RFC 8216). Pure functions — no network or DOM access.

import { ErrorCode, HlsToMp4Error } from './errors.js';

const ATTRIBUTE_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

/** Parse an attribute list (`KEY=value,KEY2="quoted, value"`) into an object. */
export const parseAttributes = (value) => {
  const attrs = {};
  for (const [, key, raw] of value.matchAll(ATTRIBUTE_RE)) {
    attrs[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attrs;
};

const splitLines = (text) =>
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const resolveUrl = (uri, baseUrl) => new URL(uri, baseUrl).href;

/**
 * Parse an ISO 8601 date-time to epoch ms (NaN when invalid). Accepts the
 * offset forms HLS packagers emit — `Z`, `+05:30`, `+0530`, `+05` — which
 * `Date.parse` only partly understands across engines.
 */
export const parseDateTime = (value) => {
  const normalized = String(value)
    .trim()
    .replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3')
    .replace(/(T[\d:.]+[+-]\d{2})$/, '$1:00');
  return Date.parse(normalized);
};

const tagValue = (line) => line.slice(line.indexOf(':') + 1);

export const isPlaylist = (text) => typeof text === 'string' && text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');

export const assertPlaylist = (text, url) => {
  if (!isPlaylist(text)) {
    throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, `The response from ${url} is not an HLS playlist.`, { url });
  }
};

export const isMasterPlaylist = (text) => /^#EXT-X-STREAM-INF:/m.test(text);

const parseResolution = (value) => {
  const match = /^(\d+)x(\d+)$/.exec(value ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

/** `<length>[@<offset>]` → `{ length, offset }` (offset is null when omitted). */
export const parseByteRange = (value) => {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, `Invalid byte range "${value}".`);
  return { length: Number(match[1]), offset: match[2] === undefined ? null : Number(match[2]) };
};

const parseIv = (value) => {
  const hex = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,32}$/i.test(hex)) throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, `Invalid IV "${value}".`);
  const padded = hex.padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) iv[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return iv;
};

const parseKey = (attrs, baseUrl) => {
  const method = attrs.METHOD || 'NONE';
  if (method === 'NONE') return null;
  return {
    method,
    url: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
    iv: attrs.IV ? parseIv(attrs.IV) : null,
    keyFormat: attrs.KEYFORMAT || 'identity',
  };
};

// Several EXT-X-KEY tags in a row describe the same segments for different
// key systems; prefer the plain AES-128 ("identity") one when there is one.
const pickKey = (keys) => {
  if (!keys.length) return undefined;
  if (keys.some((key) => key === null)) return null;
  return keys.find((key) => key.keyFormat === 'identity') ?? keys[0];
};

/**
 * Parse a master (multivariant) playlist.
 * @returns {{ variants: object[], audioRenditions: object[] }}
 */
export const parseMasterPlaylist = (text, baseUrl) => {
  const lines = splitLines(text);
  const variants = [];
  const audioRenditions = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      let uriIndex = i + 1;
      while (uriIndex < lines.length && lines[uriIndex].startsWith('#') && !lines[uriIndex].startsWith('#EXT-X-STREAM-INF:')) {
        uriIndex += 1;
      }
      if (uriIndex >= lines.length || lines[uriIndex].startsWith('#')) continue;
      const attrs = parseAttributes(tagValue(line));
      variants.push({
        url: resolveUrl(lines[uriIndex], baseUrl),
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        averageBandwidth: Number(attrs['AVERAGE-BANDWIDTH']) || null,
        resolution: parseResolution(attrs.RESOLUTION),
        codecs: attrs.CODECS ?? null,
        frameRate: Number(attrs['FRAME-RATE']) || null,
        audioGroup: attrs.AUDIO ?? null,
      });
      i = uriIndex;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(tagValue(line));
      if (attrs.TYPE !== 'AUDIO') continue;
      audioRenditions.push({
        groupId: attrs['GROUP-ID'] ?? null,
        name: attrs.NAME ?? null,
        language: attrs.LANGUAGE ?? null,
        default: attrs.DEFAULT === 'YES',
        autoselect: attrs.AUTOSELECT === 'YES',
        url: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
      });
    }
  }
  return { variants, audioRenditions };
};

// Fill in a wall-clock time for every segment from the EXT-X-PROGRAM-DATE-TIME
// tags that are present: forwards by adding durations, and backwards for any
// segments before the first tag.
const fillProgramDateTime = (segments) => {
  const first = segments.findIndex((seg) => seg.programDateTime !== null);
  if (first === -1) return;
  for (let i = first - 1; i >= 0; i -= 1) {
    segments[i].programDateTime = segments[i + 1].programDateTime - segments[i].duration * 1000;
  }
  for (let i = first + 1; i < segments.length; i += 1) {
    if (segments[i].programDateTime === null) {
      segments[i].programDateTime = segments[i - 1].programDateTime + segments[i - 1].duration * 1000;
    }
  }
};

/**
 * Parse a media playlist into its segments. Each segment carries everything
 * needed to fetch and decode it on its own: URL, byte range, init section and
 * key, plus its position on the playlist timeline (`start`, seconds) and on
 * the wall clock (`programDateTime`, epoch ms or null).
 */
export const parseMediaPlaylist = (text, baseUrl) => {
  const segments = [];
  let mediaSequence = 0;
  let targetDuration = null;
  let endList = false;
  let playlistType = null;

  let key = null;
  let keysSinceSegment = [];
  let init = null;
  let pending = null;
  const resetPending = () => {
    pending = { duration: 0, discontinuity: false, gap: false, programDateTime: null, byteRange: null };
  };
  resetPending();
  let previous = null;

  for (const line of splitLines(text)) {
    if (line.startsWith('#EXTINF:')) {
      pending.duration = parseFloat(tagValue(line)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pending.byteRange = parseByteRange(tagValue(line));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      pending.discontinuity = true;
    } else if (line === '#EXT-X-GAP') {
      pending.gap = true;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const ms = parseDateTime(tagValue(line));
      pending.programDateTime = Number.isFinite(ms) ? ms : null;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      keysSinceSegment.push(parseKey(parseAttributes(tagValue(line)), baseUrl));
      key = pickKey(keysSinceSegment);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(tagValue(line));
      if (!attrs.URI) throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, 'EXT-X-MAP is missing its URI.');
      const byteRange = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE) : null;
      init = {
        url: resolveUrl(attrs.URI, baseUrl),
        byteRange: byteRange ? { length: byteRange.length, offset: byteRange.offset ?? 0 } : null,
        key,
      };
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(tagValue(line), 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(tagValue(line)) || null;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = tagValue(line);
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      let { byteRange } = pending;
      if (byteRange && byteRange.offset === null) {
        if (!previous?.byteRange || previous.url !== url) {
          throw new HlsToMp4Error(
            ErrorCode.INVALID_PLAYLIST,
            'EXT-X-BYTERANGE without an offset must follow a sub-range of the same resource.',
          );
        }
        byteRange = { length: byteRange.length, offset: previous.byteRange.offset + previous.byteRange.length };
      }
      previous = {
        index: segments.length,
        url,
        duration: pending.duration,
        start: 0,
        sequence: mediaSequence + segments.length,
        discontinuity: pending.discontinuity,
        gap: pending.gap,
        programDateTime: pending.programDateTime,
        byteRange,
        init,
        key,
      };
      segments.push(previous);
      keysSinceSegment = [];
      resetPending();
    }
  }

  let offset = 0;
  for (const seg of segments) {
    seg.start = offset;
    offset += seg.duration;
  }
  fillProgramDateTime(segments);

  return {
    segments,
    duration: offset,
    mediaSequence,
    targetDuration,
    playlistType,
    endList,
    hasProgramDateTime: segments.some((seg) => seg.programDateTime !== null),
  };
};

const pixels = (variant) => (variant.resolution ? variant.resolution.width * variant.resolution.height : 0);

/**
 * Choose a variant: `'highest'` (default) or `'lowest'` bandwidth, or a
 * function that receives the variants and returns one of them.
 */
export const pickVariant = (variants, preference = 'highest') => {
  if (!variants.length) throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, 'The master playlist lists no variants.');
  if (typeof preference === 'function') {
    const chosen = preference(variants.slice());
    if (!chosen?.url) throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, 'The `variant` function did not return a variant.');
    return chosen;
  }
  if (preference !== 'highest' && preference !== 'lowest') {
    throw new TypeError(`Unknown variant preference "${preference}". Use 'highest', 'lowest' or a function.`);
  }
  const sign = preference === 'highest' ? 1 : -1;
  return variants.reduce((best, v) => {
    const diff = (v.bandwidth - best.bandwidth) * sign || (pixels(v) - pixels(best)) * sign;
    return diff > 0 ? v : best;
  });
};

/**
 * The audio rendition to fetch separately for a variant, or null when the
 * variant's audio is muxed into its own segments.
 */
export const pickAudioRendition = (renditions, groupId) => {
  if (!groupId) return null;
  const candidates = renditions.filter((r) => r.groupId === groupId && r.url);
  return candidates.find((r) => r.default) ?? candidates.find((r) => r.autoselect) ?? candidates[0] ?? null;
};
