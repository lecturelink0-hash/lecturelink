# Medical AI Learning Engine — Backend

의료 교육 특화 AI 학습 인프라의 백엔드 + API 레이어.

## 기술 스택

| 계층 | 기술 |
|------|------|
| Framework | Next.js 15 (App Router) |
| DB · Auth · Storage | Supabase (PostgreSQL + pgvector) |
| AI | Anthropic Claude (Sonnet 4.6 + Haiku 4.5) |
| Hosting | Vercel |
| Type System | TypeScript 5.6 (strict) |
| Validation | Zod |

## 디렉토리 구조

```
backend/
├── app/                          # Next.js App Router
│   └── api/                      # API 엔드포인트 (Checkpoint 2+에서 추가)
├── lib/
│   ├── ai/                       # Anthropic 클라이언트, 프롬프트 (Checkpoint 3)
│   ├── db/                       # Supabase 클라이언트 (Checkpoint 2)
│   ├── types/
│   │   ├── database.ts           # DB row 타입 (스키마 1:1)
│   │   └── domain.ts             # 비즈니스 도메인 타입
│   └── utils/                    # 공통 유틸리티
├── supabase/
│   └── migrations/
│       └── 00001_initial_schema.sql   # 초기 DB 스키마
├── .env.example                  # 환경변수 명세
├── .gitignore
├── next.config.js
├── package.json
├── tsconfig.json
└── README.md
```

## 데이터 모델 핵심

| 테이블 | 역할 |
|--------|------|
| `schools` | 학교 마스터 |
| `subjects` | 과목 (호흡기·순환기·...) |
| `sub_topics` | sub-topic (호흡 생리·폐쇄성 폐질환·...) + 위험 영역 플래그 |
| `users` | 사용자 (Supabase auth 확장) |
| `cohorts` | 학교 + 학년 + 학기 + 과목 단위 |
| `questions` | 문항 풀 (Curated / Community / Beta 3단 tier) |
| `cohort_sub_topic_scores` | **학교 코호트 학습의 핵심** — sub-topic별 포함 점수 |
| `user_attempts` | 풀이 기록 |
| `out_of_scope_feedback` | "시험 범위 아니에요" 클릭 |
| `user_weak_areas` | 약점 자동 분류 결과 |
| `user_uploads` / `private_questions` | Track A (내 강의 노트) |
| `subscriptions` / `usage_quotas` | 결제 및 사용량 캡 |

## 진행 상황

- [x] **Checkpoint 1** — 프로젝트 구조 + DB 스키마 + 타입 정의
- [x] **Checkpoint 2** — Supabase 클라이언트 + 인증 + 사용자 / 코호트 API
- [x] **Checkpoint 3** — Anthropic 클라이언트 + 문항 생성 파이프라인
- [x] **Checkpoint 4** — 추천 엔진 (bandit) + 임베딩 + 풀이 기록
- [x] **Checkpoint 5** — "시험 범위 아니에요" 피드백 + 코호트 학습
- [x] **Checkpoint 6** — Track A 파일 업로드 + Private 문항 생성
- [x] **Checkpoint 7** — 결제 (토스페이먼츠) + 사용량 캡
- [x] **Checkpoint 8** — Next.js 프론트엔드 (Tailwind v4 + 인증 + 4개 핵심 페이지)
- [x] **Checkpoint 9 (P0)** — 보안 강화: webhook 검증 필수, admin role, AI 비용 캡, SSRF 차단
- [x] **Checkpoint 10 (P1-A)** — PPT/PDF 강의록 OCR 파이프라인 (crop · Tesseract/Claude · 의학 사전)
- [x] **Checkpoint 11 (P1-B)** — 오픈 라이선스 의료 이미지 풀 + 문항 생성 + 라이선스 자동 표기
- [x] **Checkpoint 12 (P2/P3)** — 미들웨어 게이트, 자동화 cron, 디자인/문서 정리

## CPX 통합 서비스

CPX 화면과 로그인 프록시는 Next.js 앱에 포함되며, Gemini Live 환자·신체진찰·채점 엔진은 [`services/cpx`](services/cpx)에서 같은 저장소의 Docker 서비스로 배포합니다. 따라서 별도의 비공개 CPX 소스 저장소가 필요하지 않습니다.

