// End-to-end tests: real exports in headless Chrome, outputs verified with
// native ffprobe. Requires ffmpeg/ffprobe and Google Chrome (or set
// CHROME_PATH). Run with `npm run test:e2e`; add `--cdn` to also test loading
// ffmpeg.wasm from the default CDN, and `--public` to export real public test
// streams (both need internet).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = path.join(root, 'test/e2e/.out');
const withCdn = process.argv.includes('--cdn');
const withPublic = process.argv.includes('--public');

if (!fs.existsSync(path.join(root, 'demo/public/samples/index.json'))) {
  execFileSync('bash', [path.join(root, 'scripts/make-samples.sh')], { stdio: 'inherit' });
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const ffprobe = (file) => {
  const json = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,codec_tag_string,width,height,start_time,duration',
      '-of', 'json', file,
    ]).toString(),
  );
  const video = json.streams.find((s) => s.codec_type === 'video') ?? null;
  const audio = json.streams.find((s) => s.codec_type === 'audio') ?? null;
  return { duration: Number(json.format.duration), video, audio, streams: json.streams.length };
};

// Decode every frame to catch corrupt output that still has valid headers.
const decodeErrors = (file) => {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return err.stderr?.toString().trim().split('\n').slice(-2).join(' ') || 'decode failed';
  }
};

// A/V sync: every sample has a one-frame white flash and a 1 kHz beep at each
// even second of its source. Returns flash-to-beep offsets in seconds.
const syncOffsets = (file) => {
  const flashes = [];
  const meta = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], {
    maxBuffer: 64 * 1024 * 1024,
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
    maxBuffer: 64 * 1024 * 1024,
  });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const onsets = [];
  let quiet = rate; // samples since the last loud one
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

const near = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;
const between = (actual, min, max) => actual >= min - 0.05 && actual <= max + 0.05;

const S = (id, file = 'index.m3u8') => `/samples/${id}/${file}`;

