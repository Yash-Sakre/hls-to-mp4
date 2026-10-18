// Remux downloaded parts into one MP4 with ffmpeg.wasm. Video is always
// stream-copied; audio is copied when MP4 can carry it, otherwise transcoded
// to AAC.

import { abortError, ErrorCode, HlsToMp4Error } from './errors.js';

// Audio codecs the MP4 muxer accepts as-is. Anything else (G.711, MP2, ADPCM,
// FLAC…) is transcoded to AAC.
const MP4_COPYABLE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac']);
const EPSILON = 0.0005;
const TS_PACKET = 188;

let jobCounter = 0;

const fmt = (seconds) => seconds.toFixed(3);

const num = (value) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : null);

const ffprobeJson = async (engine, args) => {
  const stdout = [];
  const off = engine.on('log', ({ type, message }) => {
    if (type === 'stdout') stdout.push(message);
  });
  try {
    await engine.call('ffprobe', { args: ['-v', 'error', ...args, '-of', 'json'] });
  } finally {
    off();
  }
  try {
    return JSON.parse(stdout.join('\n'));
  } catch {
    throw new HlsToMp4Error(ErrorCode.CONVERSION, 'Could not read the stream information of the downloaded segments.');
  }
};

// Codecs and start times of one input file.
const probe = async (engine, path) => {
  const info = await ffprobeJson(engine, ['-show_entries', 'stream=codec_type,codec_name,start_time:format=start_time', path]);
  const streamOf = (type) => info.streams?.find((s) => s.codec_type === type);
  const start = num(info.format?.start_time) ?? 0;
  return {
    video: streamOf('video')?.codec_name ?? null,
    audio: streamOf('audio')?.codec_name ?? null,
    // The format start is the earliest packet — often audio, a few ms before
    // the first video frame (where HLS segments begin).
    start,
    videoStart: num(streamOf('video')?.start_time) ?? start,
  };
};

// Byte length of the PSI packets (PAT, PMT, SDT…) that open an MPEG-TS
// segment: every packet before the first PES start. 0 if it isn't TS.
const tsPsiLength = async (blob) => {
  const head = new Uint8Array(await blob.slice(0, TS_PACKET * 32).arrayBuffer());
  let offset = 0;
  while (offset + TS_PACKET <= head.length && head[offset] === 0x47) {
    const unitStart = head[offset + 1] & 0x40;
    const adaptation = (head[offset + 3] >> 4) & 0x3;
    const payload = offset + 4 + (adaptation & 0x2 ? 1 + head[offset + 4] : 0);
    if (unitStart && adaptation & 0x1 && head[payload] === 0 && head[payload + 1] === 0 && head[payload + 2] === 1) {
      return offset;
    }
    offset += TS_PACKET;
  }
  return 0;
};

// The last video keyframe at or before `target` (media time) among the first
// `scanSeconds` of a file, with its timestamps and byte position.
const keyframeAtOrBefore = async (engine, path, target, scanSeconds) => {
  const info = await ffprobeJson(engine, [
    '-select_streams', 'v:0',
    '-read_intervals', `%+${fmt(scanSeconds)}`,
    '-show_entries', 'packet=pts_time,dts_time,flags,pos',
    path,
  ]);
  const keyframes = (info.packets ?? [])
    .filter((p) => p.flags?.startsWith('K') && num(p.pts_time) !== null)
    .map((p) => ({ pts: Number(p.pts_time), dts: num(p.dts_time) ?? Number(p.pts_time), pos: num(p.pos) }));
  return keyframes.filter((k) => k.pts <= target + EPSILON).pop() ?? null;
};

// Cut an MPEG-TS part at a keyframe's byte position, keeping the PSI packets
// in front. Seeking TS with stream copy is not keyframe-accurate in ffmpeg —
// it can land after the keyframe and start the picture late — so the head
// trim is done on the bytes instead. Returns null when there is nothing before
// the keyframe to cut.
const cutTsAt = async (blob, pos) => {
  if (pos === null || pos % TS_PACKET !== 0) return null;
  const psiLength = await tsPsiLength(blob);
  if (!psiLength || pos <= psiLength) return null;
  return new Blob([blob.slice(0, psiLength), blob.slice(pos)]);
};

