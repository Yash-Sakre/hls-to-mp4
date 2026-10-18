import { abortError, ErrorCode, HlsToMp4Error, throwIfAborted } from './errors.js';
import { assertDecryptable, createDecryptor, createFetcher } from './fetcher.js';
import { acquireEngine, releaseEngine, resolveFFmpegConfig } from './ffmpeg.js';
import { assertPlaylist, isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist, pickAudioRendition, pickVariant } from './playlist.js';
import { remuxToMp4 } from './remux.js';
import { saveBlob } from './save.js';
import { groupIntoParts, initKey, selectSegments, toRangeBound } from './select.js';

/** Default `maxBytes`: ffmpeg.wasm keeps the whole output MP4 in memory. */
export const DEFAULT_MAX_BYTES = 1024 ** 3;
const DEFAULT_CONCURRENCY = 6;
// After this many segments, project the final size from the observed bitrate
// and fail fast instead of downloading a gigabyte before giving up.
const SIZE_PROJECTION_MIN_SEGMENTS = 4;
const SIZE_PROJECTION_SLACK = 1.25;

const noop = () => {};

const absoluteUrl = (url) => new URL(url, globalThis.location?.href).href;

const formatBytes = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const tooLarge = (bytes, limit) =>
  new HlsToMp4Error(
    ErrorCode.TOO_LARGE,
    `This range is too large to convert in the browser (~${formatBytes(bytes)}, limit ${formatBytes(limit)}). Choose a shorter range.`,
    { bytes, limit },
  );

/**
 * Fetch the playlist (and, for a master playlist, the chosen variant and its
 * separate audio rendition, if any).
 */
export const resolvePlaylists = async (url, { variant = 'highest', audio = 'auto', fetcher, signal }) => {
  const text = await fetcher.text(url, signal);
  assertPlaylist(text, url);
  if (!isMasterPlaylist(text)) {
    return { master: null, variant: null, audioRendition: null, media: parseMediaPlaylist(text, url), audioMedia: null };
  }
  const master = parseMasterPlaylist(text, url);
  const chosen = pickVariant(master.variants, variant);
  const rendition = audio === 'none' ? null : pickAudioRendition(master.audioRenditions, chosen.audioGroup);
  const separateAudio = rendition && rendition.url !== chosen.url ? rendition : null;
  const [mediaText, audioText] = await Promise.all([
    fetcher.text(chosen.url, signal),
    separateAudio ? fetcher.text(separateAudio.url, signal) : null,
  ]);
  assertPlaylist(mediaText, chosen.url);
  if (separateAudio) assertPlaylist(audioText, separateAudio.url);
  return {
    master,
    variant: chosen,
    audioRendition: rendition,
    media: parseMediaPlaylist(mediaText, chosen.url),
    audioMedia: separateAudio ? parseMediaPlaylist(audioText, separateAudio.url) : null,
  };
};

