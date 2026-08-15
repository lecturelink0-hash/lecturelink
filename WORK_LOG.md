# WORK LOG

## 2026-08-14 sharp 타입 exports 배포 오류 수정

- 요청 및 목적: Vercel Production에서 `sharp` 동적 import 타입 해석 오류로 빌드가 실패하는 문제를 최소 변경으로 해결.
- 확인: `package.json`과 `package-lock.json`의 기존 sharp는 `0.35.0`, `tsconfig.json`은 `moduleResolution: bundler`, 서버 전용 동적 import 의도는 기존 코드에 유지됨.
- 변경: `package.json`, `package-lock.json`, `pnpm-lock.yaml`의 sharp를 `0.35.3`으로 업데이트. `lib/extract/crop-medical-images.ts`는 수정하지 않음.
- 이유: sharp 0.35.3은 import 조건에 `dist/index.d.mts` 타입 선언을 명시해 bundler 해석에서 발생한 `Could not find a declaration file for module 'sharp'`를 해결함.
- 검사: Node 22로 TypeScript 전체 검사 통과. `pnpm run build`와 Vercel과 동일한 `npm ci`는 Windows 로컬 `node_modules` 파일 잠금/의존성 재설치 지연으로 제한 시간 내 완료되지 않음.
- 직접 확인하지 못한 부분: 이 환경에서는 Vercel Production 재배포 및 운영 URL 반영을 확인하지 못함.
- 최종 상태: 조건부 완료 (코드 수정 및 타입 오류 해결, production build/deploy 재검증 필요).

## 2026-08-13 · 내 문제집 이어풀기·유사문제 저장·삭제 확인 운영 반영

- 요청 및 목적: 로컬에서 검증한 내 문제집 기능을 최신 운영 `main` 기준으로 분리해 실제 사이트에 반영한다.
- 변경한 내용과 파일:
  - `app/(app)/library/page.tsx`: 진행도 로딩 후 다음 미풀이 문항 복원, 완료 문제집 `다시 풀기`, 자동 저장 유사문제집 표시, 삭제 확인 Dialog·성공/실패 안내·중복 클릭 방지·키보드 접근성을 추가했다. 기존 형성평가 저장 목록은 유지했다.
  - `app/api/me/library-progress/route.ts`, `lib/library-progress.ts`: 업로드별 최신 풀이 위치와 다음 미풀이 문항 계산을 추가했다.
  - `app/api/questions/similar/route.ts`, `app/(app)/similar-practice/[uploadId]/page.tsx`: 기존 자동 저장을 유지하고 제목, 저장 안내, 풀이 완료 후 두 복귀 경로를 추가했다.
  - `app/redesign-reference.css`: 카드 장식 클릭 방지와 빨간 destructive 버튼 hover/focus를 추가했다.
  - `lib/extract/crop-medical-images.ts`: 최신 `sharp` 타입에서 불필요해진 `@ts-expect-error`를 제거해 운영 전체 TypeScript 검사를 복구했다. 런타임 로직은 변경하지 않았다.
- 검수 결과:
  - 다음 미풀이 계산 5개 assertion 통과(2/10→3번 포함), 변경 TS/TSX 파일 제한 구문 검사 오류 0개.
  - 삭제 정확 문구, 기본 confirm 미사용, 성공/실패 안내, ESC, 중복 실행 방지, 유사문제집 표시 정적 검사 통과.
  - Impeccable detector `[]`, `git diff --check` 통과.
  - 전체 TypeScript `npm run typecheck` 통과, `npm run build` 통과(86개 정적 페이지 생성 완료).
  - 전체 세트 문항 로딩 후 이어풀기 위치를 계산하도록 보강해 100문항 초과 세트의 부분 캐시 오판을 막았고, 진행도·답안 저장 실패 시 재시도 상태를 표시하도록 수정했다.
  - 보강 후 `npm run typecheck`와 WorkGuard lint·typecheck·build를 다시 통과했다. PC·모바일 내 문제집 미리보기 증빙을 `.workguard/evidence`에 저장했다.
