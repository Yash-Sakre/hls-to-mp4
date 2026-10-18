export const ErrorCode = Object.freeze({
  /** The response is not an HLS playlist, or the playlist is malformed. */
  INVALID_PLAYLIST: 'INVALID_PLAYLIST',
  /** A playlist feature this library cannot handle (DRM, SAMPLE-AES, …). */
  UNSUPPORTED: 'UNSUPPORTED',
  /** `start`/`end` are malformed or out of order. */
  INVALID_RANGE: 'INVALID_RANGE',
  /** No media segments fall inside the requested range. */
  NO_SEGMENTS: 'NO_SEGMENTS',
  /** A playlist, key or segment request failed after all retries. */
  NETWORK: 'NETWORK',
  /** The export would exceed `maxBytes`. */
  TOO_LARGE: 'TOO_LARGE',
  /** An AES-128 segment could not be decrypted (wrong key or IV). */
  DECRYPTION: 'DECRYPTION',
  /** ffmpeg.wasm could not be loaded. */
  FFMPEG_LOAD: 'FFMPEG_LOAD',
  /** ffmpeg failed to build the MP4. */
  CONVERSION: 'CONVERSION',
});

export class HlsToMp4Error extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HlsToMp4Error';
    this.code = code;
    Object.assign(this, details);
  }
}

export const abortError = () => new DOMException('Export cancelled', 'AbortError');

/** True for the error thrown when an export is cancelled through its AbortSignal. */
export const isAbortError = (error) => error?.name === 'AbortError';

export const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError();
};
