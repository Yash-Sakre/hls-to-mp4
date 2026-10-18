// Browser side of the e2e tests: exposes `window.harness` for run.mjs.
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

import * as lib from '../../src/index.js';

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const summarize = (events) => {
  const phases = [...new Set(events.map((e) => e.phase))];
  const monotonic = events.every((e, i) => {
    const prev = events[i - 1];
    return !prev || prev.phase !== e.phase || e.ratio >= prev.ratio;
  });
  const last = events[events.length - 1];
  return {
    phases,
    monotonic,
    events: events.length,
    finalRatio: last?.ratio ?? null,
    segmentsDone: last?.segmentsDone ?? 0,
    segmentsTotal: last?.segmentsTotal ?? 0,
    bytesDownloaded: last?.bytesDownloaded ?? 0,
  };
};

// Load the MP4 into a <video> to confirm the browser itself can decode it.
const playback = (blob) =>
  new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    const url = URL.createObjectURL(blob);
    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    video.onloadeddata = () => done({ ok: true, duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => done({ ok: false, error: video.error?.message || `MediaError ${video.error?.code}` });
    setTimeout(() => done({ ok: false, error: 'timeout' }), 10000);
    video.src = url;
  });

window.harness = {
  localFFmpeg: { coreURL, wasmURL },

  async run(options, { abortAfterMs = null, useCdn = false, checkPlayback = false } = {}) {
    const controller = new AbortController();
    if (abortAfterMs !== null) setTimeout(() => controller.abort(), abortAfterMs);
    const events = [];
    const t0 = performance.now();
    try {
      const blob = await lib.exportHlsToMp4({
        ...(useCdn ? {} : { ffmpeg: this.localFFmpeg }),
        ...options,
        signal: controller.signal,
        onProgress: (p) => events.push(p),
      });
      return {
        ok: true,
        ms: Math.round(performance.now() - t0),
        type: blob.type,
        size: blob.size,
        progress: summarize(events),
        playback: checkPlayback ? await playback(blob) : null,
        data: await toBase64(blob),
      };
    } catch (err) {
      return {
        ok: false,
        ms: Math.round(performance.now() - t0),
        name: err?.name,
        code: err instanceof lib.HlsToMp4Error ? err.code : null,
        message: String(err?.message ?? err),
        isAbort: lib.isAbortError(err),
        progress: summarize(events),
      };
    }
  },

  async inspect(url, options) {
    const info = await lib.inspectHls(url, options);
    return JSON.parse(JSON.stringify(info));
  },

  preload: () => lib.preloadFFmpeg(window.harness.localFFmpeg),
};
