// ffmpeg.wasm engine.
//
// Talks to @ffmpeg/core directly from an inline module worker (created from a
// Blob URL) instead of going through @ffmpeg/ffmpeg. That keeps the package
// free of `new URL('./worker.js', import.meta.url)`, so it works in any
// bundler (or none) without configuration. The core is loaded by URL.

import { ErrorCode, HlsToMp4Error } from './errors.js';

export const FFMPEG_CORE_VERSION = '0.12.10';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;
export const DEFAULT_FFMPEG_CORE_URL = `${CDN_BASE}/ffmpeg-core.js`;
export const DEFAULT_FFMPEG_WASM_URL = `${CDN_BASE}/ffmpeg-core.wasm`;

const WORKER_SOURCE = `
let core = null;
const ops = {
  async load({ coreURL, wasmURL }) {
    const mod = await import(coreURL);
    const createFFmpegCore = mod.default;
    if (typeof createFFmpegCore !== 'function') {
      throw new Error(coreURL + ' is not an @ffmpeg/core ESM build (no default export).');
    }
    const workerURL = coreURL.replace(/\\.js$/, '.worker.js');
    core = await createFFmpegCore({
      mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL, workerURL })),
    });
    core.setLogger((data) => self.postMessage({ event: 'log', data }));
    core.setProgress((data) => self.postMessage({ event: 'progress', data }));
  },
  exec({ args }) {
    if (typeof core.setTimeout === 'function') core.setTimeout(-1);
    core.exec(...args);
    const ret = core.ret;
    core.reset();
    return ret;
  },
  ffprobe({ args }) {
    if (typeof core.setTimeout === 'function') core.setTimeout(-1);
    core.ffprobe(...args);
    const ret = core.ret;
    core.reset();
    return ret;
  },
  mount({ dir, blobs }) {
    core.FS.mkdir(dir);
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs }, dir);
  },
  unmount({ dir }) {
    core.FS.unmount(dir);
    core.FS.rmdir(dir);
  },
  writeFile({ path, data }) {
    core.FS.writeFile(path, data);
  },
  readFile({ path }) {
    return core.FS.readFile(path);
  },
  unlink({ path }) {
    core.FS.unlink(path);
  },
};
self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const result = await ops[op](args);
    self.postMessage({ id, ok: true, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
`;

const absoluteUrl = (url) => new URL(url, globalThis.location?.href).href;

class FFmpegEngine {
  constructor(worker) {
    this.worker = worker;
    this.terminated = false;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = { log: new Set(), progress: new Set() };
    worker.onmessage = ({ data }) => {
      if (data.event) {
        for (const fn of this.listeners[data.event] ?? []) fn(data.data);
        return;
      }
      const call = this.pending.get(data.id);
      if (!call) return;
      this.pending.delete(data.id);
      if (data.ok) call.resolve(data.result);
      else call.reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.terminate(new Error(event.message || 'The ffmpeg worker failed to start.'));
    };
  }

  call(op, args = {}) {
    if (this.terminated) return Promise.reject(new Error('The ffmpeg worker was terminated.'));
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args });
    });
  }

  on(event, fn) {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  /** Kill the worker — the only way to stop a running exec. */
  terminate(reason = new Error('The ffmpeg worker was terminated.')) {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    for (const call of this.pending.values()) call.reject(reason);
    this.pending.clear();
  }
}

/** Fill in defaults: the jsDelivr CDN, or the `.wasm` next to a custom `coreURL`. */
export const resolveFFmpegConfig = (config = {}) => {
  const coreURL = config.coreURL ?? DEFAULT_FFMPEG_CORE_URL;
  const wasmURL = config.wasmURL ?? (config.coreURL ? config.coreURL.replace(/\.js(\?.*)?$/, '.wasm$1') : DEFAULT_FFMPEG_WASM_URL);
  return { coreURL, wasmURL };
};

const configKey = ({ coreURL, wasmURL }) => `${coreURL}\n${wasmURL}`;

const createEngine = async (config) => {
  if (typeof Worker === 'undefined') {
    throw new HlsToMp4Error(ErrorCode.FFMPEG_LOAD, 'hls-to-mp4 needs a browser with Web Worker support.');
  }
  const coreURL = absoluteUrl(config.coreURL);
  const wasmURL = absoluteUrl(config.wasmURL);
  const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  let engine;
  try {
    engine = new FFmpegEngine(new Worker(workerUrl, { type: 'module', name: 'hls-to-mp4' }));
    await engine.call('load', { coreURL, wasmURL });
    return engine;
  } catch (err) {
    engine?.terminate();
    throw new HlsToMp4Error(ErrorCode.FFMPEG_LOAD, `Could not load ffmpeg.wasm from ${coreURL}: ${err?.message ?? err}`, {
      cause: err,
    });
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
};

// One idle, already-loaded engine is kept around so the next export (or one
// warmed up with preloadFFmpeg) skips the ~31 MB core load. Exports running at
// the same time each get their own worker.
let warm = null;

const setWarm = (key, promise) => {
  const entry = { key, promise };
  warm = entry;
  promise.catch(() => {
    if (warm === entry) warm = null;
  });
};

export const acquireEngine = (config) => {
  const key = configKey(config);
  if (warm?.key === key) {
    const { promise } = warm;
    warm = null;
    return promise;
  }
  return createEngine(config);
};

export const releaseEngine = (engine, config) => {
  if (engine.terminated) return;
  if (warm) engine.terminate();
  else setWarm(configKey(config), Promise.resolve(engine));
};

/**
 * Start loading ffmpeg.wasm ahead of the first export (e.g. when the user
 * opens an export dialog). Resolves once the core is ready.
 */
export const preloadFFmpeg = async (config) => {
  const resolved = resolveFFmpegConfig(config);
  const key = configKey(resolved);
  if (warm?.key !== key) {
    warm?.promise.then((engine) => engine.terminate(), () => {});
    setWarm(key, createEngine(resolved));
  }
  await warm.promise;
};

/** Terminate the idle ffmpeg worker kept for reuse, freeing its memory. */
export const disposeFFmpeg = () => {
  warm?.promise.then((engine) => engine.terminate(), () => {});
  warm = null;
};
