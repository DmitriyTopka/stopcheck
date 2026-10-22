#!/bin/bash
set -e
V="$1"; FF=$(cat "$V/ffpath.txt"); D=(6 10 10 10 9 8); F=0.6; S=(s1 s2 s3 s4 s5 s6)
args=(); for i in 0 1 2 3 4 5; do args+=(-loop 1 -t "${D[$i]}" -i "$V/slides/${S[$i]}.png"); done
filter=""; prev="[0:v]"; cum=0
for k in 1 2 3 4 5; do cum=$(python3 -c "print($cum + ${D[$((k-1))]})"); off=$(python3 -c "print($cum - $k*$F)"); filter+="${prev}[$k:v]xfade=transition=fade:duration=$F:offset=$off[v$k];"; prev="[v$k]"; done
filter+="${prev}format=yuv420p[vout]"
"$FF" -y -loglevel error "${args[@]}" -filter_complex "$filter" -map "[vout]" -r 30 -c:v libx264 -preset slow -crf 20 -movflags +faststart "$V/stopcheck-demo.mp4"
"$FF" -i "$V/stopcheck-demo.mp4" 2>&1 | grep -E "Duration|Video:" || true
