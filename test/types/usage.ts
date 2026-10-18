// Compile-only checks for the published type declarations (`npm run typecheck`).
import {
  downloadHlsAsMp4,
  ErrorCode,
  exportHlsToMp4,
  type ExportProgress,
  HlsToMp4Error,
  inspectHls,
  isAbortError,
  preloadFFmpeg,
} from 'hls-to-mp4';
import { useHlsToMp4 } from 'hls-to-mp4/react';

async function examples() {
  const controller = new AbortController();
  const blob: Blob = await exportHlsToMp4({
    url: 'https://example.com/master.m3u8',
    start: new Date('2026-10-17T10:00:00Z'),
    end: '2026-10-17T10:05:00Z',
    variant: (variants) => variants.find((v) => (v.resolution?.height ?? 0) <= 720) ?? variants[0],
    fetchOptions: { headers: { Authorization: 'Bearer token' } },
    ffmpeg: { coreURL: '/ffmpeg/ffmpeg-core.js' },
    signal: controller.signal,
    onProgress: (p: ExportProgress) => console.log(p.phase, p.ratio),
  });
  void blob;

  await exportHlsToMp4({ url: '/vod.m3u8', start: 30, end: 90, trim: false, audio: 'none', maxBytes: Infinity });

  const { fileName } = await downloadHlsAsMp4({ url: '/vod.m3u8', fileName: 'clip' });
  void fileName;

  const info = await inspectHls('/vod.m3u8', { variant: 'lowest' });
  const span: number | undefined = info.programDateTime ? info.programDateTime.end.getTime() - info.programDateTime.start.getTime() : undefined;
  void span;

  await preloadFFmpeg();

  try {
    await exportHlsToMp4({ url: '/vod.m3u8' });
  } catch (err) {
    if (isAbortError(err)) return;
    if (err instanceof HlsToMp4Error && err.code === ErrorCode.TOO_LARGE) console.log(err.bytes, err.limit);
  }
}

function Component() {
  const { downloadMp4, cancel, progress, isRunning } = useHlsToMp4();
  const run = () => downloadMp4({ url: '/vod.m3u8', start: 0, end: 60 }).then((result) => result?.fileName);
  return { run, cancel, percent: progress ? Math.round(progress.ratio * 100) : null, isRunning };
}

void examples;
void Component;