- `/cpx` — 음성·텍스트 문진, 1차 chibi 환자, 부위별 신체진찰, 채점 결과
- `/cpx/history` — Supabase에 저장된 사용자별 완료 기록
- `services/cpx` — 197개 증례와 53개 루브릭을 포함한 FastAPI 서비스
- `supabase/migrations/00022_cpx_sessions.sql` — 사용자별 CPX 기록 및 RLS

배포 순서는 [`services/cpx/README.md`](services/cpx/README.md)를 따릅니다.

## ⚠️ 마이그레이션 경고

- **00004_embedding_dim.sql** 은 `questions.embedding` 을 `vector(1536) → vector(1024)` 로 재생성합니다 (OpenAI text-embedding-3-small → Voyage `voyage-3` 기준). 운영 DB 에 기존 임베딩 데이터가 있는 상태에서 적용하면 컬럼 자체가 drop+add 되므로 **모든 기존 임베딩이 소실됩니다.** 안전한 경로:
  - 빈 DB 또는 시드만 있는 환경에서 적용 (가장 안전).
  - 운영 DB 라면 적용 전에 (a) `questions.embedding` 전수 export, (b) 적용 후 `VOYAGE_API_KEY` 로 Voyage `voyage-3` (1024-dim) 으로 **재계산 + 재삽입** 동반 필요.
  - 차원이 안 맞으면 `match_questions` RPC 가 `pgvector` 차원 불일치 에러로 실패합니다.
- **00010_open_images.sql** 의 `open_images.embedding` 도 `vector(1024)` 로 정의돼 있어 `00004` 와 동일한 Voyage `voyage-3` (env: `VOYAGE_EMBED_MODEL`, `VOYAGE_EMBED_DIM=1024`) 기준이어야 일관됩니다. 다른 모델/차원으로 인제스트하면 `match_open_images` RPC 가 동일한 사유로 실패합니다.
- **00011_automation_cron_triggers.sql** 은 `pg_cron` 확장이 필요합니다. Supabase managed 에서는 대시보드 → Database → Extensions 에서 활성화 후 적용하세요.
- **00015_lock_sensitive_rpc_privileges.sql** 적용 후에는 anon / authenticated 가 quota / payment / cohort / embedding RPC 를 직접 호출할 수 없습니다. 클라이언트 측 코드에서 `.rpc(...)` 호출을 추가하기 전에 반드시 서버 API 라우트 + `createAdminClient` 경유로 설계하세요.

## 데이터베이스 타입 구조

- **`lib/types/database.ts`** — 앱이 import 하는 wrapper (수동 관리). `Database` 인터페이스 + alias (`PlanTier`, `GradeLevel`, `UserRow`, ...) + helper(`Insert<T>`, `Update<T>`) 정의.
- **`lib/types/database.generated.ts`** — `npm run db:types` 가 생성하는 raw 출력 (Docker + Supabase 로컬 필요). 직접 수정 금지.

`db:types` 는 `database.generated.ts` 에만 쓰므로 wrapper(`database.ts`) 가 덮어쓰지 않습니다. 앱 코드는 항상 `@/lib/types/database` 에서 import 합니다.

### Generated 로 전환하는 방법 (Docker / Supabase 로컬 준비 후)

전환 전에 [`docs/database-type-transition-checklist.md`](docs/database-type-transition-checklist.md) 를 먼저 읽으세요. wrapper ↔ migrations ↔ 실 사용 코드의 사전 점검 결과와 예상 수정 후보가 정리돼 있습니다.

아래 검증 순서는 본 README 하단 "⚠️ tsc --noEmit 와 .next/types 의 관계" 원칙을 따릅니다. `.next` 가 없는 상태에서 단독 `tsc --noEmit` 을 먼저 돌리면 TS6053 이 나므로, **반드시 `build:clean` 으로 `.next/types` 를 만든 뒤 `tsc --noEmit`** 을 실행하세요.

1. `npm run db:types` (또는 원격: `npm run db:types:linked`) 실행.
2. `lib/types/database.generated.ts` 가 새로 생겼는지 확인.
   ```bash
   ls -l lib/types/database.generated.ts
   ```
