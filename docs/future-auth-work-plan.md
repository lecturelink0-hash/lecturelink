# 인증 관련 미래 작업 계획서

> 작성일: 2026-07-18 · 대상 저장소: LectureLink 통합본(`codex/cpx-interface-v1`)
> 현재 상태에서 의도적으로 "나중에" 미룬 두 과제의 실행 계획. 착수 시 이 문서를 기준으로 진행한다.

현재(2026-07-18) 인증은 모두 작동한다:
- 카카오 로그인 = **커스텀 구현**(`/api/auth/kakao/start`·`/callback`, 이메일 미요청, `profile_nickname`만).
- 이메일 회원가입/로그인/비밀번호 재설정 = 정상. 발송은 **개인 Gmail SMTP**(`fornerdsofficial@gmail.com`).
- 카카오 사용자의 이메일 등록(프로필 페이지) = 정상.

아래 두 과제는 "더 정석적/견고한" 상태로 올리기 위한 후속 작업이다.

---

## 과제 A. 카카오 커스텀 → 정식(비즈앱) 로그인 이전

### 배경 / 왜 미뤘나
- Supabase 내장 카카오 provider는 `account_email`(이메일) 동의를 **강제**한다.
- 카카오는 이메일 수집을 **비즈 앱**에만 허용하고, 비즈 앱 전환에는 **사업자등록번호**가 필요하다(개인 개발자도 사업자 정보 필수 — 2026-07 기준 콘솔 확인).
- 사업자등록번호가 없어서, 이메일을 요구하지 않는 **커스텀 카카오 로그인**으로 우회 구현함(KOE205 회피).
- 커스텀 방식의 단점: 카카오 계정에 실제 이메일이 없음(합성 이메일), 커스텀 인증 코드 유지 부담.

### 착수 전제 조건
1. **사업자등록번호 확보** (홈택스 개인사업자 등록 등).
2. 카카오 Developers → 앱 → **비즈니스 → 사업자 정보 등록 → 비즈 앱 전환**.
3. 전환 후 **카카오 로그인 → 동의항목 → 카카오계정(이메일) `account_email`을 선택 동의로 활성화**.

### 실행 단계
1. **Supabase 정식 카카오 provider 재사용으로 복귀**
   - 현재 로그인 버튼은 커스텀 엔드포인트(`/api/auth/kakao/start`)를 호출한다(`app/(auth)/login/page.tsx`의 `handleKakao`).
   - 정식 방식으로 되돌리려면 `supabase.auth.signInWithOAuth({ provider: 'kakao', options: { redirectTo: `${origin}/auth/callback` } })` 로 교체.
   - Supabase 대시보드에서 카카오 provider는 이미 활성(client_id `8c2ae068...`, secret 저장됨). Redirect URI `https://sazjdoclofecuhbaobze.supabase.co/auth/v1/callback` 는 카카오에 등록돼 있음.
   - 커스텀 라우트(`app/api/auth/kakao/*`)는 이전 완료 후 제거하거나, 이전 기간 병행을 위해 잠시 유지.

2. **기존 커스텀 계정 → 정식 카카오 신원 병합** (가장 중요)
   - **키는 카카오 ID(sub)**. 커스텀 가입 시 `app_metadata.kakao_id` / `user_metadata.kakao_id` 에 저장해 둠(예: `4995636403`). 정식 로그인도 동일한 카카오 sub를 사용하므로 이 값으로 매칭 가능.
   - 문제: 정식 provider는 **실제 카카오 이메일**로 사용자를 만들어, 그냥 두면 같은 사람이 계정 2개(합성 이메일 커스텀 계정 + 실제 이메일 정식 계정)가 되어 학습 기록이 갈라짐.
   - **병합 스크립트 설계**(service_role admin API):
     1. 정식 provider로 로그인한 신규 사용자들의 `identities`에서 카카오 provider의 `provider_id`(=카카오 sub) 수집.
     2. 각 sub에 대해, 기존 커스텀 계정(`app_metadata.kakao_id == sub`, 합성 이메일 `kakao_<sub>@kakao.users.lecturelink.kro.kr`)을 찾음.
     3. 데이터 이관: `public.users`(및 CPX 세션 등 user_id FK를 가진 테이블 `cpx_sessions`, `cpx_transcript_events`, `cpx_physical_exam_events`, `user_attempts`, `review_notes` 등)의 `user_id`를 **커스텀 계정 id → 정식 계정 id로 UPDATE**.
        - 또는 반대로, 정식 계정을 지우고 커스텀 계정의 이메일·identity만 갱신하는 방향도 가능하나, FK 이관이 더 단순하고 안전.
     4. 이관 완료된 커스텀(합성) 계정은 `auth.admin.deleteUser`로 정리.
   - **주의**: `on delete cascade` FK가 많으므로, 삭제 전에 반드시 user_id를 먼저 이전할 것. 삭제→재생성 순서 금지.
   - 이관은 **일괄(배치)** 로 한 번 돌리거나, 로그인 시점에 **온-더-플라이 병합**(정식 로그인 콜백에서 해당 sub의 커스텀 계정이 있으면 이관)으로 설계 가능. 사용자 수가 적으면 배치가 단순.

