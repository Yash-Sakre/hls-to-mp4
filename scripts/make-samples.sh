#!/usr/bin/env bash
# Generate local HLS test streams covering the playlist features hls-to-mp4
# supports. Used by the demo (`npm run demo`) and the browser tests
# (`npm run test:e2e`). Requires a native ffmpeg with libx264/libx265.
#
#   npm run samples [-- <output-dir>]     default: demo/public/samples
set -euo pipefail

command -v ffmpeg >/dev/null || { echo "ffmpeg is required to generate samples" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/demo/public/samples}"
rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

DUR=24
# A/V sync markers: a one-frame white flash and a 50 ms 1 kHz beep at every
# even second (the e2e tests measure their offset in each exported file).
FLASH="drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n,50),0)'"
BEEP="volume=volume=0:enable='gte(mod(t,2),0.05)'"
SRC=(-f lavfi -i "testsrc2=size=640x360:rate=25,$FLASH" -f lavfi -i "sine=frequency=1000:sample_rate=48000:samples_per_frame=48,$BEEP")
# 2 s GOPs, 4 s segments.
X264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 -b:v 600k)
AAC=(-c:a aac -b:a 96k)
HLS=(-f hls -hls_time 4 -hls_playlist_type vod)
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
hex16() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
step() { printf '  %-10s %s\n' "$1" "$2"; }

echo "Generating HLS samples in $OUT"

step ts "MPEG-TS, H.264 + AAC, EXT-X-PROGRAM-DATE-TIME"
mkdir ts && (cd ts && ff "${SRC[@]}" -t $DUR "${X264[@]}" "${AAC[@]}" "${HLS[@]}" \
  -hls_flags program_date_time -hls_segment_filename 'seg%03d.ts' index.m3u8)

step fmp4 "fMP4 (CMAF) segments with EXT-X-MAP"
mkdir fmp4 && (cd fmp4 && ff "${SRC[@]}" -t $DUR "${X264[@]}" "${AAC[@]}" "${HLS[@]}" \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'seg%03d.m4s' index.m3u8)

step mp2 "MPEG-TS with MP2 audio (transcoded to AAC on export)"
mkdir mp2 && (cd mp2 && ff "${SRC[@]}" -t $DUR "${X264[@]}" -c:a mp2 -b:a 128k "${HLS[@]}" \
  -hls_segment_filename 'seg%03d.ts' index.m3u8)

step aes "AES-128, IV from the media sequence number"
mkdir aes && (cd aes && head -c 16 /dev/urandom > enc.key && printf 'enc.key\nenc.key\n' > keyinfo \
  && ff "${SRC[@]}" -t $DUR "${X264[@]}" "${AAC[@]}" "${HLS[@]}" -hls_key_info_file keyinfo \
     -hls_segment_filename 'seg%03d.ts' index.m3u8 && rm keyinfo \
  && sed 's/,IV=0x[0-9a-fA-F]*//' index.m3u8 > index.tmp && mv index.tmp index.m3u8)
# ffmpeg always writes IV=<sequence number>; dropping it exercises the default IV.

step aes-iv "AES-128 with an explicit IV"
mkdir aes-iv && (cd aes-iv && head -c 16 /dev/urandom > enc.key && printf 'enc.key\nenc.key\n%s\n' "$(hex16)" > keyinfo \
  && ff "${SRC[@]}" -t $DUR "${X264[@]}" "${AAC[@]}" "${HLS[@]}" -hls_key_info_file keyinfo \
     -hls_segment_filename 'seg%03d.ts' index.m3u8 && rm keyinfo)

step byterange "single file addressed with EXT-X-BYTERANGE"
mkdir byterange && (cd byterange && ff "${SRC[@]}" -t $DUR "${X264[@]}" "${AAC[@]}" "${HLS[@]}" \
  -hls_flags single_file index.m3u8)

