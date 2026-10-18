// Browser benchmarks: real exports in headless Chrome against local HLS
// streams, timed per phase, with Chrome's memory sampled and every accuracy
// output checked with native ffprobe. Requires ffmpeg/ffprobe and Google
// Chrome (or set CHROME_PATH).
//
//   node test/bench/run.mjs [--only=load,features,scale,cold,network,concurrent,accuracy,guard,cancel,aes]
//                           [--long]     also export the whole 20-minute stream (~600 MB; needs ~3 GB free RAM)
//                           [--no-cdn]   skip loading ffmpeg.wasm from the default CDN
//
// Results are printed and written to test/bench/.out/browser.json.
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const benchPublic = path.join(root, 'test/bench/.public');
const outDir = path.join(root, 'test/bench/.out');
const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const enabled = (name) => !only || only.includes(name);
const LONG = argv.includes('--long');
const CDN = !argv.includes('--no-cdn');

if (!fs.existsSync(path.join(root, 'demo/public/samples/index.json'))) {
  execFileSync('bash', [path.join(root, 'scripts/make-samples.sh')], { stdio: 'inherit' });
}
if (!fs.existsSync(path.join(benchPublic, 'long-fmp4/index.m3u8'))) {
  execFileSync('bash', [path.join(root, 'test/bench/make-bench-samples.sh')], { stdio: 'inherit' });
}
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Stats and formatting
// ---------------------------------------------------------------------------

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => {
  const s = sorted(xs);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stats = (xs) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length });
const fmtMs = (ms) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
const mbps = (bytes, ms) => (bytes * 8) / 1e6 / (ms / 1000);
const results = {};
const heading = (title) => console.log(`\n=== ${title}`);

// ---------------------------------------------------------------------------
// Chrome memory: total RSS of the browser process tree
// ---------------------------------------------------------------------------

const MARKER = '--hls-to-mp4-bench';
const chromeRss = async () => {
  const { stdout } = await execFileP('ps', ['-eo', 'pid=,ppid=,rss=,args='], { maxBuffer: 16 * 1024 * 1024 });
  const procs = stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, args: m[4] }));
  const marked = new Set(procs.filter((p) => p.args.includes(MARKER)).map((p) => p.pid));
  const main = procs.find((p) => marked.has(p.pid) && !marked.has(p.ppid));
  if (!main) return 0;
  const tree = new Set([main.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  return procs.filter((p) => tree.has(p.pid)).reduce((sum, p) => sum + p.rss, 0);
};

const memorySampler = () => {
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      peak = Math.max(peak, await chromeRss());
      await sleep(100);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return peak;
  };
};

// ---------------------------------------------------------------------------
// Static server for the long streams, with optional network throttling:
// time to first byte, a per-connection bandwidth cap and a shared total cap.
// ---------------------------------------------------------------------------

const PROFILES = [
  { name: 'Fast (fibre / nearby CDN)', ttfbMs: 20, perConnMbps: 50, totalMbps: 300 },
  { name: 'Typical broadband', ttfbMs: 50, perConnMbps: 20, totalMbps: 100 },
  { name: 'Slow (mobile / distant origin)', ttfbMs: 150, perConnMbps: 8, totalMbps: 30 },
];

let profile = null;
let totalNext = 0;
const CONTENT_TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4' };

const mediaServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const file = path.join(benchPublic, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(benchPublic + path.sep)) return res.writeHead(403).end();
  let data;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    return res.writeHead(404).end();
  }
  const p = profile;
  if (p) await sleep(p.ttfbMs);
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': data.length });
  if (!p) return res.end(data);
  const CHUNK = 16 * 1024;
  const perConn = (p.perConnMbps * 1e6) / 8 / 1000; // bytes per ms
  const total = (p.totalMbps * 1e6) / 8 / 1000;
  let connNext = performance.now();
  for (let offset = 0; offset < data.length && !res.destroyed; offset += CHUNK) {
    const chunk = data.subarray(offset, offset + CHUNK);
    const now = performance.now();
    const at = Math.max(now, connNext, totalNext);
    connNext = at + chunk.length / perConn;
    totalNext = at + chunk.length / total;
    if (at > now + 1) await sleep(at - now);
    if (!res.write(chunk)) await once(res, 'drain');
  }
  res.end();
});
mediaServer.listen(47125, '127.0.0.1');
await once(mediaServer, 'listening');
const MEDIA = 'http://127.0.0.1:47125/';

