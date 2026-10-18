import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDecryptor, createFetcher, sequenceIv } from '../../src/fetcher.js';

const response = (body, init = {}) => new Response(body, { status: 200, ...init });

describe('createFetcher', () => {
  it('retries network errors and retryable statuses, then succeeds', async () => {
    const calls = [];
    const outcomes = [() => Promise.reject(new TypeError('offline')), () => response('', { status: 503 }), () => response('#EXTM3U')];
    const fetcher = createFetcher({
      retries: 2,
      fetch: async (url, init) => {
        calls.push(init.headers.get('x-token'));
        return outcomes.shift()();
      },
      fetchOptions: { headers: { 'x-token': 'abc' } },
    });
    assert.equal(await fetcher.text('https://example.com/a.m3u8'), '#EXTM3U');
    assert.deepEqual(calls, ['abc', 'abc', 'abc']);
  });

  it('does not retry permanent HTTP errors', async () => {
    let calls = 0;
    const fetcher = createFetcher({ fetch: async () => (calls++, response('', { status: 404 })) });
    await assert.rejects(fetcher.text('https://example.com/missing.m3u8'), { code: 'NETWORK', status: 404 });
    assert.equal(calls, 1);
  });

  it('sends Range headers and slices when the server ignores them', async () => {
    let rangeHeader;
    const fetcher = createFetcher({
      fetch: async (url, init) => {
        rangeHeader = init.headers.get('range');
        return response('0123456789');
      },
    });
    const blob = await fetcher.blob('https://example.com/file.ts', { byteRange: { offset: 2, length: 3 } });
    assert.equal(rangeHeader, 'bytes=2-4');
    assert.equal(await blob.text(), '234');
  });

  it('retries a truncated 206 range response and bypasses the HTTP cache', async () => {
    const seen = [];
    const bodies = ['01', '01234'];
    const fetcher = createFetcher({
      fetch: async (url, init) => {
        seen.push(init.cache);
        return response(bodies.shift(), { status: 206 });
      },
    });
    const blob = await fetcher.blob('https://example.com/main.mp4', { byteRange: { offset: 100, length: 5 } });
    assert.equal(await blob.text(), '01234');
    assert.deepEqual(seen, ['no-store', 'no-store']);
  });

  it('fails when a whole-file response is shorter than the range', async () => {
    const fetcher = createFetcher({ fetch: async () => response('0123') });
    await assert.rejects(fetcher.blob('https://example.com/f.ts', { byteRange: { offset: 2, length: 5 } }), { code: 'NETWORK' });
  });

  it('stops retrying once aborted', async () => {
    const controller = new AbortController();
    const fetcher = createFetcher({
      fetch: async () => {
        controller.abort();
        throw new TypeError('offline');
      },
    });
    await assert.rejects(fetcher.text('https://example.com/a.m3u8', controller.signal), { name: 'AbortError' });
  });
});

describe('AES-128', () => {
  it('derives the default IV from the media sequence number', () => {
    assert.deepEqual([...sequenceIv(0)], new Array(16).fill(0));
    assert.deepEqual([...sequenceIv(258)].slice(-2), [1, 2]);
    assert.deepEqual([...sequenceIv(2 ** 40)].slice(-6), [1, 0, 0, 0, 0, 0]);
  });

  it('decrypts AES-128-CBC segments with the fetched key', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
    const plain = new TextEncoder().encode('segment payload that spans several AES blocks');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: sequenceIv(7) }, key, plain);

    const fetcher = createFetcher({ fetch: async () => response(rawKey) });
    const decrypt = createDecryptor(fetcher);
    const out = await decrypt(new Blob([cipher]), { method: 'AES-128', url: 'https://example.com/k', iv: null, keyFormat: 'identity' }, 7);
    assert.equal(await out.text(), new TextDecoder().decode(plain));
  });
});