- 직접 확인하지 못한 부분: 로그인 기반 삭제 실행 E2E는 사용자 요청에 따라 건너뛰었으며, 운영 URL 확인은 배포 후 진행한다.
- 사용자 최종 확인 결과: 운영 배포 진행 승인 및 로그인 기반 검수 건너뛰기 요청 확인.
- 팀 보고문 작성 여부: 미작성(운영 배포 확인 전).
- 최종 상태: 조건부 완료 (`필수 자동검사 완료 · 운영 배포 진행 중`).

## 2026-08-13 — CPX 메인 User Flow 전면 개선

- 요청 및 목적: CPX 진입 후 3초 안에 `약점 복습 / 랜덤 실전 / 직접 선택`의 차이를 이해하고 목적에 맞는 연습을 시작하도록 메인 페이지를 재설계.
- 작업 범위와 완료 조건: CPX 페이지만 변경. 기존 Header/Nav와 디자인 토큰, 증례·기록·시간·음성·세션 시작 로직 재사용. 기록 기반 추천과 empty state, 랜덤 증례 비공개, 직접 선택 탐색, 시작 전 설정 modal/sheet, 반응형 구현.
- 변경한 내용과 파일:
  - `components/cpx/CpxStartExperience.jsx`: 빠른 시작, 개인화 추천/empty state, 랜덤 실전, 파트→주호소→시나리오 탐색, 설정 dialog/sheet.
  - `components/cpx/CpxPractice.jsx`: 새 시작 경험 연결, 시작 모드 전달, 랜덤 실전 진료 중 시나리오명 비공개, 기존 세션 시작 로직 재사용.
  - `app/api/cpx/[...path]/route.ts`, `services/cpx/server/main.py`: 채점 결과에서 실제 최저 평가 영역을 계산해 history 요약에 제공.
  - `app/api/preview/cpx/[...path]/route.ts`: 인증·운영 데이터와 분리된 로컬 CPX UI 검증용 개발 전용 프록시.
  - `app/globals.css`: LectureLink 토큰 기반 PC/모바일 레이아웃과 modal/sheet 스타일.
- 주요 판단과 이유: 설정은 증례 선택 뒤로 이동해 첫 화면의 인지 부하를 줄였고, 직접 탐색은 많은 주호소를 가로 chip 대신 PC 세로 목록/모바일 select로 구성. 추천은 실제 완료 기록이 없으면 만들지 않음.
- 실행한 검사와 결과:
  - TypeScript `tsc --noEmit --incremental false`: 통과.
  - Impeccable UI detector(layout): 위반 0건.
  - 실제 브라우저 PC: 새 정보 위계, empty state, 직접 선택 목록, 랜덤 실전 설정 modal과 증례 비공개 표시 확인.
  - 랜덤 설정 modal: 12:00/11:30/11:00, 음성 ON/OFF, 최종 CTA 노출 확인.
- 직접 확인하지 못한 부분: 로컬 Next 개발 서버가 반복 재시작 후 장시간 응답 지연되어 모바일 viewport와 실제 Gemini Live 연결 이후까지의 전체 세션 완주는 이번 검증에서 완료하지 못함. 개발용 FastAPI에는 Gemini API 키가 없어 진료 연결 자체도 불가.
- 사용자 최종 확인 결과: 사용자 확인 대기.
- 남은 문제: 사용자가 실제 로그인 환경에서 PC/모바일 화면과 Flow A/B/C 최종 진입을 확인해야 함.
- 팀 보고문 작성 여부: 미작성(사용자 확인 전).
- 최종 상태: 조건부 완료 — 코덱스 검증 완료 · 사용자 확인 대기.

## 2026-08-15 구독 관리 진입점 정리