// ---------------------------------------------------------------------------
// ffprobe checks (the same ones the e2e suite uses)
// ---------------------------------------------------------------------------

const ffprobe = (file) => {
  const json = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,start_time,duration', '-of', 'json', file]).toString(),
  );
  return {
    duration: Number(json.format.duration),
    video: json.streams.find((s) => s.codec_type === 'video') ?? null,
    audio: json.streams.find((s) => s.codec_type === 'audio') ?? null,
  };
};

const firstFrameIsKey = (file) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', file])
    .toString()
    .trim()
    .startsWith('1');

const decodeErrors = (file) => {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return err.stderr?.toString().trim().split('\n').slice(-1)[0] || 'decode failed';
  }
};

// Flash-to-beep offsets (seconds) of the sync markers at every even second.
const syncOffsets = (file) => {
  const flashes = [];
  const meta = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
  let pts = null;
  for (const row of meta.split('\n')) {
    const time = /pts_time:(-?[\d.]+)/.exec(row);
    if (time) pts = Number(time[1]);
    const yavg = /YAVG=([\d.]+)/.exec(row);
    if (yavg && Number(yavg[1]) > 200 && pts !== null) flashes.push(pts);
  }
  const rate = 8000;
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-af', `aresample=${rate}:async=1:first_pts=0`, '-ac', '1', '-f', 's16le', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const onsets = [];
  let quiet = rate;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > 3000) {
      if (quiet > rate / 2) onsets.push(i / rate);
      quiet = 0;
    } else quiet += 1;
  }
  return flashes
    .filter((f, i) => f > 0.1 && (i === 0 || f - flashes[i - 1] > 0.2))
    .map((f) => onsets.reduce((best, o) => (Math.abs(o - f) < Math.abs(best - f) ? o : best), Infinity) - f)
    .filter((offset) => Math.abs(offset) < 1);
};

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

const vite = await createServer({
  root,
  configFile: false,
  publicDir: path.join(root, 'demo/public'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 47124 },
});
await vite.listen();
const base = vite.resolvedUrls.local[0];

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: [MARKER, '--js-flags=--expose-gc'],
});
const openPage = async (context) => {
  const page = await context.newPage();
  await page.goto(`${base}test/bench/harness.html`);
  await page.waitForFunction(() => window.bench);
  return page;
};
const mainContext = await browser.newContext();
const page = await openPage(mainContext);
const bench = (fn, arg) => page.evaluate(fn, arg);
const run = (options, opts = {}) => page.evaluate(([o, r]) => window.bench.run(o, r), [options, opts]);

// A loaded, idle worker with an empty wasm heap: each measured export starts
// from the same state.
const freshEngine = async () => {
  await bench(() => window.bench.dispose());
  await bench(() => window.bench.preload());
  await bench(() => window.bench.gc());
  await sleep(400);
};

const cpus = os.cpus();
results.environment = {
  cpu: cpus[0].model.trim(),
  threads: cpus.length,
  ramGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)),
  os: `${os.type()} ${os.release()}`,
  node: process.version,
  chrome: browser.version(),
  nativeFfmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0],
  ffmpegCore: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@ffmpeg/core/package.json'), 'utf8')).version,
};
heading('Environment');
console.log(results.environment);

const TS = (file = 'index.m3u8') => `${MEDIA}long-ts/${file}`;
const FMP4 = (file = 'index.m3u8') => `${MEDIA}long-fmp4/${file}`;

