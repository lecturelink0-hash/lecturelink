# LectureLink CPX patient engine

LectureLink의 `/api/cpx/*` 프록시가 호출하는 FastAPI 서비스입니다. 243개 CPX 증례, 54개 canonical 루브릭, 신체진찰 온톨로지와 결정론적 채점 엔진을 이 저장소 안에 함께 보관합니다.

`data/cpx` 아래 파일이 전부 런타임에 쓰이는 것은 아닙니다. 실제로 적재되는 것은 `ai_patient_common_prompt.md`, `low_compliance_behaviors.json`, `canonical_rubric.*.json` 54개, 증례 243개뿐이고 나머지는 콘텐츠 작성·검수용 원자료여서 `.dockerignore`로 운영 이미지에서 제외합니다. 그 구분은 `server/test_data_manifest.py`가 강제하므로, 새 데이터 파일은 코드가 읽게 하거나 제외 목록에 올리거나 둘 중 하나를 해야 합니다.

## Docker 실행

저장소 루트에서 실행합니다.

```bash
docker build -t lecturelink-cpx ./services/cpx
cp services/cpx/.env.example services/cpx/.env
# services/cpx/.env에 GEMINI_API_KEY와 CPX_PROXY_SHARED_SECRET을 입력
docker run --rm -p 8787:8787 --env-file services/cpx/.env \
  -v lecturelink-cpx-data:/data lecturelink-cpx
```

상태 확인:

```bash
curl http://127.0.0.1:8787/api/health
```

LectureLink 저장소 루트에서는 인증 경계와 전체 증례 수까지 한 번에 확인할 수 있습니다.

```bash
CPX_BACKEND_URL=http://127.0.0.1:8787 \
CPX_PROXY_SHARED_SECRET=<동일한-공유-시크릿> \
npm run cpx:smoke
```

Next.js 빌드 후 서버 전용 시크릿 이름이나 값이 브라우저 정적 번들에 섞이지 않았는지도 확인합니다.

```bash
npm run build
npm run cpx:bundle-check
```

## 운영 연결

1. 이 디렉터리를 Docker context로 배포합니다.
2. 컨테이너는 MVP 동안 단일 replica로 실행하고 `/data`에 영속 볼륨을 연결합니다. 활성 세션은 SQLite를 사용하므로 여러 replica로 수평 확장하면 안 됩니다.
3. FastAPI와 LectureLink 양쪽에 동일한 `CPX_PROXY_SHARED_SECRET`을 설정합니다.
4. FastAPI에는 `REQUIRE_LECTURELINK_AUTH=true`, `CPX_RELEASE_READY_ONLY=false`를 설정합니다.
5. LectureLink에는 `CPX_BACKEND_URL=https://<cpx-service-host>`와 `CPX_PERSIST_TO_SUPABASE=true`를 설정합니다.
6. `supabase/migrations/00022_cpx_sessions.sql`을 먼저 적용합니다. 완료 기록과 결과 조회는 Supabase가 담당하므로 컨테이너가 재시작되어도 사용자의 점수 기록이 유지됩니다.

`CPX_RELEASE_READY_ONLY=false`는 임상 검수를 출품 이후로 유예한 MVP 결정입니다. 임상 승인 전 콘텐츠를 진료 지침이나 검증된 평가 도구로 취급하면 안 됩니다.

현재 검수 상태 분포는 `codex_reviewed` 209건 · `needs_clinical_review` 34건이고, 릴리스 허용 상태(`user_approved`·`release_ready`)는 0건입니다. 따라서 **지금 이 스위치를 `true`로 켜면 목록이 통째로 빕니다.** 그렇게 뜬 서비스는 학생에게 "증례 없음"으로만 보이므로, 서버는 그 조합을 감지하면 조용히 빈 목록을 내주는 대신 기동에 실패합니다(`main._assert_release_gate_is_usable`). 켤 수 있으려면 먼저 증례에 `contentStatus: user_approved`를 부여해야 합니다. 게이트를 꺼 둔 동안의 검수 잔량은 `/api/cases` 응답의 `contentStatusCounts`로 확인합니다.

## 검증

```bash
cd services/cpx/server
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python -m py_compile main.py evaluate.py scoring.py
venv/bin/python test_scoring.py
venv/bin/python test_all_cases.py
venv/bin/python test_all_cases_api.py
venv/bin/python test_lecturelink_auth.py
venv/bin/python test_prompt_context.py
venv/bin/python test_metrics.py
venv/bin/python test_diagnosis_hidden.py     # 진단명·증례 메타데이터가 환자 프롬프트에 없는가
venv/bin/python test_patient_rules.py        # 환자 프롬프트 규칙 전수 + 불가능한 출력 형식 지시 부재
venv/bin/python test_violation_contract.py   # 임상예의 위반 계약이 세 겹 모두 같은 방향인가
venv/bin/python test_release_gate.py         # 릴리스 스위치가 쓸 수 있는 상태인가
venv/bin/python test_data_manifest.py        # 배포 이미지에 런타임이 안 읽는 데이터가 없는가
venv/bin/python repeatability.py --selftest
```

## 운영 성능 계측 (성능지표 가이드 1단계)

모든 `/api/*` 요청은 `request_metrics` 에 1행씩 남습니다 — request_id, 기능, 버전, 단계별 시간,
결과 상태, 오류 코드, 스키마 준수 여부. 턴 응답시간은 클라이언트가 재서 `turn_metrics` 로 보냅니다.
집계는 관리자만 볼 수 있습니다.

```bash
# 대시보드: LectureLink 관리자 계정으로 /admin/cpx-metrics
# API 직접 조회 (프록시 공유 시크릿 + 관리자 헤더 둘 다 필요)
curl -H "x-lecturelink-user-id: <admin-user-id>" \
     -H "x-cpx-proxy-secret: <공유-시크릿>" \
     -H "x-cpx-admin: 1" \
     "http://127.0.0.1:8787/api/metrics/summary?days=7"
```

채점 반복 안정성(가이드 §4.2, 최소 10회)은 실제 모델 호출이 필요합니다.

```bash
GEMINI_API_KEY=... venv/bin/python repeatability.py --runs 10 \
  --out ../../../outputs/cpx-repeatability.json
```

측정 정의와 해석 기준은 `docs/cpx-phase1-metrics.md` 를 봅니다.
