// Browser side of the benchmarks: exposes `window.bench` for run.mjs.
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

import { createDecryptor } from '../../src/fetcher.js';
import * as lib from '../../src/index.js';

const local = { coreURL, wasmURL };

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

window.bench = {
  async preload({ cdn = false } = {}) {
    const t0 = performance.now();
    await lib.preloadFFmpeg(cdn ? undefined : local);
    return performance.now() - t0;
  },

  dispose: () => lib.disposeFFmpeg(),

  gc: () => window.gc?.(),

  /**
   * One export. Times the download phase (until the first 'converting'
   * progress event) and the conversion phase separately. Optional aborts
   * measure how long cancellation takes to settle the promise.
   */
  async run(options, { cdn = false, returnData = false, abortAfterMs = null, abortAfterConvertingMs = null } = {}) {
    const controller = new AbortController();
    let tAbort = null;
    const abort = () => {
      tAbort = performance.now();
      controller.abort();
    };
    if (abortAfterMs !== null) setTimeout(abort, abortAfterMs);
    let tConvert = null;
    let last = null;
    const t0 = performance.now();
    try {
      const blob = await lib.exportHlsToMp4({
        ...(cdn ? {} : { ffmpeg: local }),
        ...options,
        signal: controller.signal,
        onProgress: (p) => {
          last = p;
          if (p.phase === 'converting' && tConvert === null) {
            tConvert = performance.now();
            if (abortAfterConvertingMs !== null) setTimeout(abort, abortAfterConvertingMs);
          }
        },
      });
      const t1 = performance.now();
      return {
        ok: true,
        totalMs: t1 - t0,
        downloadMs: tConvert - t0,
        convertMs: t1 - tConvert,
        size: blob.size,
        bytesDownloaded: last.bytesDownloaded,
        segments: last.segmentsTotal,
        data: returnData ? await toBase64(blob) : null,
      };
    } catch (err) {
      const t1 = performance.now();
      return {
        ok: false,
        totalMs: t1 - t0,
        abortLatencyMs: tAbort !== null ? t1 - tAbort : null,
        isAbort: lib.isAbortError(err),
        code: err?.code ?? null,
        message: String(err?.message ?? err),
        phase: last?.phase ?? null,
        bytesDownloaded: last?.bytesDownloaded ?? 0,
        segmentsDone: last?.segmentsDone ?? 0,
        segmentsTotal: last?.segmentsTotal ?? 0,
      };
    }
  },

  /** AES-128-CBC segment decryption through the library's decryptor (Web Crypto). */
  async aes({ segmentBytes = 3 * 1024 * 1024, segments = 32, parallel = 1 } = {}) {
    const rawKey = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plain = new Uint8Array(segmentBytes);
    for (let i = 0; i < plain.length; i += 65536) crypto.getRandomValues(plain.subarray(i, i + 65536));
    const encrypted = new Blob([await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain)]);
    const decrypt = createDecryptor({ arrayBuffer: async () => rawKey.buffer.slice(0) });
    const segKey = { method: 'AES-128', url: 'key', iv, keyFormat: 'identity' };
    await decrypt(encrypted, segKey, 0); // warm-up (imports the key)
    const t0 = performance.now();
    let next = 0;
    const worker = async () => {
      while (next < segments) {
        next += 1;
        await decrypt(encrypted, segKey, 0);
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    const seconds = (performance.now() - t0) / 1000;
    return { mbPerSecond: (segmentBytes * segments) / 1024 / 1024 / seconds };
  },
};
