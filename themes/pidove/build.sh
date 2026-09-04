#!/usr/bin/env bash
# 캐릭터 시트 한 장 -> clawd-on-desk 테마. 한 방에.
#
#   ./build.sh source/pidove-sheet.png
#
set -euo pipefail
cd "$(dirname "$0")"

SHEET="${1:-source/pidove-sheet.png}"
OUT="${2:-build}"

if [ ! -f "$SHEET" ]; then
  echo "시트를 찾을 수 없습니다: $SHEET" >&2
  echo "캐릭터 시트 PNG 를 source/ 에 넣고 경로를 넘겨주세요." >&2
  exit 1
fi

python3 -c 'import PIL, numpy' 2>/dev/null || python3 -m pip install --quiet Pillow numpy

echo "[1/2] 스프라이트 추출"
python3 slice.py "$SHEET" -o sprites --debug

echo "[2/2] 애니메이션 + theme.json"
python3 animate.py sprites -o "$OUT"

echo
echo "완료: $OUT/theme.json"
echo "검증하려면: node <clawd-on-desk>/scripts/validate-theme.js $(pwd)/$OUT"
