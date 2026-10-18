import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { DEFAULT_MAX_BYTES, inspectHls, isAbortError, preloadFFmpeg, saveBlob } from 'hls-to-mp4';
import { useHlsToMp4 } from 'hls-to-mp4/react';

import { Badge, Card, CodeBlock, Facts, Field, ProgressBar, Segmented } from './components.jsx';
import { formatBytes, formatClock, formatDuration, toLocalInput } from './format.js';

// The demo serves @ffmpeg/core itself, so it works offline. Choose "CDN" to
// try the package default (jsDelivr) instead.
const LOCAL_FFMPEG = { coreURL, wasmURL };

const PUBLIC_STREAMS = [
  { id: 'mux-bbb', label: 'Big Buck Bunny · TS · multi-bitrate (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  {
    id: 'apple-fmp4',
    label: 'Apple bipbop · fMP4 · separate audio',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  },
];

const MAX_LOG_LINES = 400;

const variantLabel = (v) =>
  [v.resolution ? `${v.resolution.width}×${v.resolution.height}` : null, v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : null, v.codecs]
    .filter(Boolean)
    .join(' · ');

const loadTheme = () => {
  try {
    return localStorage.getItem('hls-to-mp4-demo-theme');
  } catch {
    return null;
  }
};

export default function App() {
  const [theme, setTheme] = useState(loadTheme);
  const [samples, setSamples] = useState([]);
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState(null);

  const [rangeMode, setRangeMode] = useState('whole');
  const [startSec, setStartSec] = useState('0');
  const [endSec, setEndSec] = useState('30');
  const [startWall, setStartWall] = useState('');
  const [endWall, setEndWall] = useState('');
  const [variant, setVariant] = useState('highest');
  const [audio, setAudio] = useState('auto');
  const [trim, setTrim] = useState(true);
  const [coreSource, setCoreSource] = useState('local');
  const [maxMb, setMaxMb] = useState(String(DEFAULT_MAX_BYTES / 1024 ** 2));
  const [concurrency, setConcurrency] = useState('6');
  const [fileName, setFileName] = useState('clip.mp4');

  const [engine, setEngine] = useState('loading');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const logBuffer = useRef([]);
  const startedAt = useRef(0);

  const { exportMp4, cancel, progress, isRunning } = useHlsToMp4();

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem('hls-to-mp4-demo-theme', theme);
      else localStorage.removeItem('hls-to-mp4-demo-theme');
    } catch {
      // Storage unavailable (private mode): the toggle still works for this visit.
    }
  }, [theme]);

  // Local samples exist after `npm run samples`.
  useEffect(() => {
    fetch('samples/index.json')
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        setSamples(list);
        if (list.length) setUrl((current) => current || new URL(list[0].url, location.href).href);
      })
      .catch(() => setSamples([]));
  }, []);

  useEffect(() => {
    setEngine('loading');
    preloadFFmpeg(coreSource === 'local' ? LOCAL_FFMPEG : undefined).then(
      () => setEngine('ready'),
      () => setEngine('error'),
    );
  }, [coreSource]);

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => setElapsed(performance.now() - startedAt.current), 100);
    return () => clearInterval(timer);
  }, [isRunning]);

  // Revoke the preview URL when it is replaced or the page goes away.
  const objectUrl = result?.objectUrl;
  useEffect(() => () => objectUrl && URL.revokeObjectURL(objectUrl), [objectUrl]);

  const inspect = useCallback(
    async (target = url) => {
      if (!target) return;
      setInspecting(true);
      setInspectError(null);
      setInfo(null);
      try {
        const next = await inspectHls(target);
        setInfo(next);
        setVariant('highest');
        const span = Math.min(30, Math.floor(next.duration));
        setStartSec('0');
        setEndSec(String(span || 10));
        if (next.programDateTime) {
          const start = next.programDateTime.start;
          setStartWall(toLocalInput(start));
          setEndWall(toLocalInput(new Date(start.getTime() + (span || 10) * 1000)));
        } else if (rangeMode === 'wallclock') {
          setRangeMode('seconds');
        }
      } catch (err) {
        setInspectError(err);
      } finally {
        setInspecting(false);
      }
    },
    [url, rangeMode],
  );

  const pickPreset = (presetUrl) => {
    const absolute = new URL(presetUrl, location.href).href;
    setUrl(absolute);
    inspect(absolute);
  };

  const options = useMemo(() => {
    const opts = { url };
    if (rangeMode === 'seconds') {
      if (startSec !== '') opts.start = Number(startSec);
      if (endSec !== '') opts.end = Number(endSec);
    } else if (rangeMode === 'wallclock') {
      if (startWall) opts.start = new Date(startWall);
      if (endWall) opts.end = new Date(endWall);
    }
    if (rangeMode !== 'whole' && !trim) opts.trim = false;
    if (variant === 'lowest') opts.variant = 'lowest';
    else if (variant !== 'highest' && info?.variants[Number(variant)]) {
      const chosen = info.variants[Number(variant)];
      opts.variant = (variants) => variants.find((v) => v.url === chosen.url) ?? variants[0];
      opts.variantLabel = variantLabel(chosen);
    }
    if (audio === 'none') opts.audio = 'none';
    const maxBytes = Number(maxMb) * 1024 ** 2;
    if (Number.isFinite(maxBytes) && maxBytes > 0 && maxBytes !== DEFAULT_MAX_BYTES) opts.maxBytes = maxBytes;
    const parallel = Number(concurrency);
    if (Number.isInteger(parallel) && parallel > 0 && parallel !== 6) opts.concurrency = parallel;
    return opts;
  }, [url, rangeMode, startSec, endSec, startWall, endWall, trim, variant, info, audio, maxMb, concurrency]);

  const code = useMemo(() => {
    const lines = [`  url: ${JSON.stringify(options.url || 'https://example.com/stream.m3u8')},`];
    const time = (value) => (value instanceof Date ? `new Date(${JSON.stringify(value.toISOString())})` : String(value));
    if (options.start !== undefined) lines.push(`  start: ${time(options.start)},`);
    if (options.end !== undefined) lines.push(`  end: ${time(options.end)},`);
    if (options.trim === false) lines.push('  trim: false,');
    if (typeof options.variant === 'string') lines.push(`  variant: '${options.variant}',`);
    if (typeof options.variant === 'function') lines.push(`  variant: (variants) => /* ${options.variantLabel} */ variants[0],`);
    if (options.audio) lines.push(`  audio: '${options.audio}',`);
    if (options.maxBytes) lines.push(`  maxBytes: ${options.maxBytes},`);
    if (options.concurrency) lines.push(`  concurrency: ${options.concurrency},`);
    if (coreSource === 'local') lines.push('  ffmpeg: { coreURL, wasmURL }, // self-hosted @ffmpeg/core');
    lines.push(`  fileName: ${JSON.stringify(fileName || 'video.mp4')},`);
    lines.push('  onProgress: ({ phase, ratio }) => console.log(phase, ratio),');
    const imports = ["import { downloadHlsAsMp4 } from 'hls-to-mp4';"];
    if (coreSource === 'local') {
      imports.push("import coreURL from '@ffmpeg/core?url';", "import wasmURL from '@ffmpeg/core/wasm?url';");
    }
    return `${imports.join('\n')}\n\nawait downloadHlsAsMp4({\n${lines.join('\n')}\n});`;
  }, [options, coreSource, fileName]);

  const flushLogs = () => setLogs(logBuffer.current.slice(-MAX_LOG_LINES));

  const run = async () => {
    setError(null);
    setResult(null);
    logBuffer.current = [];
    setLogs([]);
    startedAt.current = performance.now();
    setElapsed(0);
    const { variantLabel: _label, ...exportOptions } = options;
    try {
      const blob = await exportMp4({
        ...exportOptions,
        ffmpeg: coreSource === 'local' ? LOCAL_FFMPEG : undefined,
        onLog: (line) => logBuffer.current.push(line),
      });
      if (blob) {
        setResult({ blob, objectUrl: URL.createObjectURL(blob), ms: performance.now() - startedAt.current, duration: null });
        setEngine('ready');
      }
    } catch (err) {
      setError(isAbortError(err) ? { cancelled: true } : err);
    } finally {
      flushLogs();
    }
  };

  const save = () => {
    const name = /\.(mp4|m4a)$/i.test(fileName) ? fileName : `${fileName || 'video'}.mp4`;
    saveBlob(result.blob, name);
  };

  const pdt = info?.programDateTime;
  const rangeOptions = [
    { value: 'whole', label: 'Whole stream' },
    { value: 'seconds', label: 'Seconds' },
    {
      value: 'wallclock',
      label: 'Wall clock',
      disabled: info && !pdt,
      title: info && !pdt ? 'This playlist has no EXT-X-PROGRAM-DATE-TIME' : undefined,
    },
  ];
  const canExport = !!url && !isRunning && engine !== 'error';

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">hls-to-mp4 · demo</p>
          <h1>HLS → MP4, in the browser</h1>
          <p className="lede">
            Downloads the segments of an HLS playlist — or just a time range — and remuxes them into one MP4 with ffmpeg.wasm. Video is
            never re-encoded; nothing touches a server.
          </p>
        </div>
        <div className="masthead-side">
          <Badge tone={engine === 'ready' ? 'ok' : engine === 'error' ? 'bad' : 'neutral'}>
            ffmpeg {engine === 'ready' ? 'ready' : engine === 'error' ? 'failed to load' : 'loading…'}
          </Badge>
          <button
            type="button"
            className="ghost small"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : t === 'light' ? null : 'dark'))}
            title="Theme: system → dark → light"
          >
            Theme: {theme ?? 'system'}
          </button>
        </div>
      </header>

      <main className="grid">
        <div className="column">
          <Card title="1 · Source">
            <form
              className="url-row"
              onSubmit={(event) => {
                event.preventDefault();
                inspect();
              }}
            >
              <input
                type="url"
                inputMode="url"
                placeholder="https://example.com/stream/master.m3u8"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Playlist URL"
                required
              />
              <button type="submit" className="secondary" disabled={!url || inspecting}>
                {inspecting ? 'Inspecting…' : 'Inspect'}
              </button>
            </form>

            {samples.length > 0 && (
              <div className="presets">
                <span className="presets-label">Local samples</span>
                <div className="chips">
                  {samples.map((s) => (
                    <button key={s.id} type="button" className="chip" onClick={() => pickPreset(s.url)} title={s.url}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {samples.length === 0 && (
              <p className="muted small-text">
                Run <code>npm run samples</code> to generate local test streams (needs native ffmpeg).
              </p>
            )}
            <div className="presets">
              <span className="presets-label">Public test streams (internet + CORS)</span>
              <div className="chips">
                {PUBLIC_STREAMS.map((s) => (
                  <button key={s.id} type="button" className="chip" onClick={() => pickPreset(s.url)} title={s.url}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {inspectError && <p className="error-text">{inspectError.message}</p>}
            {info && (
              <div className="info">
                <div className="badges">
                  <Badge>{info.isMaster ? `Master · ${info.variants.length} variants` : 'Media playlist'}</Badge>
                  <Badge>{info.container === 'fmp4' ? 'fMP4' : 'MPEG-TS'}</Badge>
                  {info.separateAudio && <Badge>Separate audio</Badge>}
                  {info.encryption && <Badge tone={info.exportable ? 'neutral' : 'bad'}>{info.encryption}</Badge>}
                  {info.byteRange && <Badge>Byte ranges</Badge>}
                  {info.discontinuities > 0 && <Badge>{info.discontinuities} discontinuit{info.discontinuities === 1 ? 'y' : 'ies'}</Badge>}
                  {info.live && <Badge tone="warn">Live — exports the current window</Badge>}
                </div>
                <Facts
                  items={[
                    ['Duration', formatDuration(info.duration)],
                    ['Segments', `${info.segmentCount} × ~${info.targetDuration ?? '?'} s`],
                    ['Variant', info.variant ? variantLabel(info.variant) : null],
                    ['Audio', info.audioRendition ? `${info.audioRendition.name ?? ''} ${info.audioRendition.language ? `(${info.audioRendition.language})` : ''}` : null],
                    ['Recorded', pdt ? `${formatClock(pdt.start)} → ${formatClock(pdt.end)}` : null],
                  ]}
                />
                {!info.exportable && <p className="error-text">This stream uses DRM / SAMPLE-AES and cannot be exported.</p>}
              </div>
            )}
          </Card>

          <Card title="2 · Range">
            <Segmented label="Range" value={rangeMode} onChange={setRangeMode} options={rangeOptions} />
            {rangeMode === 'seconds' && (
              <div className="row">
                <Field label="Start (s)">
                  <input type="number" min="0" step="0.1" value={startSec} onChange={(e) => setStartSec(e.target.value)} />
                </Field>
                <Field label="End (s)" hint={info ? `of ${formatDuration(info.duration)}` : undefined}>
                  <input type="number" min="0" step="0.1" value={endSec} onChange={(e) => setEndSec(e.target.value)} />
                </Field>
              </div>
            )}
            {rangeMode === 'wallclock' && (
              <div className="row">
                <Field label="Start (local time)">
                  <input type="datetime-local" step="1" value={startWall} onChange={(e) => setStartWall(e.target.value)} />
                </Field>
                <Field label="End (local time)">
                  <input type="datetime-local" step="1" value={endWall} onChange={(e) => setEndWall(e.target.value)} />
                </Field>
              </div>
            )}
            {rangeMode !== 'whole' && (
              <label className="check">
                <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
                <span>
                  Trim to the range <span className="muted">— cuts at the keyframe before the start; off keeps whole segments</span>
                </span>
              </label>
            )}
          </Card>

          <Card title="3 · Options">
            <div className="row">
              <Field label="Variant">
                <select value={variant} onChange={(e) => setVariant(e.target.value)}>
                  <option value="highest">Highest bandwidth</option>
                  <option value="lowest">Lowest bandwidth</option>
                  {info?.variants.map((v, i) => (
                    <option key={v.url} value={String(i)}>
                      {variantLabel(v)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Audio">
                <select value={audio} onChange={(e) => setAudio(e.target.value)}>
                  <option value="auto">Keep (AAC if needed)</option>
                  <option value="none">Drop</option>
                </select>
              </Field>
            </div>
            <div className="row">
              <Field label="Max size (MB)">
                <input type="number" min="1" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
              </Field>
              <Field label="Parallel downloads">
                <input type="number" min="1" max="16" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
              </Field>
            </div>
            <div className="row">
              <Field label="ffmpeg.wasm core">
                <select value={coreSource} onChange={(e) => setCoreSource(e.target.value)}>
                  <option value="local">Self-hosted (@ffmpeg/core)</option>
                  <option value="cdn">jsDelivr CDN (package default)</option>
                </select>
              </Field>
              <Field label="File name">
                <input type="text" value={fileName} onChange={(e) => setFileName(e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="column">
          <Card
            title="4 · Export"
            aside={isRunning ? <span className="muted tabular">{(elapsed / 1000).toFixed(1)} s</span> : null}
            className="sticky"
          >
            <div className="actions">
              <button type="button" className="primary" onClick={run} disabled={!canExport}>
                {isRunning ? 'Exporting…' : 'Build MP4'}
              </button>
              {isRunning && (
                <button type="button" className="secondary" onClick={cancel}>
                  Cancel
                </button>
              )}
            </div>

            {progress && (
              <div className="progress">
                <div className="progress-head">
                  <strong>{progress.phase === 'downloading' ? 'Downloading segments' : 'Building MP4'}</strong>
                  <span className="tabular">{Math.round(progress.ratio * 100)}%</span>
                </div>
                <ProgressBar ratio={progress.ratio} />
                <p className="muted small-text tabular">
                  {progress.segmentsDone}/{progress.segmentsTotal || '…'} segments · {formatBytes(progress.bytesDownloaded)}
                </p>
              </div>
            )}

            {error?.cancelled && <p className="muted">Export cancelled.</p>}
            {error && !error.cancelled && (
              <div className="error-box" role="alert">
                <strong>{error.code ?? error.name}</strong>
                <p>{error.message}</p>
              </div>
            )}

            {result && (
              <div className="result">
                <video
                  src={result.objectUrl}
                  controls
                  playsInline
                  onLoadedMetadata={(e) => {
                    const { duration, src } = e.currentTarget;
                    setResult((r) => (r && r.objectUrl === src ? { ...r, duration } : r));
                  }}
                />
                <Facts
                  items={[
                    ['Size', formatBytes(result.blob.size)],
                    ['Duration', formatDuration(result.duration)],
                    ['Built in', `${(result.ms / 1000).toFixed(2)} s`],
                    ['Type', result.blob.type],
                  ]}
                />
                <button type="button" className="primary" onClick={save}>
                  Save {/\.(mp4|m4a)$/i.test(fileName) ? fileName : `${fileName || 'video'}.mp4`}
                </button>
              </div>
            )}
          </Card>

          <Card title="Code for these settings">
            <CodeBlock code={code} />
          </Card>

          <Card title="ffmpeg log" aside={<span className="muted small-text">{logs.length} lines</span>}>
            {logs.length ? <pre className="log">{logs.join('\n')}</pre> : <p className="muted small-text">The log of the last export appears here.</p>}
          </Card>
        </div>
      </main>
    </div>
  );
}