3. `lib/types/database.ts` 에서 "MANUAL Database 시작/끝" 주석으로 감싼 `export interface Database { ... }` 블록을 통째로 제거하고, 같은 위치(또는 파일 상단 import 영역) 에 다음 한 줄을 추가:
   ```ts
   export type { Database } from './database.generated';
   ```
   alias / helper 정의는 그대로 둔다.
4. alias / helper mismatch 보정.
   - 가능하면 enum / Row alias 를 generated 에서 derive 하도록 수정:
     ```ts
     export type PlanTier = Database['public']['Enums']['plan_tier'];
     export type UserRow  = Database['public']['Tables']['users']['Row'];
     ```
   - 단, `SubscriptionStatus` 는 DB 가 enum 이 아닌 `text` 컬럼이라 derive 불가. literal union 그대로 유지하고 `Database.Enums.subscription_status` 매핑은 제거 — 체크리스트 1번 항목 참고.
5. clean 빌드 — `.next/types` 가 함께 생성된다.
   ```bash
   npm run build:clean
   ```
6. 빌드 후 타입 체크 — alias 가 generated 와 호환되는지 최종 확인.
   ```bash
   node node_modules/typescript/bin/tsc --noEmit
   ```
   - 0 오류여야 전환 완료. 오류가 남으면 체크리스트의 "예상 수정 후보" 절차로 alias / helper 를 추가 보정 후 5–6 단계 재실행.

## ⚠️ tsc --noEmit 와 .next/types 의 관계

`tsconfig.json` 의 `include` 에 `.next/types/**/*.ts` 가 포함돼 있습니다(Next.js 가 라우트 / 페이지 별 타입을 거기서 emit). 다음 순서를 지키지 않으면 TS6053 등이 발생합니다.

- **`.next` 가 없는 상태에서 단독 `tsc --noEmit` 실행 금지** — `.next/types/...` 파일을 찾지 못해 실패합니다.
- clean 검증 시 순서: **`rm -rf .next` → `next build` → (필요하면) `tsc --noEmit`**.
  `next build` 가 끝나면 `.next/types` 가 다시 만들어져 standalone `tsc --noEmit` 도 통과합니다.
- 빠른 incremental 타입 체크는 `.next/types` 가 이미 존재할 때만 의미가 있습니다(한 번이라도 `next build` 또는 `next dev` 가 돈 뒤). 한 줄 단위 수정 검증, IDE 보조 검사 용도 정도로 사용하세요.

스크립트:
- `npm run build` — `.next` 캐시를 보존하며 빌드 (가장 흔한 경로).
- `npm run build:clean` — `.next` 를 지우고 다시 빌드. CI / 의심나는 캐시 상태 점검 시 사용.
- `npm run typecheck` — `tsc --noEmit`. `.next/types` 존재 전제. clean 상태라면 먼저 `build:clean` 한 번 돌린 뒤 실행하세요.

## 2단계 적용 순서 (1단계 보정·잠금 후)

1단계 보정(00012 ~ 00016) + RPC 권한 잠금 + 입력 검증까지 마친 뒤, 다음 명령을 이 순서대로 실행합니다.

```bash
# 1) 마이그레이션 적용 (로컬 또는 원격 Supabase)
#    - 로컬:
npx supabase db reset          # 처음부터 다시 적용
# 또는
npx supabase migration up      # 새 마이그레이션만 적용

#    - 원격:
npx supabase db push

# 2) DB 타입 자동 생성 — database.generated.ts 에 출력.
#    database.ts(wrapper) 는 덮어쓰지 않으므로 alias 정의가 보존된다.
npm run db:types          # 로컬 Supabase 사용
# 또는
npm run db:types:linked   # `supabase link` 로 연결된 원격 프로젝트 사용

# 3) generated 파일 확인 + wrapper 와 정합성 점검
ls -l lib/types/database.generated.ts          # 파일이 생성됐는지
git diff lib/types/database.ts                  # wrapper 가 그대로인지 (변경 0줄 기대)
# 필요 시 위 "Generated 로 전환하는 방법" 절차로 wrapper 의 MANUAL 블록을 generated 로 교체.

# 4) clean 빌드 — .next/types 가 함께 생성된다.
#    standalone `tsc --noEmit` 을 먼저 돌리지 말 것 (TS6053).
npm run build:clean

# 5) 빌드 후 타입 체크 — 0 오류여야 함. "never" 잔존 시 schema ↔ wrapper alias 불일치.
node node_modules/typescript/bin/tsc --noEmit
```

