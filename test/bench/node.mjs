// Node-side benchmarks: playlist parsing and range selection at scale, and
// the size of what an app ships (the library) and loads (the ffmpeg core).
// Run with `node --expose-gc test/bench/node.mjs`; results are printed and
// written to test/bench/.out/node.json.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { rolldown } from 'rolldown';

import { inspectHls } from '../../src/inspect.js';
import { parseMediaPlaylist } from '../../src/playlist.js';
import { groupIntoParts, selectSegments, toRangeBound } from '../../src/select.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = path.join(root, 'test/bench/.out');
fs.mkdirSync(outDir, { recursive: true });

const T0 = Date.parse('2026-10-17T00:00:00Z');

// A recording-style media playlist: 2 s segments with a program date-time on
// every segment (what CCTV/DVR packagers emit).
const makePlaylist = (count, segDur = 2) => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${segDur}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < count; i += 1) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + i * segDur * 1000).toISOString()}`, `#EXTINF:${segDur.toFixed(6)},`, `seg${String(i).padStart(6, '0')}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
};

// Median of repeated runs (after one warm-up run).
const median = (fn, { minMs = 400, minRuns = 7 } = {}) => {
  fn();
  const times = [];
  const started = performance.now();
  while (times.length < minRuns || performance.now() - started < minMs) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
};

const medianAsync = async (fn, runs = 7) => {
  await fn();
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
};

const heapOf = (build) => {
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const kept = build();
  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  return { bytes: after - before, kept };
};

const ms = (n) => (n < 1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(1));

// ---------------------------------------------------------------------------
// Parsing and selection
// ---------------------------------------------------------------------------

const sizes = [
  { label: '1 h', count: 1_800 },
  { label: '6 h', count: 10_800 },
  { label: '24 h', count: 43_200 },
  { label: '7 days', count: 302_400 },
];

const parsing = [];
console.log('Playlist parsing and range selection (2 s segments, PDT on every segment)');
console.log('  duration   segments   text      parse      1 h wall-clock select   seconds select   group parts   inspectHls   heap/segment');
for (const { label, count } of sizes) {
  const text = makePlaylist(count);
  const parse = median(() => parseMediaPlaylist(text, 'https://cdn.example.com/rec/index.m3u8'));
  const media = parseMediaPlaylist(text, 'https://cdn.example.com/rec/index.m3u8');
  const mid = T0 + (count * 2 * 1000) / 2;
  const wallStart = toRangeBound(new Date(mid), 'start');
  const wallEnd = toRangeBound(new Date(mid + 3600_000), 'end');
  const selectWall = median(() => selectSegments(media.segments, wallStart, wallEnd));
  const selectSecs = median(() => selectSegments(media.segments, toRangeBound(count, 'start'), toRangeBound(count + 3600, 'end')));
  const selection = selectSegments(media.segments, wallStart, wallEnd);
  const group = median(() => groupIntoParts(selection.segments));
  const fakeFetch = async () => new Response(text);
  const inspect = await medianAsync(() => inspectHls('https://cdn.example.com/rec/index.m3u8', { fetch: fakeFetch }), count > 100_000 ? 3 : 7);
  const heap = heapOf(() => parseMediaPlaylist(text, 'https://cdn.example.com/rec/index.m3u8'));
  const row = {
    label,
    segments: count,
    textBytes: Buffer.byteLength(text),
    parseMs: parse,
    selectWallclockMs: selectWall,
    selectSecondsMs: selectSecs,
    groupPartsMs: group,
    inspectMs: inspect,
    heapBytesPerSegment: heap.bytes / count,
  };
  parsing.push(row);
  console.log(
    `  ${label.padEnd(9)}  ${String(count).padStart(8)}   ${(row.textBytes / 1024 / 1024).toFixed(1).padStart(5)} MB  ${ms(parse).padStart(7)} ms   ${ms(selectWall).padStart(9)} ms              ${ms(selectSecs).padStart(7)} ms       ${ms(group).padStart(6)} ms   ${ms(inspect).padStart(7)} ms   ${Math.round(row.heapBytesPerSegment)} B`,
  );
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

const compressed = (buf) => ({
  raw: buf.length,
  gzip: zlib.gzipSync(buf, { level: 9 }).length,
  brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});

const bundle = async (input, external = []) => {
  const build = await rolldown({ input: path.join(root, input), external, logLevel: 'silent' });
  const { output } = await build.generate({ format: 'esm', minify: true });
  await build.close();
  return Buffer.from(output[0].code);
};

const srcDir = path.join(root, 'src');
const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js') && f !== 'react.js');
const srcRaw = Buffer.concat(srcFiles.map((f) => fs.readFileSync(path.join(srcDir, f))));
const coreDir = path.join(root, 'node_modules/@ffmpeg/core/dist/esm');

const sizeRows = {
  'Library source (src/*.js except react.js, unminified)': compressed(srcRaw),
  'Library bundle (hls-to-mp4, minified)': compressed(await bundle('src/index.js')),
  'React hook bundle (hls-to-mp4/react, minified, react external)': compressed(await bundle('src/react.js', ['react'])),
  'ffmpeg-core.js (@ffmpeg/core loader)': compressed(fs.readFileSync(path.join(coreDir, 'ffmpeg-core.js'))),
  'ffmpeg-core.wasm (@ffmpeg/core)': compressed(fs.readFileSync(path.join(coreDir, 'ffmpeg-core.wasm'))),
};

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
console.log('\nSizes');
for (const [name, s] of Object.entries(sizeRows)) {
  console.log(`  ${name.padEnd(66)} raw ${kb(s.raw).padStart(8)}   gzip ${kb(s.gzip).padStart(8)}   brotli ${kb(s.brotli).padStart(8)}`);
}

fs.writeFileSync(path.join(outDir, 'node.json'), JSON.stringify({ node: process.version, parsing, sizes: sizeRows }, null, 2));
