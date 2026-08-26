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
| `cand1_quaternius_woman.glb` | Animated Woman `qJ2gsTUBHL` | Quaternius · CC0 1.0 | 62본 · 24클립(`CharacterArmature\|Idle` 등) · `Head` 본 · `Skin` 재질 | 6.1등신. 머리색 갈색(#5a3a24)으로 변경(`--rules cand1_casual`). 같은 리그의 남성: Beach Character(=cand2), Business Man `JFrLIKqvCH`, Farmer `7pn3R6hPvE`, Worker `Yg2bQZO6Hj`, Adventurer `ZwF0K7WBmu` |
| `cand2_quaternius_man.glb` | Beach Character `DojKLcO34E` + 헤어: Hoodie Character `gKLBoRsyKe` | Quaternius · CC0 1.0 (둘 다) | 〃 | 6.1등신. 원본 민소매·반바지·샌들 → `--rules cand2_casual --donor gKLBoRsyKe.glb`: 반팔 티·긴바지(#3a4557, 다리 정점을 반바지 밑단 반경→발목 0.55배로 방사 확장한 스트레이트핏 통)·신발(#2e2a28), 헤어를 Hoodie Character 의 웨이브 볼륨 헤어로 이식(`hair_swap`)·갈색. (기존 `patient_male.glb` 헤어 이식(`hair_transplant`)도 시도했으나 부자연스럽다는 피드백으로 되돌림) |
| `cand3_ipoly3d_fitness_man.glb` | Fitness Character `KX8wzUxep8` | iPoly3D · CC0 1.0 | 리그 없음(정지 A포즈) | 8.0등신, 233KB. 같은 계열: 노인 남 `0UAcRHVAxA`, `eMOTyGEAxj`, `wnlFVKynES`. 원점이 x −1.49 치우쳐 `scripts/avatar/recenter_glb.py` 로 보정 |
| `cand4_rafael_mannequin.glb` | Rigged Character `yiQDOLP4Ry` | Rafael · CC0 1.0 | Mixamo 리그 52본 · 클립 1(`mixamo.com`) | 8.0등신 회색 마네킹(표준화 환자 더미 느낌). T포즈 기본, Idle 없음 |

- 2026-08-26 광택 조정: 후보 원본 재질이 `metallic 0.4 · roughness 0.27~0.41` 이라 빛 반사가 심해 후보 1·2 전 재질을
  사용자 지정값 `roughness 0.45 · metallic 0.15` 로(`--opts '{"matte":true,"roughness":0.45,"metallic":0.15}'`, 신장 변형 6종에도 반영).
- 2026-08-26 신장 변형: `cand1_quaternius_woman_{175,165,156}.glb`, `cand2_quaternius_man_{183,175,167}.glb` — 같은 비율로
  균일 스케일(`--rules touch --opts '{"height":1.83}'`), `asset.extras.heightM` 기록. 렌더러는 파일명 끝 `_NNN`(cm)을
  성인 렌더 키로 써서 눕기 좌표·진찰 카메라도 그 신장 기준으로 잡는다(`?avatarModel=cand2_quaternius_man_183`).
  접미사 없는 기본 파일은 종전대로 1.55m 정규화. 팔꿈치 +6%·겨드랑이 아래 상완 +5% 방사 보정(`arm_thicken`)도 함께 적용.
- 2026-08-25 피드백으로 후보 1·2(Quaternius 계열) 중심으로 디벨롭 중. 의복·헤어 규칙은 `restyle_outfit.py` `RULES`
  에 모델별로 두며, 본 지배(스킨 가중치) 기준으로 피부 삼각형을 바지/소매/신발 재질로 옮기고(상완은 축 위치 62% 까지 소매),
  `pants_tube` 로 다리 정점을 방사 확장해 바지 통을 만들며, `hair_swap` 으로 같은 리그 계열의 헤어 프리미티브를 이식한다.
  이 계열 GLB 의 바인드 공간은 z-up(cm) 이라 도구가 Head−Foot 방향으로 위 축을 자동 판정한다.
- 렌더러 대응(2026-08-25): `candidates/` 경로는 스키닝 실측 바운드로 정규화(아머처 노드 스케일 대응), Idle 클립은 `Idle` 또는 `…|Idle` 이름 매칭.
- 얼굴 데칼(눈 깜빡임·입)은 `Face` 재질 + `Head` 본을 요구 — 후보는 자체 눈·입 지오메트리를 가져 데칼 없이 표시된다.
- `Skin` 재질은 런타임 색 보정(#e8b89a)이 적용된다(cand1·2). 원래 피부톤을 쓰려면 `GLB_COLOR_FIX` 예외 처리 필요.
- 대안(미포함): 상의 탈의 남 `GorWw41SFf`·여 `NfMffTkeBa`(mastjie, CC0, 리그 없음), 속옷 차림 남 `07wMEaAf6x`(pessiuff, CC-BY 3.0), 텍스처 여성 `9kF7eTDbhO`(Quaternius, CC0, Mixamo 리그·`Armature|Idle`), 노인 `mED3MPaQ6i`(scaranto, CC0, 5.4등신).
