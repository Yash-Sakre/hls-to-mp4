#!/usr/bin/env bash
# Generate the long HLS streams used by the benchmarks (test/bench/run.mjs).
# Requires a native ffmpeg with libx264.
#
#   bash test/bench/make-bench-samples.sh [minutes]     default: 20
set -euo pipefail

command -v ffmpeg >/dev/null || { echo "ffmpeg is required to generate benchmark samples" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/test/bench/.public"
MINUTES="${1:-20}"
DUR=$((MINUTES * 60))

rm -rf "$OUT/long-ts" "$OUT/long-fmp4"
mkdir -p "$OUT/long-ts" "$OUT/long-fmp4"

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# 1280x720 @ 25 fps, ~4 Mbps H.264 + 128 kbps AAC: noise keeps the encoder at
# its target bitrate, so segment sizes match real broadcast/CCTV content.
# 2 s GOPs, 6 s segments, EXT-X-PROGRAM-DATE-TIME on every segment, and the
# same flash + beep A/V sync markers as the e2e samples (every even second).
FLASH="drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n,50),0)'"
BEEP="volume=volume=0:enable='gte(mod(t,2),0.05)'"

echo "Generating ${MINUTES}-minute benchmark streams in $OUT"
echo "  long-ts    MPEG-TS, 720p H.264 4 Mbps + AAC, 6 s segments"
(cd "$OUT/long-ts" && ff \
  -f lavfi -i "testsrc2=size=1280x720:rate=25,noise=alls=12:allf=t,$FLASH" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:samples_per_frame=48,$BEEP" \
  -t "$DUR" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
  -b:v 4M -maxrate 4M -bufsize 8M -c:a aac -b:a 128k \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags program_date_time \
  -hls_segment_filename 'seg%04d.ts' index.m3u8)

echo "  long-fmp4  the same stream, stream-copied to fMP4/CMAF segments"
(cd "$OUT/long-fmp4" && ff -allowed_extensions ALL -i ../long-ts/index.m3u8 -c copy -bsf:a aac_adtstoasc \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'seg%04d.m4s' index.m3u8)

echo "Done."
