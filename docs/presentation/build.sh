#!/bin/bash
# slides.html → PDF (ko / en / uz). macOS Chrome 필요.
#   AI-Bohuni_presentation_<lang>.pdf        발표자용 6쪽 (5쪽 + 발표자 노트)
#   AI-Bohuni_presentation_<lang>_share.pdf  공유용 5쪽 (노트 제외)
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
pdf() { "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=3000 \
  --print-to-pdf="$1" "file://$PWD/slides.html?$2" 2>/dev/null; }
for l in ko en uz; do
  pdf "AI-Bohuni_presentation_${l}.pdf" "lang=${l}"
  pdf "AI-Bohuni_presentation_${l}_share.pdf" "lang=${l}&notes=0"
done
ls -la *.pdf