3. **검증**
   - 이전 전/후 카카오 계정으로 로그인 → 같은 학습 기록(CPX 세션·오답노트 등)이 유지되는지 확인.
   - 신규 카카오 로그인 → 정식 provider로 정상 계정 생성 + 이메일 채워짐 확인.
   - 합성 이메일 계정이 남지 않았는지 admin users 목록 점검.

### 관련 파일 / 값
- `app/(auth)/login/page.tsx` — `handleKakao` (현재 커스텀 → 정식으로 교체 지점).
- `app/api/auth/kakao/start/route.ts`, `app/api/auth/kakao/callback/route.ts` — 커스텀 흐름(이전 후 제거 후보).
- 합성 이메일 규칙: `kakao_<kakaoId>@kakao.users.lecturelink.kro.kr`.
- Supabase 프로젝트 ref: `sazjdoclofecuhbaobze`.

---

## 과제 B. 이메일 발송: 개인 Gmail SMTP → 전용 서비스(Resend) 전환

### 배경 / 왜 미뤘나
- 현재 Supabase Auth 메일은 **개인 Gmail SMTP**(`smtp.gmail.com:465`, `fornerdsofficial@gmail.com`)로 발송.
- 발송·배달 자체는 정상(실측 확인)이지만, 개인 Gmail 릴레이는 수신측(특히 지메일)에서 **스팸/프로모션 분류**가 잦고 발송 한도·평판 리스크가 있음.
- 전용 트랜잭션 메일 서비스 + **도메인 인증 발신자**(`noreply@lecturelink.kro.kr`)로 바꾸면 인박스 도달률이 크게 개선됨.

### 착수 전제 조건
- **Resend 계정 생성**(무료 티어: 3,000통/월, 100통/일) — 또는 SendGrid/Postmark/AWS SES 등 동급 서비스.
- 발신 도메인으로 **`lecturelink.kro.kr`**(또는 서브도메인 `mail.lecturelink.kro.kr`) 사용.

### 실행 단계
1. **Resend에 도메인 등록 + DNS 인증**
   - Resend 대시보드에서 도메인 추가 → 제공되는 **SPF(TXT)**, **DKIM(TXT/CNAME)**, (권장) **DMARC(TXT)** 레코드 확인.
   - 이 레코드들을 **내도메인.한국 DNS 관리**(현 A/TXT를 넣은 그 화면)에 추가. 내도메인.한국 패널은 TXT/CNAME을 지원하므로 대부분 등록 가능.
   - Resend에서 도메인 **Verified** 상태 확인.
2. **Supabase Custom SMTP를 Resend로 교체**
   - Supabase 대시보드 → Authentication → SMTP Settings(또는 Management API `config/auth`):
     - `smtp_host = smtp.resend.com`
     - `smtp_port = 465`
     - `smtp_user = resend`
     - `smtp_pass = <Resend API Key>` (비밀 — 대시보드에서 직접 입력, 채팅/깃 노출 금지)
     - `smtp_admin_email / sender = noreply@lecturelink.kro.kr`
     - `smtp_sender_name = 렉처링크`
   - 참고: Management API로 SMTP 필드는 PATCH 가능했으나(allowlist·secure_email_change 등 반영됨), **이메일 템플릿 본문 PATCH는 403**(대시보드 전용). SMTP 자격은 대시보드 입력 권장.
3. **이메일 템플릿 한글화 마무리(선택)**
   - 확인 메일은 이미 한글 커스텀. **비밀번호 재설정 제목이 아직 영어("Reset your password")** — Supabase 대시보드 → Auth → Email Templates → **Reset Password** 에서 제목/본문 한글화.
   - 재설정 본문 링크는 **`{{ .SiteURL }}/auth/reset-password`**(현재 redirect_to 방식과 일치)로 두면 됨. (현 구현은 implicit 해시 토큰을 `/auth/reset-password`에서 직접 파싱해 처리하므로 그대로 동작.)
4. **검증**
   - 임시 메일(mail.tm 등)로 회원가입·재설정 메일을 발송 → **발신자가 `noreply@lecturelink.kro.kr`** 이고 SPF/DKIM pass인지, 지메일 인박스에 도달하는지 확인.

### 관련 파일 / 값
- Supabase 프로젝트 ref: `sazjdoclofecuhbaobze`.
- 현재 SMTP: `smtp.gmail.com:465`, user `fornerdsofficial@gmail.com`.
- DNS: `lecturelink.kro.kr` — 내도메인.한국 패널(현재 A=216.198.79.1/64.29.17.1, TXT `_vercel` 등록됨). Resend용 TXT/CNAME 추가.

---

## 참고: 지금까지의 인증 결정/구현 요약(맥락)
- 카카오: KOE205(이메일 동의 강제) → 비즈앱=사업자등록 필요 → **커스텀 로그인으로 우회**(완료). `kakao_id` 저장으로 미래 병합 대비.
- 이메일 "안 옴" 원인: 사용자 이메일이 **이미 가입됨** → 회원가입 시 메일 미발송(정상). → **비밀번호 재설정 기능 신규 구현**으로 해결.
- 재설정 흐름 기술 이슈: implicit 해시 토큰을 서버 콜백이 못 읽음 → 재설정 페이지에서 `setSession`으로 직접 처리(완료).