// Each case: options for exportHlsToMp4 (or a function of context), plus checks
// on the ffprobe result. GOP is 2 s and segments 4 s in every sample, so a
// trimmed start may snap back to the previous keyframe by up to 2 s.
const cases = [
  {
    name: 'TS, whole playlist',
    options: { url: S('ts') },
    playback: true,
    check: (p) => [near(p.duration, 24, 0.2), p.video?.codec_name === 'h264', p.audio?.codec_name === 'aac'],
  },
  {
    name: 'TS, seconds range 5–15 (trimmed)',
    options: { url: S('ts'), start: 5, end: 15 },
    check: (p) => [between(p.duration, 10, 12.2), !!p.audio],
  },
  {
    name: 'TS, seconds range 5–15, trim: false',
    options: { url: S('ts'), start: 5, end: 15, trim: false },
    check: (p) => [near(p.duration, 12, 0.2)],
  },
  {
    name: 'TS, wall-clock range (program date-time) +6 s … +18 s',
    options: ({ tsInfo }) => {
      const t0 = Date.parse(tsInfo.programDateTime.start);
      return { url: S('ts'), start: new Date(t0 + 6000).toISOString(), end: new Date(t0 + 18000).toISOString() };
    },
    check: (p) => [between(p.duration, 12, 12.4)],
  },
  {
    name: 'TS, open-ended range start 16',
    options: { url: S('ts'), start: 16 },
    check: (p) => [near(p.duration, 8, 0.2)],
  },
  {
    name: 'fMP4 (EXT-X-MAP), whole playlist',
    options: { url: S('fmp4') },
    playback: true,
    check: (p) => [near(p.duration, 24, 0.2), p.video?.codec_name === 'h264', p.audio?.codec_name === 'aac'],
  },
  {
    name: 'fMP4, seconds range 3–9',
    options: { url: S('fmp4'), start: 3, end: 9 },
    check: (p) => [between(p.duration, 6, 8.2)],
  },
  {
    name: 'MP2 audio → transcoded to AAC',
    options: { url: S('mp2') },
    playback: true,
    check: (p) => [near(p.duration, 24, 0.2), p.audio?.codec_name === 'aac'],
  },
  {
    name: 'AES-128, IV from sequence number',
    options: { url: S('aes') },
    check: (p) => [near(p.duration, 24, 0.2), !!p.video, !!p.audio],
  },
  {
    name: 'AES-128, explicit IV',
    options: { url: S('aes-iv') },
    check: (p) => [near(p.duration, 24, 0.2), !!p.video, !!p.audio],
  },
  {
    name: 'Byte-range segments',
    options: { url: S('byterange') },
    check: (p) => [near(p.duration, 24, 0.2), !!p.video, !!p.audio],
  },
  {
    name: 'Master playlist, highest variant',
    options: { url: S('multi', 'master.m3u8') },
    check: (p) => [p.video?.width === 640],
  },
  {
    name: 'Master playlist, lowest variant',
    options: { url: S('multi', 'master.m3u8'), variant: 'lowest' },
    check: (p) => [p.video?.width === 320],
  },
  {
    name: 'Separate audio rendition, whole',
    options: { url: S('altaudio', 'master.m3u8') },
    playback: true,
    check: (p) => [near(p.duration, 24, 0.25), !!p.video, p.audio?.codec_name === 'aac'],
  },
  {
    name: 'Separate audio rendition, range 5–15',
    options: { url: S('altaudio', 'master.m3u8'), start: 5, end: 15 },
    check: (p) => [between(p.duration, 10, 12.2), !!p.audio],
  },
  {
    name: 'Separate audio, range ends on a video segment boundary',
    options: { url: S('altaudio', 'master.m3u8'), start: 4, end: 12 },
    check: (p) => [near(p.duration, 8, 0.15), Number(p.audio.duration) <= Number(p.video.duration) + 0.1],
  },
  {
    name: 'Discontinuity, range 9–15 (spans both recordings)',
    options: { url: S('disc'), start: 9, end: 15 },
    check: (p) => [between(p.duration, 6, 8.2)],
  },
  {
    name: 'Discontinuity between recordings',
    options: { url: S('disc') },
    playback: true,
    check: (p) => [near(p.duration, 24, 0.3)],
  },
  {
    name: 'HEVC → hvc1 tag',
    options: { url: S('hevc') },
    check: (p) => [p.video?.codec_name === 'hevc', p.video?.codec_tag_string === 'hvc1', near(p.duration, 24, 0.2)],
  },
  {
    name: 'Video-only stream',
    options: { url: S('noaudio') },
    check: (p) => [!!p.video, p.audio === null, near(p.duration, 24, 0.2)],
  },
  {
    name: "audio: 'none' drops audio",
    options: { url: S('ts'), audio: 'none' },
    check: (p) => [!!p.video, p.audio === null],
  },
  {
    name: 'Relative URL resolves against the page',
    options: { url: '../../samples/fmp4/index.m3u8', start: 0, end: 4 },
    check: (p) => [near(p.duration, 4, 0.2)],
  },
  // Failure modes — these must reject with the right error.
  { name: 'maxBytes exceeded → TOO_LARGE', options: { url: S('ts'), maxBytes: 200_000 }, expectError: { code: 'TOO_LARGE' } },
  { name: 'Missing playlist → NETWORK 404', options: { url: S('nope') }, expectError: { code: 'NETWORK' } },
  { name: 'end before start → INVALID_RANGE', options: { url: S('ts'), start: 10, end: 5 }, expectError: { code: 'INVALID_RANGE' } },
  {
    name: 'Wall-clock range on playlist without PDT → INVALID_RANGE',
    options: { url: S('fmp4'), start: '2026-01-01T00:00:00Z' },
    expectError: { code: 'INVALID_RANGE' },
  },
  { name: 'Not a playlist → INVALID_PLAYLIST', options: { url: '/samples/index.json' }, expectError: { code: 'INVALID_PLAYLIST' } },
  { name: 'Abort during download → AbortError', options: { url: S('hevc'), concurrency: 1 }, run: { abortAfterMs: 30 }, expectError: { abort: true } },
  { name: 'Abort during conversion → AbortError', options: { url: S('mp2') }, run: { abortAfterMs: 'converting' }, expectError: { abort: true } },
  { name: 'Export works again after an abort', options: { url: S('ts'), start: 0, end: 4 }, check: (p) => [near(p.duration, 4, 0.2)] },
];

if (withCdn) {
  cases.push({ name: 'Default CDN ffmpeg core', options: { url: S('ts'), start: 0, end: 8 }, run: { useCdn: true }, check: (p) => [near(p.duration, 8, 0.2)] });
}

if (withPublic) {
  const apple = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';
  const mux = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  cases.push(
    {
      name: 'Public: Apple fMP4, byte ranges + separate audio, 10–30',
      options: { url: apple, variant: 'lowest', start: 10, end: 30 },
      check: (p) => [between(p.duration, 20, 22.2), Number(p.audio.duration) <= Number(p.video.duration) + 0.1],
    },
    {
      name: 'Public: Apple fMP4, 10–30, trim: false',
      options: { url: apple, variant: 'lowest', start: 10, end: 30, trim: false },
      check: (p) => [near(p.duration, 24, 0.2), Number(p.audio.duration) <= Number(p.video.duration) + 0.1],
    },
    {
      name: 'Public: Mux Big Buck Bunny TS, 60–75',
      options: { url: mux, variant: 'lowest', start: 60, end: 75 },
      check: (p) => [between(p.duration, 15, 25.2), !!p.audio],
    },
  );
}

const server = await createServer({
  root,
  configFile: false,
  publicDir: path.join(root, 'demo/public'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 47123 },
});
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
await page.goto(`${base}test/e2e/harness.html`);
await page.waitForFunction(() => window.harness);

const results = {};
let failed = 0;
const line = (status, name, detail) => console.log(`${status} ${name.padEnd(62)} ${detail}`);

