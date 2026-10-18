// Network layer: retries, byte ranges and AES-128 segment decryption.

import { abortError, ErrorCode, HlsToMp4Error, throwIfAborted } from './errors.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const rangeHeader = ({ offset, length }) => `bytes=${offset}-${offset + length - 1}`;

/**
 * @param {object} options
 * @param {typeof fetch} [options.fetch]       Custom fetch (auth, signing, proxies…).
 * @param {RequestInit} [options.fetchOptions] Merged into every request (headers, credentials…).
 * @param {number} [options.retries=2]         Extra attempts for network errors and 408/429/5xx.
 */
export const createFetcher = ({ fetch: fetchImpl, fetchOptions = {}, retries = 2 } = {}) => {
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== 'function') throw new TypeError('No fetch implementation available.');

  const withRetry = async (url, signal, run) => {
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await run();
      } catch (err) {
        if (signal?.aborted) throw abortError();
        const retryable = err instanceof HlsToMp4Error ? err.retryable : true;
        if (!retryable || attempt >= retries) {
          if (err instanceof HlsToMp4Error) throw err;
          throw new HlsToMp4Error(ErrorCode.NETWORK, `Network error while fetching ${url}: ${err?.message ?? err}`, {
            url,
            cause: err,
          });
        }
        await delay(500 * (attempt + 1), signal);
      }
    }
  };

  const request = async (url, { signal, byteRange } = {}) => {
    const headers = new Headers(fetchOptions.headers);
    const init = { ...fetchOptions, headers, signal };
    if (byteRange) {
      headers.set('Range', rangeHeader(byteRange));
      // Chrome's HTTP cache can answer parallel range requests for the same
      // URL with a truncated 206 from a sparse cache entry; bypass it.
      init.cache = fetchOptions.cache ?? 'no-store';
    }
    const res = await doFetch(url, init);
    if (!res.ok) {
      throw new HlsToMp4Error(ErrorCode.NETWORK, `HTTP ${res.status} while fetching ${url}`, {
        url,
        status: res.status,
        retryable: RETRYABLE_STATUS.has(res.status),
      });
    }
    return res;
  };

  /** Fetch a playlist (or any text resource). */
  const text = (url, signal) => withRetry(url, signal, async () => (await request(url, { signal })).text());

  /**
   * Fetch a resource (or a byte range of it) as a Blob. Servers that ignore
   * the Range header and answer 200 with the whole file are handled by slicing.
   */
  const blob = (url, { signal, byteRange } = {}) =>
    withRetry(url, signal, async () => {
      const res = await request(url, { signal, byteRange });
      let body = await res.blob();
      if (!byteRange) return body;
      if (res.status !== 206) body = body.slice(byteRange.offset, byteRange.offset + byteRange.length);
      // Never hand a short range to the muxer: it would silently corrupt the MP4.
      if (body.size !== byteRange.length) {
        throw new HlsToMp4Error(
          ErrorCode.NETWORK,
          `Byte range ${rangeHeader(byteRange)} of ${url} returned ${body.size} bytes instead of ${byteRange.length}.`,
          { url, status: res.status, retryable: res.status === 206 },
        );
      }
      return body;
    });

  const arrayBuffer = (url, signal) => withRetry(url, signal, async () => (await request(url, { signal })).arrayBuffer());

  return { text, blob, arrayBuffer };
};

// ---------------------------------------------------------------------------
// AES-128 (full-segment, CBC + PKCS7) decryption
// ---------------------------------------------------------------------------

/** The default IV for AES-128 segments: the media sequence number, big-endian. */
export const sequenceIv = (sequence) => {
  const iv = new Uint8Array(16);
  let n = sequence;
  for (let i = 15; i >= 0 && n > 0; i -= 1) {
    iv[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return iv;
};

/** Throws when a segment/init key uses a method this library cannot decrypt. */
export const assertDecryptable = (key) => {
  if (!key) return;
  if (key.method !== 'AES-128' || key.keyFormat !== 'identity') {
    throw new HlsToMp4Error(
      ErrorCode.UNSUPPORTED,
      `Encryption method ${key.method}${key.keyFormat !== 'identity' ? ` (${key.keyFormat})` : ''} is not supported. Only clear-key AES-128 can be exported.`,
    );
  }
  if (!key.url) throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, 'EXT-X-KEY METHOD=AES-128 is missing its URI.');
  if (!globalThis.crypto?.subtle) {
    throw new HlsToMp4Error(
      ErrorCode.UNSUPPORTED,
      'Decrypting AES-128 HLS needs the Web Crypto API, which browsers only expose on secure origins (HTTPS or localhost).',
    );
  }
};

export const createDecryptor = (fetcher) => {
  const keys = new Map();

  const cryptoKey = (key, signal) => {
    if (!keys.has(key.url)) {
      const promise = fetcher.arrayBuffer(key.url, signal).then((raw) => {
        if (raw.byteLength !== 16) {
          throw new HlsToMp4Error(ErrorCode.INVALID_PLAYLIST, `AES-128 key at ${key.url} is ${raw.byteLength} bytes; expected 16.`);
        }
        return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      });
      promise.catch(() => keys.delete(key.url));
      keys.set(key.url, promise);
    }
    return keys.get(key.url);
  };

  /** Decrypt `blob` with `key`; `sequence` supplies the IV when the key has none. */
  return async (blob, key, sequence, signal) => {
    if (!key) return blob;
    const [k, data] = await Promise.all([cryptoKey(key, signal), blob.arrayBuffer()]);
    try {
      const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv: key.iv ?? sequenceIv(sequence) }, k, data);
      return new Blob([plain]);
    } catch (err) {
      throw new HlsToMp4Error(ErrorCode.DECRYPTION, `Could not decrypt a segment (wrong key or IV?): ${err?.message ?? err}`);
    }
  };
};