// One ffmpeg input: a single part is read directly, several go through the
// concat demuxer (which re-bases their timestamps back to back). Positive
// `seek` skips into the input, negative delays it.
const inputArgs = ({ path, listPath }, seek, limit) => {
  const args = [];
  if (seek > EPSILON) args.push('-ss', fmt(seek));
  else if (seek < -EPSILON) args.push('-itsoffset', fmt(-seek));
  if (limit !== null) args.push('-t', fmt(Math.max(0.001, limit + Math.min(0, seek))));
  if (listPath) args.push('-f', 'concat', '-safe', '0', '-i', listPath);
  else args.push('-i', path);
  return args;
};

/**
 * @param {object} engine          FFmpegEngine from ./ffmpeg.js
 * @param {object} job
 * @param {{ name: string, blob: Blob, fmp4: boolean }[]} job.mainParts   Parts of the variant playlist.
 * @param {{ name: string, blob: Blob, fmp4: boolean }[]|null} job.audioParts  Parts of a separate audio rendition.
 * @param {number} job.headTrim    Seconds to drop from the start of the first segment.
 * @param {boolean} job.trimEnd    Whether to stop at `duration` after the start.
 * @param {number} job.duration    Output duration (after trimming).
 * @param {boolean} job.dropAudio
 * @param {AbortSignal} job.signal
 * @param {(ratio: number) => void} job.onProgress
 * @param {(message: string) => void} [job.onLog]
 * @returns {Promise<Blob>}
 */
