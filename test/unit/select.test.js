import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseMediaPlaylist } from '../../src/playlist.js';
import { groupIntoParts, selectSegments, toRangeBound } from '../../src/select.js';

const BASE = 'https://example.com/hls/index.m3u8';

// Six 4 s segments starting 2026-10-17T10:00:00Z.
const playlist = parseMediaPlaylist(
  `#EXTM3U
#EXT-X-PROGRAM-DATE-TIME:2026-10-17T10:00:00.000Z
${Array.from({ length: 6 }, (_, i) => `#EXTINF:4,\nseg${i}.ts`).join('\n')}
#EXT-X-ENDLIST`,
  BASE,
);
const names = (selection) => selection.segments.map((s) => s.url.split('/').pop());

describe('toRangeBound', () => {
  it('treats numbers as playlist offsets and dates as wall-clock times', () => {
    assert.deepEqual(toRangeBound(12.5, 'start'), { kind: 'offset', seconds: 12.5 });
    assert.deepEqual(toRangeBound(new Date('2026-10-17T10:00:00Z'), 'start'), {
      kind: 'wallclock',
      seconds: Date.UTC(2026, 9, 17, 10) / 1000,
    });
    assert.deepEqual(toRangeBound('2026-10-17T15:30:00+05:30', 'start'), {
      kind: 'wallclock',
      seconds: Date.UTC(2026, 9, 17, 10) / 1000,
    });
    // dayjs / moment / Luxon objects expose epoch ms through valueOf().
    assert.equal(toRangeBound({ valueOf: () => 1_792_000_000_000 }, 'start').seconds, 1_792_000_000);
    assert.equal(toRangeBound(undefined, 'start'), null);
  });

  it('rejects invalid values', () => {
    assert.throws(() => toRangeBound(-1, 'start'), { code: 'INVALID_RANGE' });
    assert.throws(() => toRangeBound('yesterday', 'end'), { code: 'INVALID_RANGE' });
    assert.throws(() => toRangeBound(NaN, 'end'), { code: 'INVALID_RANGE' });
  });
});

describe('selectSegments', () => {
  it('selects everything without a range', () => {
    const selection = selectSegments(playlist.segments, null, null);
    assert.equal(selection.segments.length, 6);
    assert.equal(selection.headTrim, 0);
    assert.equal(selection.tailTrim, 0);
    assert.equal(selection.duration, 24);
  });

  it('selects overlapping segments and computes trims for an offset range', () => {
    const selection = selectSegments(playlist.segments, toRangeBound(5, 'start'), toRangeBound(14, 'end'));
    assert.deepEqual(names(selection), ['seg1.ts', 'seg2.ts', 'seg3.ts']);
    assert.equal(selection.headTrim, 1);
    assert.equal(selection.tailTrim, 2);
    assert.equal(selection.duration, 9);
    assert.equal(selection.offsetStart, 5);
    assert.equal(selection.offsetEnd, 14);
  });

  it('does not include a segment that only touches the range edge', () => {
    const selection = selectSegments(playlist.segments, toRangeBound(4, 'start'), toRangeBound(8, 'end'));
    assert.deepEqual(names(selection), ['seg1.ts']);
    assert.equal(selection.duration, 4);
  });

  it('selects by wall-clock time using program date-time', () => {
    const selection = selectSegments(
      playlist.segments,
      toRangeBound(new Date('2026-10-17T10:00:10Z'), 'start'),
      toRangeBound('2026-10-17T10:00:18Z', 'end'),
    );
    assert.deepEqual(names(selection), ['seg2.ts', 'seg3.ts', 'seg4.ts']);
    assert.equal(selection.headTrim, 2);
    assert.equal(selection.tailTrim, 2);
    assert.equal(selection.duration, 8);
  });

  it('allows open-ended ranges', () => {
    assert.deepEqual(names(selectSegments(playlist.segments, toRangeBound(18, 'start'), null)), ['seg4.ts', 'seg5.ts']);
    assert.deepEqual(names(selectSegments(playlist.segments, null, toRangeBound(3, 'end'))), ['seg0.ts']);
  });

  it('rejects bad ranges with helpful errors', () => {
    assert.throws(() => selectSegments(playlist.segments, toRangeBound(10, 'start'), toRangeBound(10, 'end')), {
      code: 'INVALID_RANGE',
    });
    assert.throws(() => selectSegments(playlist.segments, toRangeBound(1, 'start'), toRangeBound(new Date(), 'end')), {
      code: 'INVALID_RANGE',
    });
    assert.throws(() => selectSegments(playlist.segments, toRangeBound(1_792_000_000, 'start'), null), {
      code: 'NO_SEGMENTS',
      message: /seconds from the start of the playlist/,
    });
    const noPdt = parseMediaPlaylist('#EXTM3U\n#EXTINF:4,\nseg0.ts\n', BASE);
    assert.throws(() => selectSegments(noPdt.segments, toRangeBound(new Date(), 'start'), null), {
      code: 'INVALID_RANGE',
      message: /PROGRAM-DATE-TIME/,
    });
  });
});

describe('groupIntoParts', () => {
  it('splits on discontinuities, init changes and skipped gap segments', () => {
    const { segments } = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-MAP:URI="a.mp4"
#EXTINF:4,
s0.m4s
#EXTINF:4,
s1.m4s
#EXT-X-MAP:URI="b.mp4"
#EXTINF:4,
s2.m4s
#EXT-X-DISCONTINUITY
#EXTINF:4,
s3.m4s
#EXT-X-GAP
#EXTINF:4,
s4.m4s
#EXTINF:4,
s5.m4s
`,
      BASE,
    );
    const selection = selectSegments(segments, null, null);
    const parts = groupIntoParts(selection.segments);
    assert.deepEqual(
      parts.map((p) => p.segments.map((s) => s.url.split('/').pop())),
      [['s0.m4s', 's1.m4s'], ['s2.m4s'], ['s3.m4s'], ['s5.m4s']],
    );
    assert.equal(selection.duration, 20, 'gap segments are left out of the output');
  });
});
