#!/usr/bin/env bash
# 개혁 전 원본(Quaternius Casual/OldClassy 패킹본, 커밋 37e7ee5)에서 환자 GLB 8종을 재생성한다.
# usage: scripts/avatar/build_patients.sh [out_dir]   (기본 public/cpx/models)
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC_COMMIT=${SRC_COMMIT:-37e7ee5}
OUT=${1:-public/cpx/models}
TMP=$(mktemp -d)
for g in male female; do
  git show "$SRC_COMMIT:public/cpx/models/patient_${g}.glb" > "$TMP/patient_${g}.glb"
  git show "$SRC_COMMIT:public/cpx/models/patient_${g}_old.glb" > "$TMP/patient_${g}_old.glb"
  python3 scripts/avatar/reproportion_glb.py "$TMP/patient_${g}.glb"     "$OUT/patient_${g}.glb"        --spec adult_${g} --report "$TMP/${g}.json"
  python3 scripts/avatar/reproportion_glb.py "$TMP/patient_${g}_old.glb" "$OUT/patient_${g}_old.glb"    --spec adult_${g} --report "$TMP/${g}_old.json"
  python3 scripts/avatar/reproportion_glb.py "$TMP/patient_${g}.glb"     "$OUT/patient_${g}_child.glb"  --spec child        --report "$TMP/${g}_child.json"
  python3 scripts/avatar/reproportion_glb.py "$TMP/patient_${g}.glb"     "$OUT/patient_${g}_infant.glb" --spec infant       --report "$TMP/${g}_infant.json"
done
echo "reports: $TMP"
