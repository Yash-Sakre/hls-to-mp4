# hls-to-mp4

Download an HLS stream — or any time range of it — as a single MP4, **entirely in the browser**. Segments are fetched in parallel and remuxed with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm): no server, no upload, and the video is never re-encoded.

```js
import { downloadHlsAsMp4 } from 'hls-to-mp4';

await downloadHlsAsMp4({
  url: 'https://example.com/vod/master.m3u8',
  start: 30, // seconds from the start of the playlist…
  end: 90, //   …or Date objects for wall-clock times
  fileName: 'clip.mp4',
});
```

- **Time ranges** in seconds, or in wall-clock time via `EXT-X-PROGRAM-DATE-TIME` — only the segments you need are downloaded, then cut at the keyframe before `start`.
- **Lossless and fast:** video is stream-copied. Audio is copied too, or transcoded to AAC when MP4 can't carry it (G.711, MP2, …).
- **Handles real-world playlists:** MPEG-TS and fMP4/CMAF, master playlists, separate audio renditions, byte-range segments, discontinuities, `EXT-X-GAP`, and clear-key AES-128 encryption. HEVC is tagged `hvc1` so it plays on Apple devices.
- **No bundler configuration:** ffmpeg runs in an inline worker and loads its core by URL — from a CDN by default, or self-hosted.
- **Production details:** progress, cancellation, retries with backoff, a size guard that fails fast, custom fetch/headers, a React hook and TypeScript types.

## Install

```sh
npm install hls-to-mp4
```

