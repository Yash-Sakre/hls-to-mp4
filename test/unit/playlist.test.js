import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMasterPlaylist,
  parseAttributes,
  parseDateTime,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickAudioRendition,
  pickVariant,
} from '../../src/playlist.js';

const BASE = 'https://cdn.example.com/vod/stream/index.m3u8';

describe('parseAttributes', () => {
  it('handles quoted values containing commas', () => {
    assert.deepEqual(parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360'), {
      BANDWIDTH: '1280000',
      CODECS: 'avc1.4d401f,mp4a.40.2',
      RESOLUTION: '640x360',
    });
  });
});

describe('parseDateTime', () => {
  it('accepts the offset forms packagers emit', () => {
    const expected = Date.UTC(2026, 9, 17, 4, 30, 0, 500);
    for (const value of ['2026-10-17T10:00:00.500+05:30', '2026-10-17T10:00:00.500+0530', '2026-10-17T04:30:00.500Z']) {
      assert.equal(parseDateTime(value), expected, value);
    }
    assert.equal(parseDateTime('2026-10-17T09:30:00.500+05'), expected);
    assert.ok(Number.isNaN(parseDateTime('not a date')));
  });
});

describe('parseMasterPlaylist', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="French",LANGUAGE="fr",URI="audio/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aac"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac",FRAME-RATE=25
hi/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"
`;

  it('detects master playlists', () => {
    assert.equal(isMasterPlaylist(master), true);
    assert.equal(isMasterPlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), false);
  });

  it('parses variants and audio renditions with resolved URLs', () => {
    const { variants, audioRenditions } = parseMasterPlaylist(master, BASE);
    assert.equal(variants.length, 2);
    assert.deepEqual(variants[1], {
      url: 'https://cdn.example.com/vod/stream/hi/index.m3u8',
      bandwidth: 2500000,
      averageBandwidth: null,
      resolution: { width: 1280, height: 720 },
      codecs: 'avc1.64001f,mp4a.40.2',
      frameRate: 25,
      audioGroup: 'aac',
    });
    assert.equal(audioRenditions.length, 2);
    assert.equal(audioRenditions[0].url, 'https://cdn.example.com/vod/stream/audio/en.m3u8');
    assert.equal(audioRenditions[0].default, true);
  });

  it('picks variants by preference', () => {
    const { variants, audioRenditions } = parseMasterPlaylist(master, BASE);
    assert.equal(pickVariant(variants).bandwidth, 2500000);
    assert.equal(pickVariant(variants, 'lowest').bandwidth, 800000);
    assert.equal(pickVariant(variants, (vs) => vs.find((v) => v.resolution.height === 360)).bandwidth, 800000);
    assert.throws(() => pickVariant(variants, 'best'), TypeError);
    assert.equal(pickAudioRendition(audioRenditions, 'aac').language, 'en');
    assert.equal(pickAudioRendition(audioRenditions, null), null);
  });
});

describe('parseMediaPlaylist', () => {
  it('parses a TS playlist with offsets and sequence numbers', () => {
    const playlist = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
#EXTINF:2.5,
seg2.ts
#EXT-X-ENDLIST
`,
      BASE,
    );
    assert.equal(playlist.segments.length, 3);
    assert.equal(playlist.duration, 10.5);
    assert.equal(playlist.endList, true);
    assert.equal(playlist.playlistType, 'VOD');
    assert.deepEqual(
      playlist.segments.map((s) => [s.start, s.sequence, s.url.split('/').pop()]),
      [
        [0, 100, 'seg0.ts'],
        [4, 101, 'seg1.ts'],
        [8, 102, 'seg2.ts'],
      ],
    );
  });

  it('tracks init sections, keys, byte ranges, discontinuities and gaps', () => {
    const { segments } = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0102
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
media.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:500
media.mp4
#EXT-X-KEY:METHOD=NONE
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="init2.mp4"
#EXTINF:4,
other.m4s
#EXT-X-GAP
#EXTINF:4,
missing.m4s
#EXT-X-ENDLIST
`,
      BASE,
    );
    assert.deepEqual(segments[0].init, { url: 'https://cdn.example.com/vod/stream/init.mp4', byteRange: { length: 720, offset: 0 }, key: null });
    assert.deepEqual(segments[0].byteRange, { length: 1000, offset: 720 });
    assert.deepEqual(segments[1].byteRange, { length: 500, offset: 1720 }, 'offset continues from the previous sub-range');
    assert.equal(segments[0].key.method, 'AES-128');
    assert.equal(segments[0].key.iv[15], 2);
    assert.equal(segments[0].key.iv[14], 1);
    assert.equal(segments[2].key, null);
    assert.equal(segments[2].discontinuity, true);
    assert.equal(segments[2].init.url, 'https://cdn.example.com/vod/stream/init2.mp4');
    assert.equal(segments[3].gap, true);
  });

  it('prefers the clear-key AES-128 tag when several key systems are listed', () => {
    const { segments } = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
seg0.ts
`,
      BASE,
    );
    assert.equal(segments[0].key.method, 'AES-128');
    assert.equal(segments[0].key.keyFormat, 'identity');
  });

  it('fills program date-time forwards and backwards', () => {
    const { segments, hasProgramDateTime } = parseMediaPlaylist(
      `#EXTM3U
#EXTINF:4,
seg0.ts
#EXT-X-PROGRAM-DATE-TIME:2026-10-17T10:00:04.000Z
#EXTINF:4,
seg1.ts
#EXTINF:4,
seg2.ts
`,
      BASE,
    );
    assert.equal(hasProgramDateTime, true);
    assert.deepEqual(
      segments.map((s) => new Date(s.programDateTime).toISOString()),
      ['2026-10-17T10:00:00.000Z', '2026-10-17T10:00:04.000Z', '2026-10-17T10:00:08.000Z'],
    );
  });

  it('rejects an offset-less byte range with no previous sub-range', () => {
    assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:500\nmedia.ts\n', BASE), {
      code: 'INVALID_PLAYLIST',
    });
  });
});
