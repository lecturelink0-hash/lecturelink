# LectureLink CPX patient engine

LectureLink의 `/api/cpx/*` 프록시가 호출하는 FastAPI 서비스입니다. 197개 CPX 증례, 53개 canonical 루브릭, 신체진찰 온톨로지와 결정론적 채점 엔진을 이 저장소 안에 함께 보관합니다.

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
