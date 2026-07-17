# 미래 작업 계획서 — 카카오 커스텀 → 정식(비즈앱) 로그인 이전

> 작성일: 2026-07-18 · 대상 저장소: LectureLink 통합본(`codex/cpx-interface-v1`, GitHub `ddoli1545/lecturelink`)
> Supabase 프로젝트 ref: `sazjdoclofecuhbaobze`
> 착수 시 이 문서를 기준으로 진행한다.

## 현재 상태 (2026-07-18)
카카오 로그인은 **커스텀 구현**으로 동작 중이다.
- `app/api/auth/kakao/start/route.ts` — CSRF state 쿠키 설정 후 카카오 authorize로 리다이렉트. **이메일 미요청**, `scope=profile_nickname`만.
- `app/api/auth/kakao/callback/route.ts` — code→토큰 교환 → 카카오 사용자(id·닉네임) 조회 → Supabase 사용자 upsert → admin magiclink 발급 → `/auth/callback`에서 세션 성립.
- `app/(auth)/login/page.tsx`의 `handleKakao` — 로그인 버튼이 커스텀 엔드포인트 `/api/auth/kakao/start`를 호출.
- 카카오 계정은 **합성 이메일** `kakao_<kakaoId>@kakao.users.lecturelink.kro.kr` 로 생성되고, `app_metadata.kakao_id`·`user_metadata.kakao_id`에 **카카오 sub**가 저장돼 있다(예: `4995636403`).

## 배경 / 왜 커스텀으로 우회했나
- Supabase 내장 카카오 provider는 `account_email`(이메일) 동의를 **강제**한다.
- 카카오는 이메일 수집을 **비즈 앱**에만 허용하고, 비즈 앱 전환에는 **사업자등록번호**가 필요하다(개인 개발자도 사업자 정보 필수 — 2026-07 콘솔 기준).
- 사업자등록번호가 없어서, 이메일을 요구하지 않는 커스텀 카카오 로그인으로 우회함(KOE205 회피).
- 커스텀 방식의 단점: 카카오 계정에 실제 이메일이 없음(합성 이메일), 커스텀 인증 코드 유지 부담.
- **이전을 위해 처음부터 `kakao_id`(sub)를 계정 메타데이터에 저장**해 둠 → 정식 provider도 동일 sub를 쓰므로 이 값으로 병합 가능.

## 착수 전제 조건
1. **사업자등록번호 확보** (홈택스 개인사업자 등록 등).
2. 카카오 Developers → 앱 → **비즈니스 → 사업자 정보 등록 → 비즈 앱 전환**.
3. 전환 후 **카카오 로그인 → 동의항목 → 카카오계정(이메일) `account_email`을 선택 동의로 활성화**.
4. (확인) 카카오 로그인 → Redirect URI에 `https://sazjdoclofecuhbaobze.supabase.co/auth/v1/callback` 등록돼 있음(기존). Client Secret도 Supabase에 저장돼 있음.

## 실행 단계

### 1) Supabase 정식 카카오 provider로 복귀
- `app/(auth)/login/page.tsx`의 `handleKakao`를 커스텀 리다이렉트 대신 아래로 교체:
  ```ts
  const supabase = createBrowserClient();
  await supabase.auth.signInWithOAuth({
    provider: 'kakao',
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
  ```
- Supabase 대시보드에서 카카오 provider는 이미 활성(client_id `8c2ae068...`, secret 저장됨).
- 커스텀 라우트(`app/api/auth/kakao/start`, `.../callback`)는 이전 완료 후 제거하거나, 이전 기간 병행을 위해 잠시 유지.

### 2) 기존 커스텀 계정 → 정식 카카오 신원 병합 (가장 중요)
- **매칭 키 = 카카오 sub.** 커스텀 계정: `app_metadata.kakao_id == sub`, 이메일 `kakao_<sub>@kakao.users.lecturelink.kro.kr`. 정식 계정: `identities`의 kakao provider `provider_id == sub`, 이메일은 **실제 카카오 이메일**.
- 그냥 두면 같은 사람이 계정 2개(합성·실제)로 갈려 학습 기록이 분리됨.
- **병합 스크립트(서비스 role admin API) 절차:**
  1. 정식 provider로 로그인한 사용자들의 `identities`에서 카카오 `provider_id`(=sub) 수집.
  2. 각 sub에 대해 기존 커스텀 계정(합성 이메일 / `app_metadata.kakao_id == sub`)을 찾음.
  3. **데이터 이관**: `user_id` FK를 가진 테이블들의 `user_id`를 **커스텀 계정 id → 정식 계정 id로 UPDATE**.
     - 대상 예: `public.users`, `cpx_sessions`, `cpx_transcript_events`, `cpx_physical_exam_events`, `user_attempts`, `review_notes` 등(FK 목록은 마이그레이션에서 최종 확인).
  4. 이관 완료된 커스텀(합성) 계정은 `auth.admin.deleteUser`로 정리.
- **주의**: `on delete cascade` FK가 많으므로 **삭제 전 반드시 user_id를 먼저 이전**할 것. 삭제→재생성 순서 금지.
- 설계 옵션: (a) 일괄 배치 1회 실행(사용자 수 적으면 단순), 또는 (b) 정식 로그인 콜백에서 해당 sub의 커스텀 계정이 있으면 **온-더-플라이 병합**.
  - `public.users`가 정식 계정 생성 트리거(`handle_new_auth_user`)로 자동 생성되므로, 이관 시 중복 `public.users` 행 처리(정식 행 유지·커스텀 행 데이터 이전 후 제거)에 유의.

### 3) 검증
- 이전 전/후 동일 카카오 계정으로 로그인 → 같은 학습 기록(CPX 세션·오답노트 등) 유지 확인.
- 신규 카카오 로그인 → 정식 provider로 계정 생성 + **이메일 채워짐** 확인.
- 합성 이메일 계정이 남지 않았는지 admin users 목록 점검.

## 관련 파일 / 값
- `app/(auth)/login/page.tsx` — `handleKakao`(커스텀 → 정식 교체 지점).
- `app/api/auth/kakao/start/route.ts`, `app/api/auth/kakao/callback/route.ts` — 커스텀 흐름(이전 후 제거 후보).
- 합성 이메일 규칙: `kakao_<kakaoId>@kakao.users.lecturelink.kro.kr`.
- 카카오 client_id: `8c2ae068b6e772968967201ac3beaf5e` (REST API 키). Supabase provider redirect URI: `https://sazjdoclofecuhbaobze.supabase.co/auth/v1/callback`.
- Supabase 프로젝트 ref: `sazjdoclofecuhbaobze`.