step multi "master playlist, 640x360 + 320x180 variants"
mkdir multi && (cd multi && ff "${SRC[@]}" -t $DUR \
  -filter_complex "[0:v]split=2[hi][lo0];[lo0]scale=320:180[lo]" \
  -map "[hi]" -map 1:a -map "[lo]" -map 1:a "${X264[@]}" -b:v:0 800k -b:v:1 250k "${AAC[@]}" "${HLS[@]}" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0 v:1,a:1" -hls_segment_filename 'v%v/seg%03d.ts' 'v%v/index.m3u8')

step altaudio "master playlist with a separate audio rendition (fMP4)"
mkdir altaudio && (cd altaudio && ff "${SRC[@]}" -t $DUR -map 0:v -map 1:a "${X264[@]}" "${AAC[@]}" "${HLS[@]}" \
  -hls_segment_type fmp4 -hls_fmp4_init_filename 'init.mp4' -master_pl_name master.m3u8 \
  -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes,language:en,name:English" \
  -hls_segment_filename 's%v/seg%03d.m4s' 's%v/index.m3u8')

step disc "two recordings joined with EXT-X-DISCONTINUITY"
mkdir -p disc/a disc/b
(cd disc/a && ff "${SRC[@]}" -t 12 "${X264[@]}" "${AAC[@]}" "${HLS[@]}" -hls_segment_filename 'seg%03d.ts' index.m3u8)
(cd disc/b && ff -f lavfi -i "smptebars=size=640x360:rate=25,$FLASH" -f lavfi -i "sine=frequency=1000:sample_rate=48000:samples_per_frame=48,$BEEP" -t 12 \
  "${X264[@]}" "${AAC[@]}" -output_ts_offset 1000 "${HLS[@]}" -hls_segment_filename 'seg%03d.ts' index.m3u8)
{
  printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n'
  awk '/^#EXTINF/ {print; next} !/^#/ {print "a/" $0}' disc/a/index.m3u8
  printf '#EXT-X-DISCONTINUITY\n'
  awk '/^#EXTINF/ {print; next} !/^#/ {print "b/" $0}' disc/b/index.m3u8
  printf '#EXT-X-ENDLIST\n'
} > disc/index.m3u8

step hevc "MPEG-TS, HEVC + AAC (exported with the hvc1 tag)"
mkdir hevc && (cd hevc && ff "${SRC[@]}" -t $DUR -c:v libx265 -preset ultrafast -pix_fmt yuv420p \
  -x265-params "keyint=50:min-keyint=50:scenecut=0:log-level=error" -b:v 600k "${AAC[@]}" "${HLS[@]}" \
  -hls_segment_filename 'seg%03d.ts' index.m3u8)

step noaudio "video only"
mkdir noaudio && (cd noaudio && ff -f lavfi -i "testsrc2=size=640x360:rate=25,$FLASH" -t $DUR "${X264[@]}" -an "${HLS[@]}" \
  -hls_segment_filename 'seg%03d.ts' index.m3u8)

cat > index.json <<'JSON'
[
  { "id": "ts", "label": "MPEG-TS · H.264 + AAC · program date-time", "url": "samples/ts/index.m3u8" },
  { "id": "fmp4", "label": "fMP4 / CMAF segments", "url": "samples/fmp4/index.m3u8" },
  { "id": "mp2", "label": "MP2 audio (transcoded to AAC)", "url": "samples/mp2/index.m3u8" },
  { "id": "aes", "label": "AES-128 encrypted", "url": "samples/aes/index.m3u8" },
  { "id": "aes-iv", "label": "AES-128 with explicit IV", "url": "samples/aes-iv/index.m3u8" },
  { "id": "byterange", "label": "Byte-range segments (single file)", "url": "samples/byterange/index.m3u8" },
  { "id": "multi", "label": "Master playlist · two variants", "url": "samples/multi/master.m3u8" },
  { "id": "altaudio", "label": "Separate audio rendition (fMP4)", "url": "samples/altaudio/master.m3u8" },
  { "id": "disc", "label": "Discontinuity between two recordings", "url": "samples/disc/index.m3u8" },
  { "id": "hevc", "label": "HEVC / H.265", "url": "samples/hevc/index.m3u8" },
  { "id": "noaudio", "label": "Video only", "url": "samples/noaudio/index.m3u8" }
]
JSON

echo "Done."