각 단계 사이 점검:
- `db:push` 후 Supabase Studio → Database → Functions 에서 EXECUTE 권한이 `service_role` 로 잠겨 있는지(또는 `is_admin` 만 `authenticated` 에 grant 돼 있는지) 확인.
- `db:types` 후 `lib/types/database.generated.ts` 가 새로 생겼는지, `lib/types/database.ts` 가 절대 수정되지 않았는지 확인.
- `build:clean` 출력의 "✓ Compiled successfully" + 32 route 가 모두 나오는지 확인. 실패 시 마이그레이션 / wrapper 불일치 가능성.
- 후속 `tsc --noEmit` 에서 "never" 패턴 오류가 0 으로 정리되지 않으면 wrapper alias 가 generated schema 와 어긋난 것이므로, 위 "Generated 로 전환하는 방법" 4번 단계대로 alias 를 derive 로 바꾼다.
- `next build` / `build:clean` 직전에 `npm install` 이 한 번도 실행되지 않은 환경이면 `npm ci` 로 lockfile 기준 설치.

## 시작 전 준비

1. Supabase 프로젝트 생성 (https://supabase.com)
2. Anthropic API 키 발급 (https://console.anthropic.com)
3. `.env.example` → `.env.local` 복사 후 키 입력
4. `npm install`
5. `npx supabase link --project-ref <ref>`
6. `npx supabase db push`

## 개발

```bash
npm run dev          # 개발 서버 (.next/types 자동 생성)
npm run build        # 캐시 보존 빌드
npm run build:clean  # rm -rf .next 후 빌드 (CI / 캐시 의심 시)
npm run typecheck    # tsc --noEmit (.next/types 존재 전제)
npm run db:types     # Supabase 타입 → lib/types/database.generated.ts
npm run db:reset     # DB 리셋 (로컬)
```

> ⚠️ `tsc --noEmit` 단독 실행 직전에 `.next` 가 비어 있으면 TS6053 (`.next/types/...` not found) 가 납니다.
> clean 검증을 원하면 반드시 `npm run build:clean` 을 먼저 돌린 뒤 `tsc --noEmit` 을 실행하세요.

## 빌드 시 알려진 경고 (무해)

`npm run build:clean` 출력에 다음 두 줄이 항상 표시됩니다.

```
<w> [webpack.cache.PackFileCacheStrategy] Serializing big strings (101kiB) impacts deserialization performance ...
<w> [webpack.cache.PackFileCacheStrategy] Serializing big strings (231kiB) impacts deserialization performance ...
```

- 의미: Next.js 가 캐시에 저장하는 모듈 그래프 중 일부 문자열이 100kiB 를 넘어, webpack 이 deserialization 성능 힌트를 출력한 것.
- 영향: 런타임 / 번들 / 기능 동작에는 영향 없음. CI gate 또는 사용자 경험과 무관.
- 대응: 별도 조치 불필요. 의도적으로 webpack 설정을 손보지 않습니다 (cache 형식을 강제로 바꾸면 빌드 시간 / 캐시 적중률에 부작용).
- `✓ Compiled successfully` 와 32 routes 가 정상 출력되는지만 확인하세요.

## P0~P3 완료 후 운영 전 체크리스트

코드 변경이 아니라 외부 리소스/시크릿 / DB 마이그레이션이 필요한 항목입니다. 운영 배포 전에 순서대로 확인하세요.

1. **Supabase migration 적용**
   - 신규 환경: `npx supabase db push` (또는 로컬: `npx supabase db reset`).
   - 기존 환경: `00004_embedding_dim.sql` 적용 시 임베딩 재계산 동반 필요 (위 "마이그레이션 경고" 참조).
   - `pg_cron` 확장이 활성화돼 있어야 `00011_automation_cron_triggers.sql` 가 통과 (Supabase Dashboard → Database → Extensions).
2. **`open_images` Storage bucket 생성/권한**
   - 버킷명: `open_images` (`lib/open-images/select.ts` 의 `OPEN_IMAGES_BUCKET` 상수).
   - public read · admin 만 write (RLS 또는 service-role 경유). 자세한 정책: [docs/open-image-licenses.md](docs/open-image-licenses.md) "URL 정책" 절.
3. **Toss webhook secret 설정**
   - 환경변수: `TOSSPAYMENTS_WEBHOOK_SECRET` (필수). 토스 대시보드의 webhook secret 과 동일한 값.
   - 누락 시 동작: webhook 라우트는 토스 재전송 루프 방지를 위해 **항상 `200 OK` 를 반환**하지만, 내부적으로 서명 검증이 실패해 **이벤트 처리는 침묵 무시되고 `ops_alerts` 에 "구성 누락" critical 알림이 남는다**. 결제 상태 변경(승인·취소·환불)이 DB 에 반영되지 않으니 운영 알림을 반드시 모니터링.
   - 토스페이먼츠 대시보드의 webhook URL 을 `https://<host>/api/webhooks/toss` 로 등록.
4. **QStash 변수 설정 (큐 발행 + 서명 검증 모두 필요)**
   - 발행 측 (`lib/queue/process-upload.ts`):
     - `QSTASH_TOKEN` — Upstash QStash 콘솔의 publish token.
     - `QSTASH_TARGET_URL` — 예: `https://<host>/api/queue/process-upload`.
     - 둘 중 하나라도 누락되면 backend 선택이 **inline (동기) 모드로 fallback** 되고, 큰 PPT/PDF OCR 이 호스팅 환경의 function timeout(이 repo 는 `maxDuration = 300`, 즉 Vercel 5분 가정)을 넘으면 업로드가 실패하기 시작한다.
   - 검증 측 (`/api/queue/process-upload`):
     - `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` — Upstash 콘솔의 signing key 쌍. 키 로테이션 시 둘 모두 채워두면 무중단 교체 가능.
     - production 에서 누락 시 라우트가 401 로 거부.
5. **AI 비용 캡 + 호출 안정성**
   - 환경변수: `MAX_DAILY_AI_COST_USD` (예: `50`). 일일 합산 비용이 캡을 넘으면 `/api/questions/generate` 사전 차단.
   - `MAX_QUESTIONS_PER_REQUEST` (선택, 기본 50) 도 함께 점검.
   - `ANTHROPIC_TIMEOUT_MS` (선택, 기본 `60000` = 60초) — Anthropic SDK 호출 timeout. 외부 API hang 으로 서버 함수가 묶이는 것을 방지. SDK 자체 retry 는 끄고 `lib/ai/client.ts` 의 `withRetry` 한 곳으로 일원화돼 있다.
6. **ROCO/PMC manifest dry-run**
   - 임베딩 없이 manifest 형태 / 라이선스 가드만 점검:
     ```bash
     node scripts/ingest-open-images.mjs \
       --source roco_v2 \
       --manifest data/roco.jsonl \
       --dry-run --skip-embedding
     ```
   - 임베딩 호출까지 함께 검증하려면 `--skip-embedding` 을 제거하고 `VOYAGE_API_KEY` 를 설정 (실제 비용 발생, dry-run 이라 DB insert 는 여전히 없음).
   - 통과 후 `--dry-run` / `--skip-embedding` 모두 제거하고 실제 인제스트 (`SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY` 환경변수 필요).
   - 옵션 전체는 `node scripts/ingest-open-images.mjs --help` 로 확인.
7. **빌드 / 타입 검증**
   - `npm run build:clean` — `✓ Compiled successfully` + 32 routes 정상 출력 확인.
   - `node node_modules/typescript/bin/tsc --noEmit` — 0 오류.
   - `node scripts/test-open-images-flow.mjs` — 전 항목 pass (open-images 흐름 정합성).
   - `node scripts/eval-ocr.mjs --help` — 스크립트 로드 정상 (실 OCR 평가는 골든셋 준비 후).
