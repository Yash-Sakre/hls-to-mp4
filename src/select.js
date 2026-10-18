// Time-range selection over parsed media playlist segments.

import { ErrorCode, HlsToMp4Error } from './errors.js';
import { parseDateTime } from './playlist.js';

/**
 * Normalise a `start`/`end` option.
 *
 * - number → seconds from the start of the playlist (`{ kind: 'offset' }`)
 * - Date, date string, or an object with `valueOf()` in epoch ms (dayjs,
 *   moment, Luxon…) → wall-clock time (`{ kind: 'wallclock' }`), matched
 *   against EXT-X-PROGRAM-DATE-TIME.
 * - null/undefined → open-ended (returns null).
 */
export const toRangeBound = (value, name) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new HlsToMp4Error(ErrorCode.INVALID_RANGE, `\`${name}\` must be a non-negative number of seconds.`);
    }
    return { kind: 'offset', seconds: value };
  }
  const ms = typeof value === 'string' ? parseDateTime(value) : Number(value?.valueOf?.());
  if (!Number.isFinite(ms)) {
    throw new HlsToMp4Error(ErrorCode.INVALID_RANGE, `\`${name}\` is not a valid time.`);
  }
  return { kind: 'wallclock', seconds: ms / 1000 };
};

const EPSILON = 0.0005;

/**
 * Pick the segments overlapping [start, end] and work out how much to trim off
 * the first and last of them.
 *
 * @returns {{
 *   segments: object[],   selected segments (gaps excluded), in order
 *   headTrim: number,     seconds to drop from the start of the first segment
 *   tailTrim: number,     seconds to drop from the end of the last segment
 *   duration: number,     output duration after trimming (gaps collapsed)
 *   offsetStart: number,  range start on the playlist timeline (seconds)
 *   offsetEnd: number,    range end on the playlist timeline (seconds)
 * }}
 */
export const selectSegments = (segments, startBound, endBound) => {
  const kind = startBound?.kind ?? endBound?.kind ?? 'offset';
  if (startBound && endBound && startBound.kind !== endBound.kind) {
    throw new HlsToMp4Error(
      ErrorCode.INVALID_RANGE,
      '`start` and `end` must both be seconds (numbers) or both be wall-clock times (Date/string).',
    );
  }
  if (kind === 'wallclock' && segments.some((seg) => seg.programDateTime === null)) {
    throw new HlsToMp4Error(
      ErrorCode.INVALID_RANGE,
      'Wall-clock ranges need EXT-X-PROGRAM-DATE-TIME in the playlist. Pass `start`/`end` as seconds from the start of the playlist instead.',
    );
  }

  const startOf = kind === 'wallclock' ? (seg) => seg.programDateTime / 1000 : (seg) => seg.start;
  const from = startBound?.seconds ?? -Infinity;
  const to = endBound?.seconds ?? Infinity;
  if (to <= from) throw new HlsToMp4Error(ErrorCode.INVALID_RANGE, '`end` must be after `start`.');

  const selected = segments.filter((seg) => {
    if (seg.gap) return false;
    const segStart = startOf(seg);
    return segStart + seg.duration > from && segStart < to;
  });
  if (!selected.length) {
    throw new HlsToMp4Error(
      ErrorCode.NO_SEGMENTS,
      kind === 'offset' && Number.isFinite(from)
        ? 'No segments in the requested range. Numeric `start`/`end` are seconds from the start of the playlist; pass Date objects for wall-clock times.'
        : 'No segments in the requested range.',
    );
  }

  const first = selected[0];
  const last = selected[selected.length - 1];
  const rawHead = Math.max(0, from - startOf(first));
  const rawTail = Math.max(0, startOf(last) + last.duration - to);
  const headTrim = rawHead > EPSILON ? rawHead : 0;
  const tailTrim = rawTail > EPSILON ? rawTail : 0;
  const total = selected.reduce((sum, seg) => sum + seg.duration, 0);

  return {
    segments: selected,
    headTrim,
    tailTrim,
    duration: Math.max(0, total - headTrim - tailTrim),
    offsetStart: first.start + headTrim,
    offsetEnd: last.start + last.duration - tailTrim,
  };
};

const initKey = (init) => (init ? `${init.url}|${init.byteRange?.offset ?? ''}|${init.byteRange?.length ?? ''}` : '');

/**
 * Group consecutive segments into parts. Each part is one contiguous byte
 * stream (optional init section + media segments); a new part starts at every
 * discontinuity, init-section change, or skipped segment. ffmpeg's concat
 * demuxer then joins the parts and re-bases their timestamps.
 */
export const groupIntoParts = (segments) => {
  const parts = [];
  let prev = null;
  for (const seg of segments) {
    const startsPart = !prev || seg.discontinuity || initKey(seg.init) !== initKey(prev.init) || seg.index !== prev.index + 1;
    if (startsPart) parts.push({ init: seg.init, segments: [] });
    parts[parts.length - 1].segments.push(seg);
    prev = seg;
  }
  return parts;
};

export { initKey };
