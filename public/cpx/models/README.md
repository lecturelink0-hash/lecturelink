# CPX 환자 3D 모델 (GLB)

`components/cpx/Avatar3D.jsx`가 케이스 페르소나(성별·나이)에 따라 자동 선택한다.
파일을 넣기만 하면 반영되며, 없으면 절차적 로우폴리 아바타로 폴백한다.

## 파일명 규약 (선택 우선순위)

| 파일 | 선택 조건 |
|---|---|
| `patient_{male\|female}_old.glb` | 나이 ≥ 60 (최우선) |
| `patient_{male\|female}_infant.glb` | 나이 ≤ 2 (18~24개월 걸음마기 체형, 최우선) |
| `patient_{male\|female}_child.glb` | 나이 ≤ 12 |
| `patient_{male\|female}.glb` | 성별 기본 |

소아 렌더 키는 나이대별(≤1세 0.82m / 2세 0.90m / 3세 0.95m / ≤8세 1.15m /
≤12세 1.30m)로 정규화되고, 보호자 동반 케이스(persona.child)는 환아+보호자
2인이 함께 선다.

## 출처·라이선스 (전부 CC0 1.0 — 표기 의무 없음, 상업적 사용·개조 자유)

| 파일 | 원본 | 개조 |
|---|---|---|
| patient_male.glb | Quaternius Ultimate Animated Character Pack — Casual_Male | glTF→GLB 패킹 |
| patient_female.glb | 〃 Casual_Female | glTF→GLB 패킹 |
| patient_male_old.glb | 〃 OldClassy_Male | 패킹 + 실크햇 프리미티브 제거 |
| patient_female_old.glb | 〃 OldClassy_Female | 패킹 + 실크햇 프리미티브 제거 |
| patient_male_child.glb | patient_male.glb 파생 | 소아 비율 본 스케일 수술: Head ×1.18, Shoulder.L/R ×0.85 (전 애니메이션 scale 트랙 포함) |
| patient_female_child.glb | patient_female.glb 파생 | 소아 비율 본 스케일 수술: Head ×1.26, Shoulder.L/R ×0.85 (〃) |
| patient_male_infant.glb | patient_male.glb 파생 | 유아(18~24개월) 비율 수술: Head ×1.00, Neck ×0.72, Shoulder ×0.75, Abdomen ×1.15(Torso 역보정), UpperLeg y×0.68·xz×0.86 + Body 본 하강 0.272 (전 애니 scale·translation 트랙 포함) |
| patient_female_infant.glb | patient_female.glb 파생 | 〃 (Head ×1.03) |

원본 팩: https://quaternius.com/packs/ultimatedanimatedcharacter.html (팩 동봉 License.txt로 CC0 확인, 2026-07-08)
소아 파생: 2026-08-02, 수술 스크립트는 데스크톱 저장소 `tools/avatar/child_glb.py` (다리·발 IK 본은 분리 위험이 있어 머리·어깨 체인만 조정).
유아 파생: 2026-08-11, 수술 스크립트는 데스크톱 저장소 `tools/avatar/toddler_glb.py` — 다리는 본 단축+Body 하강으로 처리(발 IK 본은 그대로, 지면 접점 유지). 실측 등신비: 남 2.31·여 2.42(머리카락 포함 메트릭, 소아 2.28·성인 2.52 대비). 초기안은 실제 18~24개월 4.5등신의 스타일 환산값(등신비 ~1.9, Head ×1.50)이었으나 사용자 피드백으로 머리를 2/3로 축소 확정 — 체형 구분은 짧은 다리·올챙이배·좁은 어깨·렌더 키(0.82m)가 담당.
상세 대장: 데스크톱 저장소 `~/Desktop/lecturelink-cpx/docs/asset-license-ledger.md`

## 신규 환자 모델 후보 (`candidates/`, 2026-08-25)

현행 모델이 2.7~2.9등신(머리가 신장의 35~37%)이라 누운 자세의 흉부·복부 진찰 프레이밍이 부자연스러워,
poly.pizza 의 상업 이용 가능 인체 모델 112종을 계측·검토해 실제 비율(6~8등신)의 후보 4종을 **원형 그대로** 넣었다.
`?avatarModel=<파일명>` 쿼리로 랜딩/CPX 화면에서 바로 미리 볼 수 있다 (예: `/?avatarModel=cand1_quaternius_woman`).
채택 시 `patient_{male|female}[_old|_child|_infant].glb` 규약으로 복사하면 된다.

| 파일 | 원본 (poly.pizza) | 제작자 · 라이선스 | 리그/애니 | 비고 |
|---|---|---|---|---|
| `cand1_quaternius_woman.glb` | Animated Woman `qJ2gsTUBHL` | Quaternius · CC0 1.0 | 62본 · 24클립(`CharacterArmature\|Idle` 등) · `Head` 본 · `Skin` 재질 | 6.1등신. 같은 리그의 남성: Beach Character(=cand2), Business Man `JFrLIKqvCH`, Farmer `7pn3R6hPvE`, Worker `Yg2bQZO6Hj`, Adventurer `ZwF0K7WBmu` |
| `cand2_quaternius_man.glb` | Beach Character `DojKLcO34E` | Quaternius · CC0 1.0 | 〃 | 6.1등신, 민소매·반바지라 흉부·복부 노출 진찰에 유리 |
| `cand3_ipoly3d_fitness_man.glb` | Fitness Character `KX8wzUxep8` | iPoly3D · CC0 1.0 | 리그 없음(정지 A포즈) | 8.0등신, 233KB. 같은 계열: 노인 남 `0UAcRHVAxA`, `eMOTyGEAxj`, `wnlFVKynES`. 원점이 x −1.49 치우쳐 `scripts/avatar/recenter_glb.py` 로 보정 |
| `cand4_rafael_mannequin.glb` | Rigged Character `yiQDOLP4Ry` | Rafael · CC0 1.0 | Mixamo 리그 52본 · 클립 1(`mixamo.com`) | 8.0등신 회색 마네킹(표준화 환자 더미 느낌). T포즈 기본, Idle 없음 |

- 렌더러 대응(2026-08-25): `candidates/` 경로는 스키닝 실측 바운드로 정규화(아머처 노드 스케일 대응), Idle 클립은 `Idle` 또는 `…|Idle` 이름 매칭.
- 얼굴 데칼(눈 깜빡임·입)은 `Face` 재질 + `Head` 본을 요구 — 후보는 자체 눈·입 지오메트리를 가져 데칼 없이 표시된다.
- `Skin` 재질은 런타임 색 보정(#e8b89a)이 적용된다(cand1·2). 원래 피부톤을 쓰려면 `GLB_COLOR_FIX` 예외 처리 필요.
- 대안(미포함): 상의 탈의 남 `GorWw41SFf`·여 `NfMffTkeBa`(mastjie, CC0, 리그 없음), 속옷 차림 남 `07wMEaAf6x`(pessiuff, CC-BY 3.0), 텍스처 여성 `9kF7eTDbhO`(Quaternius, CC0, Mixamo 리그·`Armature|Idle`), 노인 `mED3MPaQ6i`(scaranto, CC0, 5.4등신).
