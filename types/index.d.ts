/**
 * A point in time for `start` / `end`.
 *
 * - `number` — seconds from the start of the playlist.
 * - `Date`, an ISO 8601 string, or any object whose `valueOf()` returns epoch
 *   milliseconds (dayjs, moment, Luxon…) — a wall-clock time, matched against
 *   the playlist's `EXT-X-PROGRAM-DATE-TIME` tags.
 */
export type HlsTime = number | Date | string | { valueOf(): number };

export interface HlsVariant {
  url: string;
  bandwidth: number;
  averageBandwidth: number | null;
  resolution: { width: number; height: number } | null;
  codecs: string | null;
  frameRate: number | null;
  /** `AUDIO` group id; its rendition is fetched separately when it has a URI. */
  audioGroup: string | null;
}

export interface HlsAudioRendition {
  groupId: string | null;
  name: string | null;
  language: string | null;
  default: boolean;
  autoselect: boolean;
  /** null when the audio is muxed into the variant's own segments. */
  url: string | null;
}

/** `'highest'` (default) or `'lowest'` bandwidth, or a function picking one of the variants. */
export type VariantPreference = 'highest' | 'lowest' | ((variants: HlsVariant[]) => HlsVariant);

/**
 * Where to load ffmpeg.wasm from. Defaults to `@ffmpeg/core@0.12.10` on the
 * jsDelivr CDN. Self-host by passing the URLs of `@ffmpeg/core`'s ESM build.
 */
export interface FFmpegConfig {
  /** URL of `ffmpeg-core.js` (ESM build). */
  coreURL?: string;
  /** URL of `ffmpeg-core.wasm`. Defaults to `coreURL` with a `.wasm` extension. */
  wasmURL?: string;
}

export interface ExportProgress {
  phase: 'downloading' | 'converting';
  /** 0–1 within the current phase. */
  ratio: number;
  /** Segments (including init sections) downloaded so far. */
  segmentsDone: number;
  segmentsTotal: number;
  bytesDownloaded: number;
}

export interface PlaylistOptions {
  /** Which variant of a master playlist to use. Default `'highest'`. */
  variant?: VariantPreference;
  /** Custom fetch, e.g. to sign URLs or route through a proxy. */
  fetch?: typeof fetch;
  /** Merged into every request: headers, credentials, mode… */
  fetchOptions?: RequestInit;
  /** Extra attempts for network errors and 408/425/429/5xx responses. Default 2. */
  retries?: number;
  signal?: AbortSignal;
}

export interface ExportOptions extends PlaylistOptions {
  /** Master or media playlist URL (absolute, or relative to the page). */
  url: string;
  /** Start of the range. Omit to start at the beginning. */
  start?: HlsTime;
  /** End of the range. Omit to run to the end. */
  end?: HlsTime;
  /**
   * Cut to `start`/`end` (default `true`). The cut starts at the keyframe at
   * or before `start`, since video is never re-encoded. `false` keeps whole
   * segments.
   */
  trim?: boolean;
  /** `'auto'` (default) keeps audio, transcoding it to AAC if MP4 can't carry it; `'none'` drops it. */
  audio?: 'auto' | 'none';
  /** Fail with `TOO_LARGE` beyond this many bytes. Default 1 GiB (`DEFAULT_MAX_BYTES`). */
  maxBytes?: number;
  /** Parallel segment downloads. Default 6. */
  concurrency?: number;
  ffmpeg?: FFmpegConfig;
  onProgress?: (progress: ExportProgress) => void;
  /** ffmpeg's log output, line by line. */
  onLog?: (message: string) => void;
}

export interface DownloadOptions extends ExportOptions {
  /** Default `'video.mp4'`; `.mp4` is appended when missing. */
  fileName?: string;
}

export interface HlsInfo {
  url: string;
  isMaster: boolean;
  variants: HlsVariant[];
  /** The variant that `variant` selects (null for a media playlist). */
  variant: HlsVariant | null;
  audioRenditions: HlsAudioRendition[];
  audioRendition: HlsAudioRendition | null;
  /** True when audio comes from a separate rendition playlist. */
  separateAudio: boolean;
  /** Total duration in seconds. */
  duration: number;
  segmentCount: number;
  targetDuration: number | null;
  /** No `EXT-X-ENDLIST` yet: exports take the segments listed right now. */
  live: boolean;
  container: 'ts' | 'fmp4';
  /** Encryption methods in use, e.g. `'AES-128'`, or null. */
  encryption: string | null;
  /** False when the encryption (DRM, SAMPLE-AES) can't be exported. */
  exportable: boolean;
  byteRange: boolean;
  discontinuities: number;
  /** Wall-clock span, when the playlist has `EXT-X-PROGRAM-DATE-TIME`. */
  programDateTime: { start: Date; end: Date } | null;
}

/** Download an HLS playlist (or a range of it) and remux it into one MP4. */
export declare function exportHlsToMp4(options: ExportOptions): Promise<Blob>;

/** `exportHlsToMp4`, then save the result as a browser download. */
export declare function downloadHlsAsMp4(options: DownloadOptions): Promise<{ blob: Blob; fileName: string }>;

/** Fetch and summarise a playlist without downloading media. */
export declare function inspectHls(url: string, options?: PlaylistOptions): Promise<HlsInfo>;

/** Start loading ffmpeg.wasm before the first export. */
export declare function preloadFFmpeg(config?: FFmpegConfig): Promise<void>;

/** Terminate the idle ffmpeg worker kept for reuse. */
export declare function disposeFFmpeg(): void;

/** Hand a Blob to the browser as a file download. */
export declare function saveBlob(blob: Blob, fileName: string): void;

/** True for the error thrown when an export is cancelled through its AbortSignal. */
export declare function isAbortError(error: unknown): boolean;

export declare const DEFAULT_MAX_BYTES: number;
export declare const FFMPEG_CORE_VERSION: string;
export declare const DEFAULT_FFMPEG_CORE_URL: string;
export declare const DEFAULT_FFMPEG_WASM_URL: string;

export type HlsToMp4ErrorCode =
  | 'INVALID_PLAYLIST'
  | 'UNSUPPORTED'
  | 'INVALID_RANGE'
  | 'NO_SEGMENTS'
  | 'NETWORK'
  | 'TOO_LARGE'
  | 'DECRYPTION'
  | 'FFMPEG_LOAD'
  | 'CONVERSION';

export declare const ErrorCode: { readonly [K in HlsToMp4ErrorCode]: K };

export declare class HlsToMp4Error extends Error {
  readonly name: 'HlsToMp4Error';
  readonly code: HlsToMp4ErrorCode;
  /** The request URL, for NETWORK errors. */
  readonly url?: string;
  /** The HTTP status, for NETWORK errors. */
  readonly status?: number;
  /** Actual or projected size, for TOO_LARGE. */
  readonly bytes?: number;
  /** `maxBytes`, for TOO_LARGE. */
  readonly limit?: number;
  /** ffmpeg's exit code and last log lines, for CONVERSION. */
  readonly exitCode?: number;
  readonly log?: string[];
  readonly cause?: unknown;
}