By default the ffmpeg core (~31 MB, ~10 MB compressed) is loaded from jsDelivr the first time an export runs. To serve it yourself — for offline or air-gapped deployments — also install `@ffmpeg/core` and see [Loading ffmpeg.wasm](#loading-ffmpegwasm).

## Usage

### Export to a Blob

```js
import { exportHlsToMp4 } from 'hls-to-mp4';

const controller = new AbortController();
const blob = await exportHlsToMp4({
  url: 'https://example.com/vod/index.m3u8',
  start: 120,
  end: 180,
  signal: controller.signal,
  onProgress: ({ phase, ratio }) => console.log(phase, Math.round(ratio * 100) + '%'),
});

video.src = URL.createObjectURL(blob); // or upload it, store it, hand it to saveBlob()
```

### Wall-clock ranges

When the playlist has `EXT-X-PROGRAM-DATE-TIME` tags (recordings, DVR, CCTV), pass real times. A `Date`, an ISO string, or any object whose `valueOf()` is epoch milliseconds (dayjs, moment, Luxon) works:

```js
await downloadHlsAsMp4({
  url: recordingPlaylistUrl,
  start: new Date('2026-10-17T10:00:00+05:30'),
  end: dayjs('2026-10-17T10:05:00+05:30'),
  fileName: 'gate-camera-10-00.mp4',
});
```

Numbers are always seconds from the start of the playlist. If you pass epoch seconds by mistake, the export fails with a `NO_SEGMENTS` error that says so.

### Inspect a playlist first

```js
import { inspectHls } from 'hls-to-mp4';

const info = await inspectHls(url);
info.duration; // seconds
info.programDateTime; // { start: Date, end: Date } | null
info.variants; // [{ url, bandwidth, resolution, codecs, … }]
info.exportable; // false for DRM / SAMPLE-AES streams
```

### React

```jsx
import { useHlsToMp4 } from 'hls-to-mp4/react';

function DownloadButton({ url, start, end }) {
  const { downloadMp4, cancel, progress, isRunning } = useHlsToMp4();

  if (isRunning) {
    return (
      <button onClick={cancel}>
        {progress.phase === 'downloading' ? 'Downloading' : 'Building MP4'} {Math.round(progress.ratio * 100)}% — cancel
      </button>
    );
  }
  return (
    <button onClick={() => downloadMp4({ url, start, end, fileName: 'clip.mp4' }).catch(console.error)}>
      Download MP4
    </button>
  );
}
```

The hook runs one export at a time and cancels it when the component unmounts. `exportMp4` / `downloadMp4` reject with an `AbortError` when cancelled; check for it with `isAbortError(err)`.

## Loading ffmpeg.wasm

The core is loaded once per page, on the first export or when you call `preloadFFmpeg()`, and then reused.

| Option | How |
| --- | --- |
| **CDN (default)** | Nothing to do. `@ffmpeg/core@0.12.10` is loaded from jsDelivr. |
| **Vite** | `import coreURL from '@ffmpeg/core?url'` and `import wasmURL from '@ffmpeg/core/wasm?url'`, then pass `ffmpeg: { coreURL, wasmURL }`. |
| **Any bundler / static hosting** | Copy `node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.{js,wasm}` into your public folder and pass `ffmpeg: { coreURL: '/ffmpeg/ffmpeg-core.js' }` (the `.wasm` next to it is found automatically). |

```js
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { exportHlsToMp4, preloadFFmpeg } from 'hls-to-mp4';

const ffmpeg = { coreURL, wasmURL };
preloadFFmpeg(ffmpeg); // optional: warm up when the export UI opens
const blob = await exportHlsToMp4({ url, ffmpeg });
```

Serve `ffmpeg-core.wasm` with `Content-Type: application/wasm` (so it compiles while it downloads) and with compression. nginx's default `gzip_types` doesn't include wasm.

**Content-Security-Policy:** the worker is created from a `blob:` URL and compiles WebAssembly, so it needs `worker-src blob:` and `script-src 'wasm-unsafe-eval'`. The origin you load the core from also has to be allowed in `script-src` and `connect-src`.

## API

### `exportHlsToMp4(options): Promise<Blob>`

| Option | Default | |
| --- | --- | --- |
| `url` | — | Master or media playlist URL. Absolute, or relative to the page. |
| `start`, `end` | whole stream | Seconds from the start of the playlist (`number`), or wall-clock times (`Date` / ISO string / dayjs…). Either one may be omitted. |
| `trim` | `true` | Cut to `start`/`end`. With `false`, every overlapping segment is exported whole. |
| `variant` | `'highest'` | `'highest'` or `'lowest'` bandwidth, or `(variants) => variant`. |
| `audio` | `'auto'` | `'auto'` keeps audio, transcoding it to AAC if needed. `'none'` drops it. |
| `maxBytes` | 1 GiB | Fail with `TOO_LARGE` beyond this size. After 4 segments the final size is projected from the bitrate, so oversized ranges fail early. |
| `concurrency` | `6` | Parallel segment downloads. |
| `retries` | `2` | Extra attempts for network errors and 408/425/429/5xx responses, with backoff. |
| `fetch` | `globalThis.fetch` | Custom fetch: sign URLs, add tokens, route through a proxy. |
| `fetchOptions` | `{}` | `RequestInit` merged into every request: `headers`, `credentials`, `mode`, … |
| `ffmpeg` | jsDelivr | `{ coreURL, wasmURL }` of `@ffmpeg/core`'s ESM build. |
| `signal` | — | `AbortSignal`. Cancels downloads and conversion; the promise rejects with an `AbortError`. |
| `onProgress` | — | `({ phase: 'downloading' \| 'converting', ratio, segmentsDone, segmentsTotal, bytesDownloaded }) => void` |
| `onLog` | — | ffmpeg's log output, line by line, including the exact command it ran. |

The Blob's type is `video/mp4`, or `audio/mp4` for audio-only streams. The MP4 is "fast start": the index comes first, so it plays while it loads.

### `downloadHlsAsMp4(options): Promise<{ blob, fileName }>`

The same as `exportHlsToMp4`, then saves the file. It also takes `fileName` (default `'video.mp4'`).

### `inspectHls(url, options?): Promise<HlsInfo>`

Fetches the playlists without downloading media. `options` takes `variant`, `fetch`, `fetchOptions`, `retries` and `signal`. The result includes `duration`, `segmentCount`, `variants`, `variant`, `audioRenditions`, `separateAudio`, `container` (`'ts' | 'fmp4'`), `encryption`, `exportable`, `byteRange`, `discontinuities`, `live` and `programDateTime`.

### Other exports

- `preloadFFmpeg(ffmpegConfig?)` loads the core ahead of time.
- `disposeFFmpeg()` terminates the idle worker kept for reuse.
- `saveBlob(blob, fileName)` triggers a browser download.
- `isAbortError(err)` tells you whether an export was cancelled.
- `DEFAULT_MAX_BYTES`, `FFMPEG_CORE_VERSION`, `DEFAULT_FFMPEG_CORE_URL` and `DEFAULT_FFMPEG_WASM_URL` are the defaults.

### Errors

Failures reject with an `HlsToMp4Error` that has a `code` property:

| `code` | When | Extra fields |
| --- | --- | --- |
| `INVALID_PLAYLIST` | The response isn't an HLS playlist, or the playlist is malformed. | `url` |
| `UNSUPPORTED` | DRM / SAMPLE-AES, or AES-128 outside a secure context. | |
| `INVALID_RANGE` | `start`/`end` are invalid or reversed, or they mix seconds with wall-clock times, or a wall-clock range is used without program date-time. | |
| `NO_SEGMENTS` | Nothing in the playlist falls inside the range. | |
| `NETWORK` | A request failed after all retries, or a byte range came back short. | `url`, `status` |
| `TOO_LARGE` | The export exceeds `maxBytes`. | `bytes`, `limit` |
| `DECRYPTION` | An AES-128 segment couldn't be decrypted (wrong key or IV). | |
| `FFMPEG_LOAD` | ffmpeg.wasm couldn't be loaded (blocked by CSP or the network). | |
| `CONVERSION` | ffmpeg failed to build the MP4. | `exitCode`, `log` |

```js
import { ErrorCode, HlsToMp4Error, isAbortError } from 'hls-to-mp4';

try {
  await downloadHlsAsMp4({ url, start, end });
} catch (err) {
  if (isAbortError(err)) return; // the user cancelled
  if (err instanceof HlsToMp4Error && err.code === ErrorCode.TOO_LARGE) showMessage('Choose a shorter range');
  else throw err;
}
```

## How ranges are cut

Video is never re-encoded, so a cut has to begin on a keyframe:

- The export **starts at the last keyframe at or before `start`**. It can begin up to one GOP early, but it never starts late or on a broken frame. It **ends at `end`**.
- **MPEG-TS** is cut on the bytes at that keyframe. ffmpeg's own TS seeking isn't keyframe-accurate with stream copy. **fMP4** is seeked by ffmpeg, which lands exactly on the keyframe.
- **Separate audio renditions** are aligned to the video using their shared media timeline, and end where the video ends.
- **Discontinuities** (recorder restarts, ad breaks, joined recordings) are stitched together back to back, and gaps are collapsed. When a range starts in fMP4 content and spans a discontinuity, the cut snaps to the start of the first segment.

## Requirements and limits

- **Browsers:** module workers + WebAssembly — Chrome/Edge 80+, Firefox 114+, Safari 15+.
- **CORS:** the playlist, segment and key URLs must allow your origin. Use `fetchOptions` or a custom `fetch` for credentials or tokens.
- **Memory:** ffmpeg.wasm builds the whole MP4 in memory, so exports are capped at `maxBytes` (1 GiB by default). That is roughly 30 minutes at 4 Mbps. Raise the cap with care.
- **The tab must stay open** while exporting.
- **Live playlists** export the segments listed at the moment of the request.
- **Not supported:** DRM (FairPlay / Widevine / PlayReady) and SAMPLE-AES. AES-128 needs a secure context (HTTPS or localhost) for Web Crypto.

## Recipes

**Auth headers or cookies**

```js
exportHlsToMp4({ url, fetchOptions: { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' } });
```

**Signed URLs**

```js
exportHlsToMp4({ url, fetch: (input, init) => fetch(signUrl(input), init) });
```

**Prefer 720p**

```js
exportHlsToMp4({
  url,
  variant: (variants) =>
    variants.filter((v) => (v.resolution?.height ?? 0) <= 720).sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? variants[0],
});
```

**Servers that window recordings by URL.** Some servers expose a playlist per time window, such as MediaMTX-style `…/start/<from>/end/<to>/index.m3u8`. Build that URL and export it whole:

```js
const pad = (n) => String(n).padStart(2, '0');
const local = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
await downloadHlsAsMp4({ url: `${base}/vod/camera/${id}/start/${local(from)}/end/${local(to)}/index.m3u8` });
```

## How it works

1. Fetch the playlist. For a master playlist, also fetch the chosen variant and its separate audio rendition.
2. Select the segments that overlap the range.
3. Download them with bounded concurrency, retrying failures, verifying byte ranges, and decrypting AES-128 with Web Crypto.
4. Group them into contiguous parts: init section plus segments, split at discontinuities.
5. Mount the Blobs into ffmpeg.wasm through WORKERFS. They are read lazily rather than copied into the wasm heap.
6. Probe the codecs, find the cut keyframe, and run a single stream-copy remux to a fast-start MP4.

## Development

```sh
npm install
npm test               # unit tests (node:test)
npm run typecheck      # check the published .d.ts files
npm run samples        # generate local HLS test streams (needs native ffmpeg)
npm run demo           # demo page at http://localhost:5173
npm run test:e2e       # real exports in headless Chrome, verified with ffprobe
npm run test:e2e -- --public --cdn   # also export public streams / load the CDN core
```

The end-to-end suite exports every sample in headless Chrome and checks each MP4 with native `ffprobe`. It checks durations, codecs, A/V sync (each sample carries a flash and a beep every two seconds), that the video starts with the audio, and that the whole file decodes without errors.

## License

MIT. ffmpeg.wasm's core (`@ffmpeg/core`) is GPL-2.0-or-later. This package doesn't include it: it's fetched at runtime from the CDN, or served by you. If you self-host or redistribute it, its license applies to that distribution.
