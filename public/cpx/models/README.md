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

| 파일 | 원본 | 개조 (2026-08-25 신체 비율 개혁) |
|---|---|---|
| patient_male.glb | Quaternius Ultimate Animated Character Pack — Casual_Male | glTF→GLB 패킹 → `reproportion_glb.py --spec adult_male` |
| patient_female.glb | 〃 Casual_Female | 패킹 → `--spec adult_female` |
| patient_male_old.glb | 〃 OldClassy_Male | 패킹 + 실크햇 프리미티브 제거 → `--spec adult_male` |
| patient_female_old.glb | 〃 OldClassy_Female | 패킹 + 실크햇 프리미티브 제거 → `--spec adult_female` |
| patient_male_child.glb | Casual_Male 원본 파생 | `--spec child` (학령기 ≈6등신) |
| patient_female_child.glb | Casual_Female 원본 파생 | `--spec child` |
| patient_male_infant.glb | Casual_Male 원본 파생 | `--spec infant` (걸음마기 ≈4등신) |
| patient_female_infant.glb | Casual_Female 원본 파생 | `--spec infant` |

원본 팩: https://quaternius.com/packs/ultimatedanimatedcharacter.html (팩 동봉 License.txt로 CC0 확인, 2026-07-08)

### 2026-08-25 신체 비율 개혁

원본 Quaternius 캐릭터는 2.7~2.9등신(머리가 신장의 35~37%, 가랑이 높이 30%, 몸통 33%)이라 누운 자세의
흉부·복부 시진/촉진/타진/청진 프레이밍이 부자연스러웠다. poly.pizza 의 CC0·CC-BY 인체 모델 66종을 계측해
실제 성인 비율에 가까운 레퍼런스(Character Base qbDLeTtb8K, Adventurer ZwF0K7WBmu, Woman wearing headset
Qy6esq7e1z, Animated Woman 9kF7eTDbhO, Character_Man IE7rk47BHn)의 관절 높이·폭·둘레 비율을 추출하고, 표준
인체측정(Drillis–Contini)과 대조해 목표 비율표(`scripts/avatar/reproportion_glb.py` SPECS)를 만들었다.
레퍼런스 모델의 **기하는 가져오지 않고 비율(수치)만** 이식했으므로 재질·리그·애니메이션·얼굴 데칼 앵커는
기존 Quaternius 자산 그대로다(라이선스 변동 없음).

- 이식 방식: 바인드 포즈 관절 재배치 + 본별 대각 스케일을 스킨 가중치로 블렌딩한 정점 워프, 법선·역바인드행렬·
  노드 translation·애니메이션 translation 트랙 갱신. 회전 트랙은 그대로라 Idle 등 17종 애니메이션이 그대로 재생된다.
- 재생성: `scripts/avatar/build_patients.sh` (개혁 전 원본은 커밋 37e7ee5 의 GLB를 `git show` 로 꺼내 사용).
- 계측: `scripts/avatar/measure_glb.py <glb>` — 등신비·가랑이 높이·흉부/복부/엉덩이 폭 등을 출력.
- 실측(머리카락 포함 신장 기준): 성인 남 6.1등신·여 6.5, 소아 4.9, 유아 3.5 (개혁 전 성인 2.7~2.9).
- 진찰 부위 비율표: 성인표(EXAM_REGION_FRAC)는 이미 실제 인체 비율값이라 유지, 소아·유아표만 새 관절 실측으로 재산정.
- 종전 소아/유아 본 스케일 수술(`tools/avatar/child_glb.py`, `toddler_glb.py`, 2026-08-02/08-11)은 이 개혁으로 대체됨.

상세 대장: 데스크톱 저장소 `~/Desktop/lecturelink-cpx/docs/asset-license-ledger.md`
