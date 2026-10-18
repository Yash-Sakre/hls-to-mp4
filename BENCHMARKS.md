# Benchmarks

Measured performance of `hls-to-mp4` 0.1.0: how fast it exports, how much memory and network it uses, how accurate the cuts are, and how it behaves under load, failure and cancellation.

All numbers come from real exports in headless Chrome, run by the scripts in [`test/bench/`](test/bench/). Every accuracy output was checked with native `ffprobe`. Measured on 2026-10-18 on one machine (see [Test setup](#test-setup)), so treat them as a reference point rather than a guarantee.

## At a glance

| | Result |
| --- | --- |
| **Export speed** (local server, 720p 4 Mbps TS) | 10-minute clip in **5.6 s** (107× realtime); 1-minute clip in **0.73 s** |
| **Export speed on a network** (2-min clip, 100 Mbps broadband) | **7.0 s** in total. The download takes 5.9 s of that. |
| **Conversion throughput** (ffmpeg.wasm, stream copy) | **~58 MB/s** for MPEG-TS and **~31 MB/s** for fMP4, plus ~0.1 s per export. That is 7× (TS) to 16× (fMP4) slower than native ffmpeg. |
| **ffmpeg.wasm load** | **~130 ms** from a local server; **2.3–5.4 s** cold from jsDelivr; **0 ms** when the warm worker is reused |
| **Peak memory** | **About 4× the clip size** for TS and **5×** for fMP4. A 10-min / 295 MB clip peaks at +1.2 GB. |
| **Cut accuracy** | The clip always starts on the **keyframe at or before `start`**, within 54 ms. 45 of 45 random ranges were correct. |
| **A/V sync** | Worst offset **1 ms** on random ranges and **≤ 11 ms** across all e2e samples |
| **Fail-fast size guard** | An oversized range fails **after 4 segments** (26 ms locally, 1.6 s on broadband) instead of downloading up to `maxBytes` first |
| **Cancellation** | The promise rejects **0.2 ms** after `abort()`, whether it is downloading or converting |
| **Playlist parsing** | A 24-hour CCTV playlist (43,200 segments) parses in **99 ms**; picking a 1-hour range then takes **0.9 ms** |
| **Bundle size** | **9.6 KB** gzip for the library. The ffmpeg core is 30.7 MB raw, **8.9 MB** as served by jsDelivr (brotli). |
| **Correctness** | **32 / 32** e2e checks pass across TS, fMP4, AES-128, byte ranges, HEVC, separate audio, discontinuities and error paths |

## What is measured

| # | Aspect | Question it answers |
| --- | --- | --- |
| 1 | [Bundle and core size](#1-bundle-and-core-size) | How much does an app ship, and how much does the browser download? |
| 2 | [ffmpeg.wasm load time](#2-ffmpegwasm-load-time) | How long before the first conversion can start? |
| 3 | [Export speed by stream type](#3-export-speed-by-stream-type) | Does the playlist format change the cost? |
| 4 | [Scaling with clip length](#4-scaling-with-clip-length) | How do time and memory grow with longer clips? How does this compare with native ffmpeg? |
| 5 | [First export vs warm export](#5-first-export-vs-warm-export) | How much does the first export of a page cost? |
| 6 | [Network and `concurrency`](#6-network-and-concurrency) | How fast is it on real connections, and is the default concurrency right? |
| 7 | [Simultaneous exports](#7-simultaneous-exports) | What happens when several exports run at once? |
| 8 | [Memory](#8-memory) | How much RAM does an export peak at, and what stays allocated afterwards? |
| 9 | [Cut accuracy and A/V sync](#9-cut-accuracy-and-av-sync) | Does the clip start where it should, and does it stay in sync? |
| 10 | [Size guard (fail fast)](#10-size-guard-fail-fast) | How quickly is an oversized range rejected? |
| 11 | [Cancellation](#11-cancellation) | How quickly does `abort()` take effect, and what does recovering cost? |
| 12 | [AES-128 decryption](#12-aes-128-decryption) | Does decrypting segments slow exports down? |
| 13 | [Playlist parsing at scale](#13-playlist-parsing-at-scale) | Can it handle day- or week-long recording playlists? |
| 14 | [Correctness across formats](#14-correctness-across-formats) | Do all supported playlist features produce valid, playable MP4s? |

---

## Test setup

| | |
| --- | --- |
| CPU | AMD Ryzen 5 5600H (6 cores / 12 threads) |
| RAM | 15 GiB |
| OS | Linux 7.0.0 (Ubuntu) |
| Browser | Google Chrome 154.0.8037.57, headless, driven by Playwright |
| ffmpeg.wasm | `@ffmpeg/core` 0.12.10 (single-threaded build) |
| Native ffmpeg (for comparison) | 6.1.1 |
| Node.js | 24.16.0 |

**Test streams**

- **Long stream** (benchmarks 4–11): 20 minutes of 1280×720 25 fps H.264 at 4 Mbps with 128 kbps AAC. It has 6 s segments, 2 s GOPs and `EXT-X-PROGRAM-DATE-TIME` on every segment, in two copies: MPEG-TS (591 MB) and fMP4/CMAF (574 MB). Noise is added to the picture so the encoder actually reaches 4 Mbps, which keeps segment sizes close to real broadcast or CCTV content. Every even second has a white-flash frame and a beep, used to measure A/V sync.
- **Feature samples** (benchmarks 3 and 14): the 24 s, 640×360, ~0.6 Mbps streams from `npm run samples`, one per playlist feature.

**Method**

- Export timings are split at the first `onProgress` event with `phase: 'converting'`. **Download** is everything before that event: playlist fetches, segment downloads, decryption and assembling the Blobs. **Convert** is the ffmpeg.wasm remux plus reading the MP4 back out of the worker.
- Unless a section says otherwise, the ffmpeg core is preloaded, and each export in benchmarks 4 and 8 starts on a fresh, empty worker.
- **Memory** is the peak resident memory (RSS) of Chrome's whole process tree, sampled every 100 ms, minus the idle level just before the export.
- **Network conditions** come from a throttling HTTP/1.1 server built into the runner. It adds a time to first byte (TTFB), caps bandwidth per connection, and caps total bandwidth. It doesn't model packet loss or TCP slow start.
- Values are medians of 2–5 runs. Short exports vary by about ±20% from run to run.

---

## 1. Bundle and core size

| What | Raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `hls-to-mp4`, minified bundle | 23.3 KB | **9.6 KB** | 8.7 KB |
| `hls-to-mp4/react`, minified (React external) | 22.4 KB | 9.2 KB | 8.3 KB |
| Library source, unminified (`src/*.js`) | 53.9 KB | 17.1 KB | 15.0 KB |
| `ffmpeg-core.js` (loader) | 109.2 KB | 28.9 KB | 25.5 KB |
| `ffmpeg-core.wasm` | 30.7 MB | 9.8 MB | 6.9 MB |

- The library has no dependencies and is `sideEffects: false`. The React entry bundles the same export pipeline, so code shared with the main entry is included only once.
- The ffmpeg core is fetched at runtime and is not part of your bundle. jsDelivr serves it brotli-compressed (**8.9 MB** on the wire) as `application/wasm` with a one-year immutable cache, so Chrome compiles it while it streams in.
- If you self-host the core, serve it compressed. Uncompressed, it is 3.4× larger (30.7 MB vs 8.9 MB).

## 2. ffmpeg.wasm load time

The time `preloadFFmpeg()` takes to resolve, i.e. until the worker is ready to run ffmpeg.

| Scenario | Median | Range |
| --- | ---: | ---: |
| Cold: new browser context, core on a local server | **135 ms** | 132–157 ms |
| New worker, core already in the HTTP cache | 128 ms | |
| Reusing the idle warm worker | **0 ms** | |
| Cold: new browser context, default jsDelivr CDN | **4.1 s** | 2.3–5.4 s |

- Compiling the 30.7 MB core takes only about 130 ms, so a cold load is almost entirely **network transfer**. The CDN figure depends on the test machine's internet connection. For comparison, `curl` fetched the 8.9 MB file in 1.0 s on the same connection.
- After the first export, the worker is kept warm, and the next export skips loading entirely.

## 3. Export speed by stream type

Whole 24 s feature samples (≈1.8 MB each) on a local server, with the core preloaded. Median of 5 runs.

| Stream | Total | Download | Convert | In → out |
| --- | ---: | ---: | ---: | ---: |
| MPEG-TS, H.264 + AAC | 61 ms | 8 ms | 50 ms | 1.9 → 1.8 MB |
| fMP4 / CMAF | 222 ms | 8 ms | 214 ms | 1.8 → 1.8 MB |
| MP2 audio → AAC transcode | 165 ms | 8 ms | 157 ms | 2.2 → 1.8 MB |
| AES-128 encrypted TS | 58 ms | 15 ms | 44 ms | 1.9 → 1.8 MB |
| Byte-range segments (single file) | 54 ms | 8 ms | 46 ms | 1.9 → 1.8 MB |
| HEVC (tagged `hvc1`) | 59 ms | 8 ms | 51 ms | 1.9 → 1.8 MB |
| Master playlist, 2 variants (highest) | 70 ms | 11 ms | 57 ms | 2.5 → 2.3 MB |
| Separate audio rendition (fMP4) | 48 ms | 14 ms | 36 ms | 1.8 → 1.8 MB |
| Discontinuity (2 recordings joined) | 41 ms | 6 ms | 34 ms | 1.0 → 0.9 MB |
| Video only | 51 ms | 8 ms | 43 ms | 1.8 → 1.7 MB |

- Most formats cost about the same. Two are notably slower: **fMP4 with muxed audio and video** takes about 4× longer to convert than TS, and **audio transcoding** (MP2 → AAC) about 3× longer, because it is the only case that re-encodes anything.
- The MP4 is 3–6% smaller than the TS input, because TS packet overhead is dropped. For fMP4 the sizes are the same.

## 4. Scaling with clip length

720p 4 Mbps stream on a local server, with a fresh worker for each run. "Native ffmpeg" is the same `-c copy -movflags +faststart` remux done by native ffmpeg 6.1 from local disk.

| Clip | Downloaded | Total | Download | Convert | Speed | Native ffmpeg | Peak memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| TS, 30 s | 14.7 MB | 418 ms | 28 ms | 390 ms | 72× realtime | 101 ms | +101 MB |
| TS, 1 min | 29.5 MB | 728 ms | 45 ms | 676 ms | 82× | 141 ms | +170 MB |
| TS, 2 min | 59.0 MB | 1.23 s | 83 ms | 1.15 s | 97× | 199 ms | +236 MB |
| TS, 5 min | 148 MB | 2.89 s | 202 ms | 2.69 s | 104× | 408 ms | +649 MB |
| TS, 10 min | 295 MB | **5.60 s** | 409 ms | 5.19 s | **107×** | 739 ms | **+1.2 GB** |
| fMP4, 1 min | 28.7 MB | 1.04 s | 43 ms | 990 ms | 57× | 128 ms | +228 MB |
| fMP4, 5 min | 143 MB | 4.89 s | 211 ms | 4.67 s | 61× | 356 ms | +720 MB |
| fMP4, 10 min | 287 MB | **9.77 s** | 404 ms | 9.37 s | **61×** | 581 ms | **+1.5 GB** |

- **Time grows linearly** with clip size. Conversion costs a fixed **~0.1 s per export** plus **~58 MB/s for TS** and **~31 MB/s for fMP4**. On localhost the download is only about 7% of the total.
- Against native ffmpeg, the wasm conversion is **~7× slower for TS** and **~16× slower for fMP4**. Native ffmpeg is actually faster on fMP4 than on TS, so the fMP4 slowdown is specific to the wasm build. It probably comes from the MP4 demuxer making many small reads through the worker's Blob-backed filesystem; that cause hasn't been confirmed.
- **Memory grows at about 4× (TS) to 5× (fMP4) the clip size.** See [Memory](#8-memory).
- The full 20-minute export (~590 MB) was not run, because the test machine had only ~3.5 GB of RAM free. The rates above project it at about 11–12 s and a +2.4 GB peak. Run it with `node test/bench/run.mjs --only=scale --long`.

**Rule of thumb:** export time ≈ core load (first export only) + clip size ÷ your bandwidth + 0.1 s + clip size ÷ 58 MB/s (TS) or 31 MB/s (fMP4). For the 62 MB clip in section 6, this predicts 1.2 s of conversion; the measured figure was 1.1 s.

## 5. First export vs warm export

A fresh page with no `preloadFFmpeg()` call: the core loads in parallel with the segment download, and conversion waits for whichever finishes last.

| Clip | First export on the page | Warm worker | Cost of the first export |
| --- | ---: | ---: | ---: |
| TS, 30 s | 531 ms | 378 ms | +153 ms |
| TS, 5 min | 2.96 s | 2.85 s | +110 ms |

- From a local server the core loads in about 130 ms, so the first export costs little extra.
- **From the CDN, a cold core load takes 2.3–5.4 s** (section 2). That time is hidden only while the download is still running, so on a fast connection a short clip would wait seconds for the core. Calling `preloadFFmpeg()` when the export UI opens removes that wait.

## 6. Network and `concurrency`

Download phase of a 2-minute range (≈62 MB, 21 segments) through the throttling server. Chrome is limited to 6 connections per host on HTTP/1.1.

| `concurrency` | Fast — 20 ms TTFB, 50 Mbps/conn, 300 Mbps total | Typical — 50 ms, 20 Mbps/conn, 100 Mbps | Slow — 150 ms, 8 Mbps/conn, 30 Mbps |
| ---: | ---: | ---: | ---: |
| 1 | 10.3 s (48 Mbps) | 25.8 s (19 Mbps) | 65.0 s (8 Mbps) |
| 2 | 5.31 s (93 Mbps) | 13.2 s (37 Mbps) | 33.4 s (15 Mbps) |
| 4 | 2.81 s (176 Mbps) | 6.68 s (74 Mbps) | **17.8 s (28 Mbps)** |
| **6 (default)** | **2.29 s (217 Mbps)** | **5.89 s (84 Mbps)** | 18.4 s (27 Mbps) |
| 8 | 2.28 s (217 Mbps) | 5.89 s (84 Mbps) | 18.4 s (27 Mbps) |
| 12 | 2.29 s (216 Mbps) | 5.89 s (84 Mbps) | 18.4 s (27 Mbps) |

Total export time for the same clip at the default concurrency: **3.3 s** on fast, **7.0 s** on typical (17× realtime), and **19.5 s** on slow (6× realtime).

- On a real network, **the download dominates**: 69% of the total time on fast, 84% on typical and 94% on slow. Conversion adds about 1 s for this clip.
- Parallel downloads matter most when each connection is slow. Going from 1 to 6 connections makes the download **4.4–4.5×** faster on fast and typical connections, and 3.5× faster on slow ones.
- **Above 6 there is no gain**, because Chrome won't open more than 6 HTTP/1.1 connections to one host. On the slow profile, 4 connections already fill the total cap. The default of 6 is the right choice for HTTP/1.1.
- These tests didn't cover HTTP/2 or HTTP/3 servers, where more than 6 parallel requests might help.

## 7. Simultaneous exports

Several 1-minute TS exports started at the same moment in one page. Each export gets its own worker.

| Exports at once | All done in | Mean per export | Peak memory |
| ---: | ---: | ---: | ---: |
| 1 | 735 ms | 735 ms | +174 MB |
| 2 | 954 ms | 933 ms | +422 MB |
| 4 | 1.61 s | 1.49 s | +778 MB |

- Each worker runs on its own thread, so 4 parallel exports finish in **1.61 s**, against an estimated ~2.9 s one after another (**1.8×** the throughput).
- Memory adds up across the exports, so running several large exports at once multiplies the peak.

## 8. Memory

| Clip | Clip size | Peak (Chrome RSS above idle) | Peak ÷ clip size |
| --- | ---: | ---: | ---: |
| TS, 2 min | 59 MB | +236 MB | 4.0× |
| TS, 5 min | 148 MB | +649 MB | 4.4× |
| TS, 10 min | 295 MB | +1.2 GB | 4.1× |
| fMP4, 5 min | 143 MB | +720 MB | 5.0× |
| fMP4, 10 min | 287 MB | +1.5 GB | 5.3× |

- **Peak memory is about 4–5× the clip size.** The likely reason is that the clip exists in several copies at the peak: the downloaded segment Blobs, the MP4 being written inside the worker (its buffer grows ahead of the data), the copy read out of the worker, and the final output Blob. This breakdown hasn't been measured copy by copy.
- **This affects the default `maxBytes` (1 GiB).** At the measured ratio, a range near the limit would peak at roughly **4–5 GB of RAM**, which can crash a tab on an 8 GB machine. That figure is extrapolated, not measured. If your users have ordinary laptops, a lower `maxBytes` (e.g. 300–500 MB) is safer.
- **The idle warm worker keeps memory after a large export.** Shortly after a 10-minute export, **+558 MB** was still in use. Calling `disposeFFmpeg()` freed all of it straight away. Call it after large exports if the page stays open.
- The ffmpeg core's wasm memory is capped at 2 GiB. This cap is on ffmpeg's working memory. The output file is stored in the worker's JavaScript memory, so the cap doesn't directly limit the clip size.

## 9. Cut accuracy and A/V sync

45 exports of random ranges, 2–30 s long, at random start times across the 20-minute stream (fixed seed). Each output was checked with ffprobe. With 2 s GOPs, the cut should begin at the last keyframe at or before `start`, which is `start mod 2` seconds early.

| | MPEG-TS (30 ranges) | fMP4 (15 ranges) |
| --- | --- | --- |
| Failed exports | 0 | 0 |
| Starts this much before `start` | 0.09–1.94 s (median 1.06 s) | 0.39–1.73 s (median 1.23 s) |
| Largest deviation from the keyframe at or before `start` | **39 ms** | **54 ms** |
| First frame is a keyframe | 30 / 30 | 15 / 15 |
| Worst A/V offset (flash ↔ beep) | **1 ms** | **1 ms** |
| Frames that fail to decode | 0 | 0 |
| Export time per clip (median) | 352 ms | 451 ms |

- **The cut is keyframe-exact.** Clips always begin on the keyframe at or before `start`, so they never start late or on a broken frame. The remaining 39–54 ms is about one or two AAC audio frames (21 ms each).
- **The start can be early by up to one GOP.** That is the cost of not re-encoding. Streams with shorter GOPs cut closer to `start`.
- **The end of the clip is accurate.** The measured start offsets match the expected keyframe position, which only holds if each clip ends at `end`.
- A/V sync stays within 1 ms after cutting, for both TS and fMP4.

## 10. Size guard (fail fast)

Exporting the whole 20-minute stream (≈590 MB) with a `maxBytes` that is too small. After 4 media segments, the library estimates the final size from the bitrate so far, and rejects the export if the estimate is more than 1.25× the limit.

| Network | `maxBytes` | Result | Time to fail | Downloaded before failing |
| --- | ---: | --- | ---: | ---: |
| Local | 50 MB | `TOO_LARGE` | 26 ms | 4 of 200 segments (~12 MB) |
| Local | 200 MB | `TOO_LARGE` | 34 ms | 4 of 200 segments |
| Typical broadband | 50 MB | `TOO_LARGE` | **1.6 s** | 4 of 200 segments |
| Typical broadband | 200 MB | `TOO_LARGE` | **1.6 s** | 4 of 200 segments |

- The failure comes at the same point whatever the limit. Without the estimate, the export would only fail after downloading up to the limit: about **5 s** for 50 MB and **19 s** for 200 MB at the measured 84 Mbps, wasting that bandwidth.
- The progress events at the moment of failure show 3 segments (8.9 MB). The 4th segment's completion is what triggers the check.

## 11. Cancellation

| Scenario | `abort()` → promise rejects | Error |
| --- | ---: | --- |
| During download (5-min clip, typical broadband) | **0.2 ms** | `AbortError` (3 / 3) |
| During conversion (10-min clip) | **0.2 ms** | `AbortError` (3 / 3) |
| Next 30 s export after a conversion abort | 596 ms | (vs 462 ms with a warm worker) |

- Cancelling a download aborts every request still in flight. Cancelling a conversion terminates the ffmpeg worker, which is the only way to stop a running ffmpeg job.
- Because the worker is terminated, the next export starts a new one. With the core in the HTTP cache that costs about 130 ms.

## 12. AES-128 decryption

AES-128 decryption through the library's decryptor (Web Crypto, AES-CBC), on 3 MB segments.

| | Throughput |
| --- | ---: |
| One segment at a time | 240 MB/s |
| 6 segments in parallel | 288 MB/s |

That is about **12 ms per 6 s segment of 4 Mbps video**, or about 2 Gbps, far faster than any network the segments arrive over. The 24 s encrypted sample exported in 58 ms, against 61 ms unencrypted (section 3).

## 13. Playlist parsing at scale

Media playlists of 2 s segments with `EXT-X-PROGRAM-DATE-TIME` on every segment, the format CCTV and DVR recorders emit. Run in Node 24 (V8, the same engine as Chrome).

| Recording | Segments | Playlist | Parse | Select 1 h (wall clock) | Select 1 h (seconds) | `inspectHls` | Memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 hour | 1,800 | 0.1 MB | 3.4 ms | 0.04 ms | 0.03 ms | 4.1 ms | ~0.2 MB |
| 6 hours | 10,800 | 0.8 MB | 23 ms | 0.23 ms | 0.15 ms | 24 ms | ~1.2 MB |
| 24 hours | 43,200 | 3.3 MB | **99 ms** | **0.86 ms** | 0.54 ms | 101 ms | ~8 MB |
| 7 days | 302,400 | 23.4 MB | 767 ms | 7.2 ms | 4.4 ms | 921 ms | ~59 MB |

- Parsing scales linearly at about **2.3–2.5 µs per segment** and uses about 110–190 bytes of memory per segment.
- Once the playlist is parsed, picking the range is essentially free: under 1 ms for a 24-hour recording.
- A whole day of recording is no problem. A week-long playlist takes under a second to parse, but downloading the 23 MB playlist text will probably take longer than that.

## 14. Correctness across formats

`npm run test:e2e`: every case is exported in headless Chrome. Each output is checked with native ffprobe for duration and codecs, decoded in full to catch corrupt frames, and checked for A/V sync using the flash and beep markers. Selected cases are also played back in a `<video>` element.

**32 / 32 checks pass.**

| Area | Cases |
| --- | --- |
| Containers | MPEG-TS, fMP4/CMAF (`EXT-X-MAP`), byte-range segments (single file) |
| Codecs | H.264, HEVC (tagged `hvc1`), AAC copied, MP2 transcoded to AAC, video only, `audio: 'none'` |
| Playlists | Master playlist (highest and lowest variant), separate audio rendition, discontinuities, relative URLs |
| Ranges | Seconds, wall clock (`PROGRAM-DATE-TIME`), open-ended, `trim: false`, a range ending on a segment boundary, a range spanning a discontinuity |
| Encryption | AES-128 with the IV taken from the sequence number, and with an explicit IV |
| Concurrency | Two exports at the same time in one page |
| Failure modes | `TOO_LARGE`, `NETWORK` (404), `INVALID_RANGE` (reversed range, wall clock without program date-time), `INVALID_PLAYLIST`, abort during download, abort during conversion, a new export after an abort |

A/V sync is within **±1 ms** on every sample and **±11 ms** on the stream with a discontinuity (two separately encoded recordings joined end to end).

---

## What the numbers suggest

1. **On real connections the network is the bottleneck.** Conversion adds about 1 s per 50–60 MB of TS. The download usually takes several times longer.
2. **Call `preloadFFmpeg()` when the export UI opens.** With the default CDN this hides a 2–5 s cold load.
3. **Size `maxBytes` for your users' RAM.** An export peaks at about 4–5× the clip size, so the 1 GiB default implies a peak of several GB.
4. **Call `disposeFFmpeg()` after large exports** in pages that stay open. The warm worker otherwise keeps hundreds of MB.
5. **Keep `concurrency` at 6** for HTTP/1.1 origins. More connections don't help.
6. **fMP4 conversion has room to improve.** It is about half as fast as TS in wasm, with no such gap in native ffmpeg.

## Caveats

- One machine and one browser (Chrome 154 on Linux). Firefox and Safari were not measured, and ffmpeg.wasm performance varies between JS engines.
- Network conditions were simulated by a throttling HTTP/1.1 server (TTFB plus bandwidth caps), not by real-world connections.
- The test content is synthetic. Remux cost depends on bitrate and packet count, not on what the picture shows, so 4 Mbps synthetic content behaves like 4 Mbps real content.
- Memory is RSS summed over Chrome's process tree, so shared pages are counted more than once. Treat the memory figures as upper estimates.
- Figures beyond 10 minutes and near the 1 GiB limit are extrapolated, not measured.

## Reproducing

```sh
npm install
npm run samples                          # feature samples (needs native ffmpeg)
bash test/bench/make-bench-samples.sh    # 20-min benchmark streams: ~1.2 GB on disk, ~70 s to generate
npm run bench                            # Node benchmarks, then all browser benchmarks (~10 min)
```

Options for the browser runner:

```sh
node test/bench/run.mjs --only=scale,network   # run some sections: load, features, scale, cold,
                                               # network, concurrent, accuracy, guard, cancel, aes
node test/bench/run.mjs --long                 # also export the whole 20-min stream (~3 GB free RAM)
node test/bench/run.mjs --no-cdn               # skip the jsDelivr load test (offline)
```

Raw results are written to `test/bench/.out/node.json` and `test/bench/.out/browser.json`.

| File | Role |
| --- | --- |
| [`test/bench/node.mjs`](test/bench/node.mjs) | Parsing and range-selection timings, plus bundle and core sizes |
| [`test/bench/run.mjs`](test/bench/run.mjs) | Browser runner: Chrome, the throttling media server, memory sampling, ffprobe checks |
| [`test/bench/harness.js`](test/bench/harness.js) | In-page side: timed exports, cancellation, AES throughput |
| [`test/bench/make-bench-samples.sh`](test/bench/make-bench-samples.sh) | Generates the long TS and fMP4 benchmark streams |