- 요청 및 목적: 마이페이지의 요금제 관리 진입을 전용 구독 관리 화면으로 일원화하고, 정기결제 해지는 `/subscription`에서만 제공.
- 변경 파일: `app/(app)/mypage/page.tsx`.
- 변경 내용: 마이페이지에 남아 있던 `자동 갱신 해제` 버튼·확인 모달·관련 로컬 상태와 API 호출을 제거. 유료 구독자는 기존 `구독 관리` 링크로 `/subscription`에 진입하며, 다음 결제일 또는 이용 만료일 정보는 유지.
- 유지한 요소: `/subscription`의 요금제 변경, 해지 사유 선택, 해지 확인, 실제 해지 API 로직은 변경하지 않음.
- 검사: 변경 파일 레이아웃 검사, diff 검사 진행 중. 전체 TypeScript 검사는 새 워크트리의 미설치 기존 의존성(`qrcode.react`, `pdfjs-dist`) 오류로 완료하지 못함.
- 사용자 최종 확인 결과: 확인 대기.
- 최종 상태: 조건부 완료 — `main` 반영 전 검증 진행 중.

## 2026-08-13 — CPX 시작 화면 실제 반영 승인

- 사용자 최종 확인 결과: 로컬 CPX 미리보기 확인 후 실제 프로젝트 반영 요청을 받음.
- 반영 대상: CPX 시작 화면, 기록 기반 추천 정보, 직접 선택 row 액션, 연습 설정 시간·음성 UI, 관련 점수 데이터 연결.
- 제외 대상: 로컬 로그인 우회와 예시 API 등 미리보기 전용 코드.
- 검수: 타입 검사와 최신 운영 기준 브랜치 이식 후 운영 배포 전 최종 확인 예정.
- 최종 상태: 조건부 완료 — 실제 코드 반영 진행 중, 운영 배포 전 확인 필요.

## 2026-08-13 — CPX 시작 화면·연습 설정 UI 정리

- 요청 및 목적: 기존 CPX User Flow와 LectureLink 디자인 시스템을 유지하면서 시작 화면의 문구, 빠른 시작 카드 균형, 증례 선택 액션, 연습 설정 모달을 더 단순하고 명확하게 정리.
- 작업 범위와 완료 조건: CPX 시작 화면과 설정 모달만 수정. Header/Nav, 페이지 전체 구조, 실제 기록 추천, 시간·음성 상태, 세션 시작 로직은 유지.
- 변경한 내용과 파일:
  - `components/cpx/CpxStartExperience.jsx`: 최상단 제목과 빠른 시작 문구 정리, 실제 기록 기반 점수 강조, 카드 카피 단순화, 전체 증례 row 클릭 및 `연습하기` 액션, 시간 보조 문구 제거, 접근 가능한 음성 switch 적용.
  - `components/cpx/CpxPractice.jsx`: 시간 옵션을 11분 → 11분 30초 → 12분 순서로 변경하고 기본 선택 12분 유지.
  - `app/globals.css`: 두 빠른 시작 카드 크기·패딩·CTA 정렬 통일, 랜덤 카드 원형 장식 제거, 증례 row hover/focus, 표준 switch와 반응형 스타일 적용.
- 주요 판단과 이유: 추천 점수는 하드코딩하지 않고 기존 `score / weightPercent`를 백분율로 환산했으며, 증례명 아래 진단 표시는 기존 제목의 괄호 내용을 재사용. 증례 row는 단일 button으로 만들어 중첩 액션 없이 전체 클릭·키보드 접근을 지원.
- 실행한 검사와 결과:
  - TypeScript `tsc --noEmit --incremental false`: 통과.
  - TypeScript JSX 구문 변환 검사: 통과.
  - `git diff --check`: 통과.
  - 필수 문구·role 구조 정적 확인: 통과.
- 직접 확인하지 못한 부분: 로컬 Next 개발 서버가 `/cpx` 요청에 응답하지 않아 수정 후 데스크톱·태블릿·모바일 브라우저 렌더링과 실제 진료 시작 클릭은 확인하지 못함. 사용자 요청에 따라 해당 장애는 건너뜀.
- 사용자 최종 확인 결과: 사용자 확인 대기.
- 남은 문제: 사용자가 로컬 서버 정상화 후 화면 비율과 모달 동작을 직접 확인해야 함.
- 팀 보고문 작성 여부: 미작성(사용자 확인 전).
- 최종 상태: 조건부 완료 — 코덱스 검증 완료 · 사용자 확인 대기.