try {
  // -------------------------------------------------------------------------
  if (enabled('load')) {
    heading('ffmpeg.wasm load time');
    const cold = [];
    for (let i = 0; i < 5; i += 1) {
      // A new browser context has an empty HTTP cache: download + compile.
      const context = await browser.newContext();
      const p = await openPage(context);
      cold.push(await p.evaluate(() => window.bench.preload()));
      await context.close();
    }
    await bench(() => window.bench.preload());
    const cached = [];
    for (let i = 0; i < 5; i += 1) {
      await bench(() => window.bench.dispose());
      cached.push(await bench(() => window.bench.preload()));
    }
    const reuse = [];
    for (let i = 0; i < 5; i += 1) reuse.push(await bench(() => window.bench.preload()));
    const cdn = [];
    let cdnError = null;
    if (CDN) {
      for (let i = 0; i < 3 && !cdnError; i += 1) {
        const context = await browser.newContext();
        const p = await openPage(context);
        try {
          cdn.push(await p.evaluate(() => window.bench.preload({ cdn: true })));
        } catch (err) {
          cdnError = err.message.split('\n')[0];
        }
        await context.close();
      }
    }
    results.load = {
      coldLocal: stats(cold),
      cachedNewWorker: stats(cached),
      reuseIdleWorker: stats(reuse),
      coldCdn: cdn.length ? stats(cdn) : null,
      cdnError,
    };
    console.log(`  cold, local server (download + compile)   ${fmtMs(results.load.coldLocal.median)}  (${fmtMs(results.load.coldLocal.min)}–${fmtMs(results.load.coldLocal.max)})`);
    console.log(`  new worker, core in HTTP cache            ${fmtMs(results.load.cachedNewWorker.median)}`);
    console.log(`  reuse of the idle warm worker             ${results.load.reuseIdleWorker.median.toFixed(2)} ms`);
    console.log(`  cold, jsDelivr CDN                        ${cdn.length ? `${fmtMs(results.load.coldCdn.median)}  (${fmtMs(results.load.coldCdn.min)}–${fmtMs(results.load.coldCdn.max)})` : cdnError ?? 'skipped'}`);
  }

  // -------------------------------------------------------------------------
  if (enabled('features')) {
    heading('Feature samples (24 s, 640x360, ~0.6 Mbps; engine preloaded; median of 5)');
    const samples = [
      ['MPEG-TS, H.264 + AAC', '/samples/ts/index.m3u8'],
      ['fMP4 / CMAF', '/samples/fmp4/index.m3u8'],
      ['MP2 audio → AAC transcode', '/samples/mp2/index.m3u8'],
      ['AES-128 encrypted TS', '/samples/aes/index.m3u8'],
      ['Byte-range segments', '/samples/byterange/index.m3u8'],
      ['HEVC (hvc1)', '/samples/hevc/index.m3u8'],
      ['Master playlist (2 variants)', '/samples/multi/master.m3u8'],
      ['Separate audio rendition (fMP4)', '/samples/altaudio/master.m3u8'],
      ['Discontinuity (2 recordings)', '/samples/disc/index.m3u8'],
      ['Video only', '/samples/noaudio/index.m3u8'],
    ];
    await bench(() => window.bench.preload());
    results.features = [];
    for (const [name, url] of samples) {
      const runs = [];
      for (let i = 0; i < 6; i += 1) runs.push(await run({ url }));
      const ok = runs.filter((r) => r.ok).slice(1); // the first run warms the page's fetch path
      const row = {
        name,
        totalMs: median(ok.map((r) => r.totalMs)),
        downloadMs: median(ok.map((r) => r.downloadMs)),
        convertMs: median(ok.map((r) => r.convertMs)),
        bytesDownloaded: ok[0]?.bytesDownloaded,
        size: ok[0]?.size,
        failures: runs.filter((r) => !r.ok).map((r) => r.message),
      };
      results.features.push(row);
      console.log(
        `  ${name.padEnd(34)} total ${fmtMs(row.totalMs).padStart(7)}  download ${fmtMs(row.downloadMs).padStart(6)}  convert ${fmtMs(row.convertMs).padStart(6)}  in ${fmtMB(row.bytesDownloaded)} → out ${fmtMB(row.size)}${row.failures.length ? `  FAIL ${row.failures[0]}` : ''}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  if (enabled('scale')) {
    heading('Scaling with clip length (720p H.264 4 Mbps + AAC, 6 s segments, local server, fresh worker per run)');
    const plan = [
      { kind: 'ts', seconds: 30, reps: 5 },
      { kind: 'ts', seconds: 60, reps: 5 },
      { kind: 'ts', seconds: 120, reps: 3 },
      { kind: 'ts', seconds: 300, reps: 3 },
      { kind: 'ts', seconds: 600, reps: 2 },
      ...(LONG ? [{ kind: 'ts', seconds: 1200, reps: 1 }] : []),
      { kind: 'fmp4', seconds: 60, reps: 3 },
      { kind: 'fmp4', seconds: 300, reps: 3 },
      { kind: 'fmp4', seconds: 600, reps: 2 },
    ];
    results.scale = [];
    for (const { kind, seconds, reps } of plan) {
      const url = kind === 'ts' ? TS() : FMP4();
      const options = seconds >= 1200 ? { url } : { url, start: 0, end: seconds };
      const runs = [];
      for (let i = 0; i < reps; i += 1) {
        await freshEngine();
        const baseline = await chromeRss();
        const stop = memorySampler();
        const r = await run(options);
        const peak = await stop();
        await bench(() => window.bench.gc());
        await sleep(300);
        const idleAfter = await chromeRss();
        if (!r.ok) throw new Error(`${kind} ${seconds}s export failed: ${r.message}`);
        runs.push({ ...r, peakDelta: peak - baseline, retained: idleAfter - baseline });
      }
      // Native ffmpeg doing the same remux from local disk, for reference.
      const native = [];
      const nativeOut = path.join(outDir, 'native.mp4');
      const input = path.join(benchPublic, kind === 'ts' ? 'long-ts/index.m3u8' : 'long-fmp4/index.m3u8');
      for (let i = 0; i < Math.min(reps, 3); i += 1) {
        const t0 = performance.now();
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-allowed_extensions', 'ALL', '-i', input, ...(seconds < 1200 ? ['-t', String(seconds)] : []), '-c', 'copy', '-movflags', '+faststart', nativeOut]);
        native.push(performance.now() - t0);
      }
      fs.rmSync(nativeOut, { force: true });
      const row = {
        kind,
        seconds,
        reps,
        bytesDownloaded: runs[0].bytesDownloaded,
        size: runs[0].size,
        segments: runs[0].segments,
        totalMs: median(runs.map((r) => r.totalMs)),
        downloadMs: median(runs.map((r) => r.downloadMs)),
        convertMs: median(runs.map((r) => r.convertMs)),
        peakRssDelta: Math.max(...runs.map((r) => r.peakDelta)),
        retainedRssDelta: median(runs.map((r) => r.retained)),
        nativeMs: median(native),
      };
      row.realtimeFactor = seconds / (row.totalMs / 1000);
      row.throughputMBps = row.bytesDownloaded / 1024 / 1024 / (row.totalMs / 1000);
      results.scale.push(row);
      console.log(
        `  ${kind.padEnd(4)} ${String(seconds / 60).padStart(4)} min  in ${fmtMB(row.bytesDownloaded).padStart(7)}  total ${fmtMs(row.totalMs).padStart(7)} (download ${fmtMs(row.downloadMs)}, convert ${fmtMs(row.convertMs)})  ${row.realtimeFactor.toFixed(0)}× realtime  ${row.throughputMBps.toFixed(0)} MB/s  peak RSS +${fmtMB(row.peakRssDelta)}  retained +${fmtMB(row.retainedRssDelta)}  native ffmpeg ${fmtMs(row.nativeMs)}`,
      );
    }
    // Memory the idle warm worker keeps after a large export, and after disposeFFmpeg().
    await freshEngine();
    const before = await chromeRss();
    await run({ url: TS(), start: 0, end: 600 });
    await bench(() => window.bench.gc());
    await sleep(500);
    const idleWarm = await chromeRss();
    await bench(() => window.bench.dispose());
    await bench(() => window.bench.gc());
    await sleep(1000);
    const disposed = await chromeRss();
    results.retention = { afterExportDelta: idleWarm - before, afterDisposeDelta: disposed - before };
    console.log(`  idle after a 10-min export: +${fmtMB(idleWarm - before)} held by the warm worker; after disposeFFmpeg(): ${fmtMB(disposed - before)}`);
  }

  // -------------------------------------------------------------------------
  if (enabled('cold')) {
    heading('First export on a fresh page (no preload: core load overlaps the download)');
    results.cold = [];
    for (const seconds of [30, 300]) {
      const cold = [];
      for (let i = 0; i < 3; i += 1) {
        const context = await browser.newContext();
        const p = await openPage(context);
        const r = await p.evaluate((o) => window.bench.run(o), { url: TS(), start: 0, end: seconds });
        await context.close();
        if (!r.ok) throw new Error(r.message);
        cold.push(r);
      }
      await freshEngine();
      const warm = [];
      for (let i = 0; i < 3; i += 1) warm.push(await run({ url: TS(), start: 0, end: seconds }));
      const row = {
        seconds,
        coldTotalMs: median(cold.map((r) => r.totalMs)),
        coldDownloadMs: median(cold.map((r) => r.downloadMs)),
        coldConvertMs: median(cold.map((r) => r.convertMs)),
        warmTotalMs: median(warm.map((r) => r.totalMs)),
      };
      results.cold.push(row);
      console.log(`  ${seconds / 60} min clip: first export ${fmtMs(row.coldTotalMs)} (download ${fmtMs(row.coldDownloadMs)}, convert incl. waiting for core ${fmtMs(row.coldConvertMs)})  vs warm ${fmtMs(row.warmTotalMs)}`);
    }
  }

  // -------------------------------------------------------------------------
  if (enabled('network')) {
    heading('Download phase vs network and `concurrency` (2-min range, 4 Mbps stream, ~62 MB, HTTP/1.1)');
    await freshEngine();
    results.network = [];
    for (const prof of PROFILES) {
      profile = prof;
      const rows = [];
      for (const concurrency of [1, 2, 4, 6, 8, 12]) {
        const r = await run({ url: TS(), start: 60, end: 180, concurrency });
        if (!r.ok) throw new Error(r.message);
        rows.push({ concurrency, downloadMs: r.downloadMs, totalMs: r.totalMs, bytes: r.bytesDownloaded, effectiveMbps: mbps(r.bytesDownloaded, r.downloadMs) });
      }
      results.network.push({ profile: prof, rows });
      console.log(`  ${prof.name} — TTFB ${prof.ttfbMs} ms, ${prof.perConnMbps} Mbps per connection, ${prof.totalMbps} Mbps total`);
      for (const row of rows) {
        console.log(`    concurrency ${String(row.concurrency).padStart(2)}: download ${fmtMs(row.downloadMs).padStart(7)}  (${row.effectiveMbps.toFixed(0)} Mbps effective)  total ${fmtMs(row.totalMs)}`);
      }
    }
    profile = null;
  }

  // -------------------------------------------------------------------------
  if (enabled('concurrent')) {
    heading('Simultaneous exports in one page (1-min clips, local server)');
    results.concurrent = [];
    for (const n of [1, 2, 4]) {
      await freshEngine();
      const baseline = await chromeRss();
      const stop = memorySampler();
      const t0 = performance.now();
      const runs = await page.evaluate(
        (urls) => Promise.all(urls.map((o) => window.bench.run(o))),
        Array.from({ length: n }, (_, i) => ({ url: TS(), start: i * 120, end: i * 120 + 60 })),
      );
      const wallMs = performance.now() - t0;
      const peak = await stop();
      if (runs.some((r) => !r.ok)) throw new Error(runs.find((r) => !r.ok).message);
      const row = { n, wallMs, slowestMs: Math.max(...runs.map((r) => r.totalMs)), meanMs: runs.reduce((s, r) => s + r.totalMs, 0) / n, peakRssDelta: peak - baseline };
      results.concurrent.push(row);
      console.log(`  ${n} at once: all done in ${fmtMs(row.slowestMs)} (mean ${fmtMs(row.meanMs)} each)  peak RSS +${fmtMB(row.peakRssDelta)}`);
    }
  }

  // -------------------------------------------------------------------------
  if (enabled('accuracy')) {
    heading('Cut accuracy and A/V sync (random ranges, 2 s GOP; outputs checked with ffprobe)');
    let seed = 42;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    await freshEngine();
    results.accuracy = {};
    for (const [kind, count] of [['ts', 30], ['fmp4', 15]]) {
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        const start = Math.round(random() * 1150 * 1000) / 1000;
        const end = Math.round((start + 2 + random() * 28) * 1000) / 1000;
        const r = await run({ url: kind === 'ts' ? TS() : FMP4(), start, end }, { returnData: true });
        if (!r.ok) {
          rows.push({ start, end, error: r.message });
          continue;
        }
        const file = path.join(outDir, `accuracy-${kind}-${i}.mp4`);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        const probe = ffprobe(file);
        const offsets = syncOffsets(file);
        const requested = end - start;
        // Keyframes sit on every even second, so the cut should begin at
        // floor(start / 2) * 2, i.e. (start mod 2) early.
        const expectedEarly = start % 2;
        rows.push({
          start,
          end,
          requested,
          output: probe.duration,
          early: probe.duration - requested,
          expectedEarly,
          snapError: probe.duration - requested - expectedEarly,
          startsOnKeyframe: firstFrameIsKey(file),
          videoLead: Number(probe.video.start_time) - Number(probe.audio.start_time),
          worstSync: offsets.length ? Math.max(...offsets.map(Math.abs)) : null,
          markers: offsets.length,
          decodeError: decodeErrors(file),
          totalMs: r.totalMs,
        });
        fs.rmSync(file);
      }
      const ok = rows.filter((r) => !r.error);
      const summary = {
        exports: rows.length,
        failed: rows.length - ok.length,
        earlyStart: stats(ok.map((r) => r.early)),
        maxSnapError: Math.max(...ok.map((r) => Math.abs(r.snapError))),
        allStartOnKeyframe: ok.every((r) => r.startsOnKeyframe),
        worstSync: Math.max(...ok.map((r) => r.worstSync ?? 0)),
        maxVideoLead: Math.max(...ok.map((r) => r.videoLead)),
        decodeErrors: ok.filter((r) => r.decodeError).length,
        exportMs: stats(ok.map((r) => r.totalMs)),
        clipSeconds: stats(ok.map((r) => r.requested)),
      };
      results.accuracy[kind] = { summary, rows };
      console.log(
        `  ${kind.padEnd(4)} ${summary.exports} exports, ${summary.failed} failed · starts ${summary.earlyStart.min.toFixed(2)}–${summary.earlyStart.max.toFixed(2)} s early (median ${summary.earlyStart.median.toFixed(2)}) · max deviation from the keyframe before start ${(summary.maxSnapError * 1000).toFixed(0)} ms · first frame keyframe: ${summary.allStartOnKeyframe} · worst A/V offset ${(summary.worstSync * 1000).toFixed(0)} ms · decode errors ${summary.decodeErrors} · export ${fmtMs(summary.exportMs.median)} median for ${summary.clipSeconds.min.toFixed(0)}–${summary.clipSeconds.max.toFixed(0)} s clips`,
      );
    }
  }

  // -------------------------------------------------------------------------
  if (enabled('guard')) {
    heading('Size guard: time to fail when the range is over maxBytes (whole 20-min stream, ~590 MB)');
    results.guard = [];
    for (const prof of [null, PROFILES[1]]) {
      profile = prof;
      for (const maxBytes of [50 * 1024 * 1024, 200 * 1024 * 1024]) {
        await freshEngine();
        const r = await run({ url: TS(), maxBytes });
        const row = { network: prof?.name ?? 'Local', maxBytes, code: r.code, totalMs: r.totalMs, bytesDownloaded: r.bytesDownloaded, segmentsDone: r.segmentsDone, segmentsTotal: r.segmentsTotal };
        results.guard.push(row);
        console.log(`  ${row.network.padEnd(18)} maxBytes ${fmtMB(maxBytes).padStart(6)}: ${row.code ?? 'no error'} after ${fmtMs(row.totalMs)}, ${fmtMB(row.bytesDownloaded)} downloaded (${row.segmentsDone}/${row.segmentsTotal} segments)`);
      }
    }
    profile = null;
  }

  // -------------------------------------------------------------------------
  if (enabled('cancel')) {
    heading('Cancellation: time from abort() to the promise rejecting');
    results.cancel = { download: [], convert: [], recovery: [] };
    profile = PROFILES[1];
    for (let i = 0; i < 3; i += 1) {
      await freshEngine();
      const r = await run({ url: TS(), start: 0, end: 300 }, { abortAfterMs: 1000 });
      results.cancel.download.push({ ...r, data: undefined });
    }
    profile = null;
    for (let i = 0; i < 3; i += 1) {
      await freshEngine();
      const r = await run({ url: TS(), start: 0, end: 600 }, { abortAfterConvertingMs: 300 });
      results.cancel.convert.push(r);
      // The aborted conversion killed its worker; the next export starts a new one.
      const next = await run({ url: TS(), start: 0, end: 30 });
      results.cancel.recovery.push(next.totalMs);
    }
    await freshEngine();
    const warm = [];
    for (let i = 0; i < 3; i += 1) warm.push((await run({ url: TS(), start: 0, end: 30 })).totalMs);
    const d = results.cancel.download;
    const c = results.cancel.convert;
    results.cancel.summary = {
      downloadAbortMs: stats(d.map((r) => r.abortLatencyMs)),
      downloadAllAbort: d.every((r) => r.isAbort && r.phase === 'downloading'),
      convertAbortMs: stats(c.map((r) => r.abortLatencyMs)),
      convertAllAbort: c.every((r) => r.isAbort && r.phase === 'converting'),
      recoveryMs: stats(results.cancel.recovery),
      warmMs: stats(warm),
    };
    const s = results.cancel.summary;
    console.log(`  during download (typical broadband): ${s.downloadAbortMs.median.toFixed(1)} ms median (max ${s.downloadAbortMs.max.toFixed(1)} ms), AbortError: ${s.downloadAllAbort}`);
    console.log(`  during conversion (10-min clip):     ${s.convertAbortMs.median.toFixed(1)} ms median (max ${s.convertAbortMs.max.toFixed(1)} ms), AbortError: ${s.convertAllAbort}`);
    console.log(`  next 30 s export after a conversion abort: ${fmtMs(s.recoveryMs.median)} (vs ${fmtMs(s.warmMs.median)} with a warm worker)`);
  }

  // -------------------------------------------------------------------------
  if (enabled('aes')) {
    heading('AES-128 decryption (Web Crypto, 3 MB segments)');
    results.aes = {
      sequential: await bench(() => window.bench.aes({ parallel: 1 })),
      parallel6: await bench(() => window.bench.aes({ parallel: 6 })),
    };
    console.log(`  1 at a time: ${results.aes.sequential.mbPerSecond.toFixed(0)} MB/s   6 in parallel: ${results.aes.parallel6.mbPerSecond.toFixed(0)} MB/s`);
  }
} finally {
  fs.writeFileSync(path.join(outDir, 'browser.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await vite.close();
  mediaServer.close();
}
console.log(`\nResults written to ${path.relative(root, path.join(outDir, 'browser.json'))}`);
