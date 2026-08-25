# CPX 환자 3D 모델 신체 비율 개혁 (2026-08-25)

## 배경

현행 환자 GLB 8종은 Quaternius Ultimate Animated Character Pack(CC0)의 Casual/OldClassy 캐릭터로,
계측 결과 **2.7~2.9등신**(머리가 신장의 35~37%, 가랑이 높이 30%, 몸통 33%)이었다. 진찰 부위 비율표
(`EXAM_REGION_FRAC`: 목 .84·가슴 .70·복부 .55)는 실제 인체 기준이라, 눕힌 모델에서 '가슴' 카메라가
얼굴에 떨어지는 등 복부·흉부 시진/촉진/타진/청진 프레이밍이 부자연스러웠다.

## 접근

레퍼런스의 **기하가 아니라 비율(수치)만** 가져오고, 기존 Quaternius 리그·재질·애니메이션·얼굴 데칼을
그대로 유지한 채 본 단위로 비율을 이식했다(라이선스·런타임 코드 변동 최소화).

1. **레퍼런스 수집** — poly.pizza 검색 페이지(서버 렌더)에서 human/person/man/woman/character base 등
   103 ID → People & Characters 66종 GLB 내려받아 계측(`scripts/avatar/measure_glb.py`, 순수 Python,
   삼각형-평면 슬라이스 단면 기반). 결과: [polypizza-human-catalog.csv](polypizza-human-catalog.csv)
   (CC0 48·CC-BY 3.0 26; 41종 유효 계측, 나머지는 z-up/오프셋 모델로 계측 실패 표기).
2. **목표 비율표** — 실제 성인 비율에 가장 가까운 후보의 계측값을 표준 인체측정(Drillis–Contini)과 대조해
   `scripts/avatar/reproportion_glb.py` `SPECS`(adult_male / adult_female / child / infant)로 정리.

   | 레퍼런스 | 제작자 · 라이선스 | 등신비 | 가랑이 | 목 | 흉부폭 | 엉덩이폭 |
   |---|---|---|---|---|---|---|
   | Character Base `qbDLeTtb8K` | madtrollstudio · CC-BY 3.0 | 7.41 | .47 | .865 | .17 | .197 |
   | Adventurer `ZwF0K7WBmu` | Quaternius · CC0 | 7.41 | .50 | .865 | .16 | .184 |
   | Woman wearing headset `Qy6esq7e1z` | overscore_media · CC0 | 7.41 | .49 | .865 | .139 | .19 |
   | Animated Woman `9kF7eTDbhO` | Quaternius · CC0 | 6.06 | .48 | .835 | — | .195 |
   | Character_Man `IE7rk47BHn` (Mixamo 리그) | prathm · CC0 | 7.41 | .56 | .865 | 관절: 머리 .87·목 .84·어깨 .81·골반 .55~.58·무릎 .29·팔꿈치 .67·손목 .51 | |

3. **이식** — 바인드 포즈 관절 재배치 + 본별 대각 스케일(길이축은 자식 관절 목표에서 유도, 둘레축은
   목표 둘레/실측 둘레)을 스킨 가중치로 블렌딩한 정점 워프 `v' = Σ w_i (J_i' + A_i ⊙ (v − J_i))`.
   법선(야코비안 역전치)·역바인드행렬·노드 translation·애니메이션 translation 트랙을 갱신하고 회전 트랙은
   유지 → Idle 등 17종 애니메이션 그대로 재생. 머리 본은 균일 배율(성인 0.85·소아 0.95·유아 1.0).
4. **검증** — three.js 미리보기(정면/측면/눕기/소아)와 Next 랜딩 페이지 실제 로더로 육안 확인, 계측기로 수치 확인.

## 결과 (머리카락 포함 신장 기준 계측)

| 모델 | 등신비 전→후 | 가랑이 높이 | 목 높이 | 흉부폭 / 엉덩이폭 |
|---|---|---|---|---|
| 성인 남 | 2.67 → 6.06 | .29 → .50 | .63 → .84 | .19 / .19 |
| 성인 여 | 2.82 → 6.45 | .30 → .51 | .65 → .85 | .19 / .20 |
| 노인 남/여 | 2.9/2.8 → 6.1/6.5 | 성인과 동일 비율 | | |
| 소아(≈7세) | (본 수술판) → 4.9 | .49 | .80 | .18 / .19 |
| 유아(18~24개월) | (본 수술판) → 3.5 | .45 | .72 | .22 / .23 |

## 코드 변경

- `public/cpx/models/*.glb` 8종 재생성 (`scripts/avatar/build_patients.sh`, 원본은 커밋 37e7ee5).
- `components/cpx/Avatar3D.jsx` — `CHILD_EXAM_REGION_FRAC`, `INFANT_EXAM_REGION_FRAC` 값만 새 관절 실측으로 갱신.
  성인표·카메라·조명·얼굴 데칼·정규화 로직은 무변경.
- `scripts/avatar/` — `measure_glb.py`, `reproportion_glb.py`, `build_patients.sh` (의존성 없음, Python 3).

## 남은 항목 / 결정 대기

- 병원복(가운) 스타일링은 범위 밖 — 현행 캐주얼 의상 유지. 필요 시 `Shirt/Pants` 재질만 색 교체 가능.
- 유아 모델은 2026-08-11 사용자 피드백(머리 2/3 축소)이 있던 영역 — 이번엔 실제 18~24개월 비율(≈4등신)로
  재생성했으므로 육안 확인 후 `SPECS['infant']['head_scale']` 로 조정 가능.
- 손이 서 있을 때 가랑이 높이까지 내려와 실제(허벅지 중간)보다 약간 긺 — `x.Fist` 값(.445)을 .42로 줄이면 됨.
- 성인 진찰표는 유지했으나 실측 관절은 복부 관절 .61·골반 .52 — 복부 .55→.57, 골반 .45→.48 미세조정 여지.
- 다른 애니메이션(Walk/Run 등)은 IK 발 위치가 옛 비율 기준이라 재생 시 발 미끄러짐 가능(현재 Idle만 사용).