try {
  const context = {
    results,
    tsInfo: await page.evaluate((url) => window.harness.inspect(url), S('ts')),
    altInfo: await page.evaluate((url) => window.harness.inspect(url), S('altaudio', 'master.m3u8')),
  };
  const inspectOk = context.tsInfo.programDateTime && context.tsInfo.segmentCount === 6 && context.altInfo.separateAudio === true;
  line(inspectOk ? '✔' : '✘', 'inspectHls: segments, program date-time, separate audio', JSON.stringify({ seg: context.tsInfo.segmentCount, separateAudio: context.altInfo.separateAudio }));
  if (!inspectOk) failed += 1;

  // Two exports at once must not interfere (each gets its own worker).
  const [a, b] = await page.evaluate(
    ([u1, u2]) => Promise.all([window.harness.run({ url: u1 }), window.harness.run({ url: u2 })]),
    [S('ts'), S('fmp4')],
  );
  const concurrentOk = a.ok && b.ok;
  line(concurrentOk ? '✔' : '✘', 'Two concurrent exports', concurrentOk ? `${a.ms} ms / ${b.ms} ms` : `${a.message} | ${b.message}`);
  if (!concurrentOk) failed += 1;

  for (const testCase of cases) {
    const options = typeof testCase.options === 'function' ? testCase.options(context) : testCase.options;
    const runOptions = { ...testCase.run, checkPlayback: !!testCase.playback };
    let result;
    if (runOptions.abortAfterMs === 'converting') {
      // Abort as soon as the conversion phase starts.
      result = await page.evaluate(async (opts) => {
        const controller = new AbortController();
        const lib = await import('/src/index.js');
        try {
          await lib.exportHlsToMp4({
            ...opts,
            ffmpeg: window.harness.localFFmpeg,
            signal: controller.signal,
            onProgress: (p) => p.phase === 'converting' && controller.abort(),
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, isAbort: lib.isAbortError(err), message: err.message };
        }
      }, options);
    } else {
      result = await page.evaluate(([opts, run]) => window.harness.run(opts, run), [options, runOptions]);
    }

    if (testCase.expectError) {
      const { code, abort } = testCase.expectError;
      const pass = !result.ok && (abort ? result.isAbort : result.code === code);
      line(pass ? '✔' : '✘', testCase.name, result.ok ? 'unexpectedly succeeded' : `${result.code ?? result.name}: ${result.message.slice(0, 70)}`);
      if (!pass) failed += 1;
      continue;
    }
    if (!result.ok) {
      line('✘', testCase.name, `${result.code ?? result.name}: ${result.message}`);
      failed += 1;
      continue;
    }

    const file = path.join(outDir, `${testCase.name.replace(/[^\w]+/g, '_').slice(0, 60)}.mp4`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    const probe = ffprobe(file);
    results[testCase.name] = { probe };
    const checks = testCase.check(probe, context);
    const decodeError = decodeErrors(file);
    // Only the local samples carry flash/beep sync markers.
    const hasMarkers = typeof options.url === 'string' && !/^https?:/.test(options.url);
    const offsets = hasMarkers && probe.video && probe.audio ? syncOffsets(file) : null;
    const worstOffset = offsets?.length ? Math.max(...offsets.map(Math.abs)) : null;
    const syncOk = offsets === null || (offsets.length > 0 && worstOffset <= 0.045);
    // A cut must start on a video keyframe together with the audio — not with
    // audio over a missing picture.
    const videoLead = probe.video && probe.audio ? Number(probe.video.start_time) - Number(probe.audio.start_time) : 0;
    checks.push(syncOk, videoLead <= 0.1);
    const progressOk = result.progress.monotonic && result.progress.phases.join() === 'downloading,converting' && result.progress.finalRatio === 1;
    const playbackOk = !testCase.playback || result.playback?.ok;
    const pass = checks.every(Boolean) && !decodeError && progressOk && playbackOk;
    if (!pass) failed += 1;
    const detail = [
      `${probe.duration.toFixed(2)}s`,
      probe.video ? `${probe.video.codec_name}/${probe.video.codec_tag_string} ${probe.video.width}x${probe.video.height}` : 'no video',
      probe.audio ? probe.audio.codec_name : 'no audio',
      `${(result.size / 1024).toFixed(0)} KB`,
      `${result.ms} ms`,
      worstOffset !== null ? `A/V ±${Math.round(worstOffset * 1000)}ms` : offsets ? 'A/V: no markers' : null,
      Math.abs(videoLead) > 0.05 ? `video starts +${videoLead.toFixed(2)}s` : null,
      testCase.playback ? `play:${result.playback?.ok ? 'ok' : result.playback?.error}` : null,
      !progressOk ? `progress:${JSON.stringify(result.progress)}` : null,
      decodeError ? `decode:${decodeError}` : null,
      !checks.every(Boolean) ? `checks:${JSON.stringify(checks)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    line(pass ? '✔' : '✘', testCase.name, detail);
  }
} finally {
  await browser.close();
  await server.close();
}

if (pageErrors.length) {
  console.log(`\nUncaught page errors:\n  ${pageErrors.join('\n  ')}`);
  failed += 1;
}
console.log(failed ? `\n${failed} e2e check(s) failed` : '\nAll e2e checks passed');
process.exit(failed ? 1 : 0);
