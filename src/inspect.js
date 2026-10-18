import { createFetcher } from './fetcher.js';
import { resolvePlaylists } from './export.js';

const absoluteUrl = (url) => new URL(url, globalThis.location?.href).href;

const describeEncryption = (segments) => {
  const methods = new Set();
  for (const seg of segments) {
    for (const key of [seg.key, seg.init?.key]) {
      if (key) methods.add(key.keyFormat === 'identity' ? key.method : `${key.method} (${key.keyFormat})`);
    }
  }
  return methods.size ? [...methods].join(', ') : null;
};

/**
 * Fetch and summarise a playlist without downloading any media — e.g. to show
 * the duration or wall-clock span before choosing a range.
 *
 * @param {string} url
 * @param {import('../types/index').PlaylistOptions} [options]
 * @returns {Promise<import('../types/index').HlsInfo>}
 */
export const inspectHls = async (url, { variant = 'highest', fetch, fetchOptions, retries = 2, signal } = {}) => {
  const fetcher = createFetcher({ fetch, fetchOptions, retries });
  const resolved = await resolvePlaylists(absoluteUrl(url), { variant, audio: 'auto', fetcher, signal });
  const { segments } = resolved.media;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const encryption = describeEncryption(segments);
  return {
    url: absoluteUrl(url),
    isMaster: !!resolved.master,
    variants: resolved.master?.variants ?? [],
    variant: resolved.variant,
    audioRenditions: resolved.master?.audioRenditions ?? [],
    audioRendition: resolved.audioRendition,
    separateAudio: !!resolved.audioMedia,
    duration: resolved.media.duration,
    segmentCount: segments.length,
    targetDuration: resolved.media.targetDuration,
    live: !resolved.media.endList,
    container: first?.init ? 'fmp4' : 'ts',
    encryption,
    exportable: !encryption || /^AES-128$/.test(encryption),
    byteRange: segments.some((seg) => seg.byteRange),
    discontinuities: segments.filter((seg) => seg.discontinuity).length,
    programDateTime:
      resolved.media.hasProgramDateTime && first
        ? { start: new Date(first.programDateTime), end: new Date(last.programDateTime + last.duration * 1000) }
        : null,
  };
};