export const remuxToMp4 = async (engine, { mainParts, audioParts, headTrim, trimEnd, duration, dropAudio, signal, onProgress, onLog }) => {
  jobCounter += 1;
  const dir = `/hls${jobCounter}`;
  const cutDir = `/hls${jobCounter}-cut`;
  const mainList = `/hls${jobCounter}-main.txt`;
  const audioList = `/hls${jobCounter}-audio.txt`;
  const outPath = `/hls${jobCounter}.mp4`;

  const logs = [];
  // ffmpeg writes its log to stderr; stdout only carries ffprobe's JSON.
  const offLog = engine.on('log', ({ type, message }) => {
    if (type === 'stdout') return;
    logs.push(message);
    onLog?.(message);
  });
  const offProgress = engine.on('progress', ({ time }) => {
    // `time` is the output position in microseconds.
    if (duration > 0 && Number.isFinite(time)) onProgress(Math.min(1, Math.max(0, time / 1e6 / duration)));
  });
  const terminate = () => engine.terminate(abortError());
  signal.addEventListener('abort', terminate);

  const mounts = [];
  const mount = async (mountDir, parts) => {
    // WORKERFS reads the Blobs lazily instead of copying them into the wasm
    // heap, so only the output MP4 occupies ffmpeg memory.
    await engine.call('mount', { dir: mountDir, blobs: parts.map(({ name, blob }) => ({ name, data: blob })) });
    mounts.push(mountDir);
  };
  const inputFor = async (paths, listPath) => {
    if (paths.length === 1) return { path: paths[0] };
    await engine.call('writeFile', { path: listPath, data: paths.map((p) => `file '${p}'`).join('\n') });
    return { listPath };
  };

  try {
    const audioTrack = audioParts && !dropAudio ? audioParts : null;
    await mount(dir, [...mainParts, ...(audioTrack ?? [])]);
    const mainPaths = mainParts.map(({ name }) => `${dir}/${name}`);

    const first = await probe(engine, mainPaths[0]);
    const separate = audioTrack ? await probe(engine, `${dir}/${audioTrack[0].name}`) : null;
    const audioCodec = dropAudio ? null : separate ? separate.audio : first.audio;
    if (!first.video && !audioCodec) {
      throw new HlsToMp4Error(ErrorCode.CONVERSION, 'No audio or video stream found in the segments.');
    }

    // Media times (the renditions of a playlist share one timeline). HLS
    // segments begin at the first video frame, so the requested start is
    // `videoStart + headTrim` and the end `duration` after it.
    const start = first.videoStart + headTrim;
    const end = start + duration;

    // `inputStart` is the media time at which the main input's timeline
    // begins (after any input seek); the audio input is aligned to it.
    // `outputSeek` drops packets that precede the first video keyframe.
    let inputStart = first.start;
    let mainSeek = 0;
    let outputSeek = 0;
    if (headTrim > EPSILON) {
      const keyframe = first.video ? await keyframeAtOrBefore(engine, mainPaths[0], start, headTrim + 1) : null;
      if (!first.video) {
        // Audio only: every frame is a sync point.
        mainSeek = start - first.start;
        inputStart = start;
      } else if (keyframe && !mainParts[0].fmp4) {
        const cut = await cutTsAt(mainParts[0].blob, keyframe.pos);
        if (cut) {
          const name = `cut-${mainParts[0].name}`;
          await mount(cutDir, [{ name, blob: cut }]);
          mainPaths[0] = `${cutDir}/${name}`;
          inputStart = (await probe(engine, mainPaths[0])).start;
        }
        // TS carries audio in long PES packets, so audio from up to ~0.3 s
        // before the keyframe follows it. Stream copy compares DTS here.
        outputSeek = keyframe.dts - inputStart;
      } else if (keyframe && mainParts.length === 1) {
        // fMP4: -ss on the input lands exactly on a keyframe target.
        mainSeek = keyframe.pts - first.start;
        inputStart = keyframe.pts;
      }
      // Otherwise (no keyframe found, or several fMP4 parts — the concat
      // demuxer cannot seek inside a fragment) start at the first segment.
    }
    const limit = trimEnd ? end - inputStart : null;
    // A separate audio rendition has its own segment boundaries, so its last
    // segment usually runs past the video's: always end it with the video.
    const audioLimit = separate?.audio && first.video ? end - inputStart : limit;

    // ffprobe above set the (process-global) log level to error; restore it.
    const args = ['-hide_banner', '-loglevel', 'info', ...inputArgs(await inputFor(mainPaths, mainList), mainSeek, limit)];
    const audioSeek = separate?.audio ? inputStart - separate.start : 0;
    if (separate?.audio) {
      const audioPaths = audioTrack.map(({ name }) => `${dir}/${name}`);
      args.push(...inputArgs(await inputFor(audioPaths, audioList), audioSeek, audioLimit));
    }
    if (first.video) {
      args.push('-map', '0:v:0', '-c:v', 'copy');
      // Safari/QuickTime only play HEVC-in-MP4 tagged hvc1 (ffmpeg defaults to hev1).
      if (first.video === 'hevc') args.push('-tag:v', 'hvc1');
    }
    if (audioCodec) {
      args.push('-map', separate?.audio ? '1:a:0' : '0:a:0');
      args.push(...(MP4_COPYABLE_AUDIO.has(audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac']));
    }
    // A stream-copy cut starts at a keyframe before the requested start; shift
    // everything so the output starts at zero with A/V kept in sync.
    if (outputSeek > EPSILON) args.push('-ss', fmt(outputSeek));
    if (headTrim > EPSILON || Math.abs(audioSeek) > EPSILON) args.push('-avoid_negative_ts', 'make_zero');
    args.push('-movflags', '+faststart', outPath);

    logs.length = 0;
    onLog?.(`ffmpeg ${args.join(' ')}`);
    const exitCode = await engine.call('exec', { args });
    if (exitCode !== 0) {
      throw new HlsToMp4Error(ErrorCode.CONVERSION, `MP4 conversion failed: ${logs.slice(-3).join(' ') || `exit code ${exitCode}`}`, {
        exitCode,
        log: logs.slice(-30),
      });
    }
    const data = await engine.call('readFile', { path: outPath });
    return new Blob([data], { type: first.video ? 'video/mp4' : 'audio/mp4' });
  } catch (err) {
    throw signal.aborted ? abortError() : err;
  } finally {
    signal.removeEventListener('abort', terminate);
    offLog();
    offProgress();
    if (!engine.terminated) {
      // Best-effort cleanup so a reused worker doesn't accumulate files.
      for (const path of [outPath, mainList, audioList]) await engine.call('unlink', { path }).catch(() => {});
      for (const mountDir of mounts) await engine.call('unmount', { dir: mountDir }).catch(() => {});
    }
  }
};
