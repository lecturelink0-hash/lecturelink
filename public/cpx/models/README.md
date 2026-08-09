# CPX 환자 3D 모델 (GLB)

`components/cpx/Avatar3D.jsx`가 케이스 페르소나(성별·나이)에 따라 자동 선택한다.
파일을 넣기만 하면 반영되며, 없으면 절차적 로우폴리 아바타로 폴백한다.

## 파일명 규약 (선택 우선순위)

| 파일 | 선택 조건 |
|---|---|
| `patient_{male\|female}_old.glb` | 나이 ≥ 60 (최우선) |
| `patient_{male\|female}_child.glb` | 나이 ≤ 12 (최우선) |
| `patient_{male\|female}.glb` | 성별 기본 |

소아 렌더 키는 나이대별(≤3세 0.95m / ≤8세 1.15m / ≤12세 1.30m)로 정규화되고,
보호자 동반 케이스(persona.child)는 환아+보호자 2인이 함께 선다.

## 출처·라이선스 (전부 CC0 1.0 — 표기 의무 없음, 상업적 사용·개조 자유)

| 파일 | 원본 | 개조 |
|---|---|---|
| patient_male.glb | Quaternius Ultimate Animated Character Pack — Casual_Male | glTF→GLB 패킹 |
| patient_female.glb | 〃 Casual_Female | glTF→GLB 패킹 |
| patient_male_old.glb | 〃 OldClassy_Male | 패킹 + 실크햇 프리미티브 제거 |
| patient_female_old.glb | 〃 OldClassy_Female | 패킹 + 실크햇 프리미티브 제거 |
| patient_male_child.glb | patient_male.glb 파생 | 소아 비율 본 스케일 수술: Head ×1.18, Shoulder.L/R ×0.85 (전 애니메이션 scale 트랙 포함) |
| patient_female_child.glb | patient_female.glb 파생 | 소아 비율 본 스케일 수술: Head ×1.26, Shoulder.L/R ×0.85 (〃) |

원본 팩: https://quaternius.com/packs/ultimatedanimatedcharacter.html (팩 동봉 License.txt로 CC0 확인, 2026-07-08)
소아 파생: 2026-08-02, 수술 스크립트는 데스크톱 저장소 `tools/avatar/child_glb.py` (다리·발 IK 본은 분리 위험이 있어 머리·어깨 체인만 조정).
상세 대장: 데스크톱 저장소 `~/Desktop/lecturelink-cpx/docs/asset-license-ledger.md`
