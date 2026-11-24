#!/bin/bash
# 미리보기 PNG (쪽별) — 사용: ./shots.sh <출력폴더>
OUT="$1"; mkdir -p "$OUT"; cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for l in ko en uz; do for i in 1 2 3 4 5 6; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,720 \
    --screenshot="$OUT/${l}_$i.png" "file://$PWD/slides.html?lang=$l&page=$i" 2>/dev/null
done; done