const extensionOf = (url) => /\.(ts|aac|mp3|ac3|ec3|mp4|m4s|m4a|m4v|cmf[av])(?:$|[?#])/i.exec(new URL(url).pathname)?.[1].toLowerCase();

const partName = (prefix, index, part) => `${prefix}${index}.${part.init ? 'mp4' : (extensionOf(part.segments[0].url) ?? 'ts')}`;

// Downloads every item with bounded concurrency, preserving order. Any
// failure (or the outer abort) cancels the remaining requests.
const downloadAll = async (items, { concurrency, signal, onItem }) => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal.addEventListener('abort', forwardAbort);
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const index = next;
      next += 1;
      results[index] = await items[index].load(controller.signal);
      onItem(items[index], results[index]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  } catch (err) {
    controller.abort();
    throw signal.aborted ? abortError() : err;
  } finally {
    signal.removeEventListener('abort', forwardAbort);
  }
  throwIfAborted(signal);
  return results;
};

const validateOptions = ({ url, audio, concurrency, maxBytes }) => {
  if (typeof url !== 'string' || !url) throw new TypeError('`url` must be the URL of an HLS playlist.');
  if (audio !== 'auto' && audio !== 'none') throw new TypeError("`audio` must be 'auto' or 'none'.");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('`concurrency` must be a positive integer.');
  if (!(maxBytes > 0)) throw new TypeError('`maxBytes` must be a positive number (or Infinity).');
};

/**
 * Download an HLS playlist — or the part of it between `start` and `end` —
 * and remux it into a single MP4 in the browser.
 *
 * @param {import('../types/index').ExportOptions} options
 * @returns {Promise<Blob>}
 */
export const exportHlsToMp4 = async (options) => {
  const {
    url,
    start,
    end,
    trim = true,
    variant = 'highest',
    audio = 'auto',
    maxBytes = DEFAULT_MAX_BYTES,
    concurrency = DEFAULT_CONCURRENCY,
    retries = 2,
    fetch,
    fetchOptions,
    ffmpeg,
    signal = new AbortController().signal,
    onProgress = noop,
    onLog,
  } = options ?? {};
  validateOptions({ url, audio, concurrency, maxBytes });
  const startBound = toRangeBound(start, 'start');
  const endBound = toRangeBound(end, 'end');
  throwIfAborted(signal);

  // Load the ~31 MB wasm core while the segments download.
  const ffmpegConfig = resolveFFmpegConfig(ffmpeg);
  const enginePromise = acquireEngine(ffmpegConfig);
  enginePromise.catch(noop);
  let engineUsed = false;
  let succeeded = false;

  const progress = { phase: 'downloading', ratio: 0, segmentsDone: 0, segmentsTotal: 0, bytesDownloaded: 0 };
  const report = (patch) => {
    Object.assign(progress, patch);
    onProgress({ ...progress });
  };

  try {
    report({});
    const fetcher = createFetcher({ fetch, fetchOptions, retries });
    const decrypt = createDecryptor(fetcher);
    const { media, audioMedia } = await resolvePlaylists(absoluteUrl(url), { variant, audio, fetcher, signal });

    const selection = selectSegments(media.segments, startBound, endBound);
    let audioSelection = null;
    if (audioMedia) {
      // Separate audio renditions share the variant's timeline; select them by
      // the same range on that timeline (fine alignment happens in remux).
      const first = selection.segments[0];
      const last = selection.segments[selection.segments.length - 1];
      const from = trim ? selection.offsetStart : first.start;
      const to = trim ? selection.offsetEnd : last.start + last.duration;
      audioSelection = selectSegments(
        audioMedia.segments,
        startBound ? { kind: 'offset', seconds: from } : null,
        endBound ? { kind: 'offset', seconds: to } : null,
      );
    }
    const tracks = [
      { prefix: 'v', parts: groupIntoParts(selection.segments) },
      ...(audioSelection ? [{ prefix: 'a', parts: groupIntoParts(audioSelection.segments) }] : []),
    ];

    // One download item per media segment, plus one per distinct init section.
    const items = [];
    const initItems = new Map();
    for (const track of tracks) {
      for (const part of track.parts) {
        if (part.init && !initItems.has(initKey(part.init))) {
          assertDecryptable(part.init.key);
          const { init } = part;
          const sequence = part.segments[0].sequence;
          const item = {
            duration: 0,
            load: async (s) => decrypt(await fetcher.blob(init.url, { signal: s, byteRange: init.byteRange }), init.key, sequence, s),
          };
          initItems.set(initKey(init), item);
          items.push(item);
        }
        part.items = part.segments.map((seg) => {
          assertDecryptable(seg.key);
          const item = {
            duration: seg.duration,
            load: async (s) => decrypt(await fetcher.blob(seg.url, { signal: s, byteRange: seg.byteRange }), seg.key, seg.sequence, s),
          };
          items.push(item);
          return item;
        });
      }
    }

    const totalDuration = items.reduce((sum, item) => sum + item.duration, 0);
    let mediaDone = 0;
    let doneDuration = 0;
    report({ segmentsTotal: items.length });
    const blobs = await downloadAll(items, {
      concurrency,
      signal,
      onItem: (item, blob) => {
        const bytes = progress.bytesDownloaded + blob.size;
        if (bytes > maxBytes) throw tooLarge(bytes, maxBytes);
        if (item.duration > 0) {
          mediaDone += 1;
          doneDuration += item.duration;
          if (mediaDone === SIZE_PROJECTION_MIN_SEGMENTS && doneDuration > 0) {
            const projected = (bytes / doneDuration) * totalDuration;
            if (projected > maxBytes * SIZE_PROJECTION_SLACK) throw tooLarge(projected, maxBytes);
          }
        }
        const segmentsDone = progress.segmentsDone + 1;
        report({ segmentsDone, bytesDownloaded: bytes, ratio: segmentsDone / items.length });
      },
    });
    const blobOf = new Map(items.map((item, i) => [item, blobs[i]]));
    const [mainParts, audioParts = null] = tracks.map((track) =>
      track.parts.map((part, i) => ({
        name: partName(track.prefix, i, part),
        fmp4: !!part.init,
        blob: new Blob([...(part.init ? [blobOf.get(initItems.get(initKey(part.init)))] : []), ...part.items.map((item) => blobOf.get(item))]),
      })),
    );

    report({ phase: 'converting', ratio: 0 });
    const engine = await enginePromise;
    throwIfAborted(signal);
    engineUsed = true;
    const blob = await remuxToMp4(engine, {
      mainParts,
      audioParts,
      headTrim: trim ? selection.headTrim : 0,
      trimEnd: trim && selection.tailTrim > 0,
      duration: trim ? selection.duration : selection.duration + selection.headTrim + selection.tailTrim,
      dropAudio: audio === 'none',
      signal,
      onProgress: (ratio) => report({ ratio }),
      onLog,
    });
    succeeded = true;
    report({ ratio: 1 });
    return blob;
  } catch (err) {
    throw signal.aborted ? abortError() : err;
  } finally {
    enginePromise.then(
      (engine) => (!engineUsed || succeeded ? releaseEngine(engine, ffmpegConfig) : engine.terminate()),
      noop,
    );
  }
};

/**
 * `exportHlsToMp4` + save the result as a browser download.
 *
 * @param {import('../types/index').DownloadOptions} options
 * @returns {Promise<{ blob: Blob, fileName: string }>}
 */
export const downloadHlsAsMp4 = async ({ fileName = 'video.mp4', ...options } = {}) => {
  const blob = await exportHlsToMp4(options);
  const name = /\.(mp4|m4a|m4v)$/i.test(fileName) ? fileName : `${fileName}.mp4`;
  saveBlob(blob, name);
  return { blob, fileName: name };
};
