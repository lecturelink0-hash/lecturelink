/**
 * (app) 그룹 공통 로딩 스켈레톤
 *
 * 서버 컴포넌트 페이지(홈·학습분석·CPX 목록 등)는 데이터 페칭이 끝날 때까지
 * 이전 화면에 머물러 "클릭해도 반응 없음"으로 느껴진다. loading.tsx 가 있으면
 * 내비게이션 즉시 이 스켈레톤으로 전환되고, <Link> prefetch 도 이 경계까지
 * 미리 받아 체감 전환이 즉각적이 된다.
 */
export default function AppLoading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="페이지를 불러오는 중">
      {/* 페이지 헤더 자리 */}
      <div className="h-8 w-48 rounded-lg bg-[var(--color-sage-100)]" />
      <div className="mt-3 h-4 w-72 rounded bg-[var(--color-sage-50)]" />

      {/* 카드 그리드 자리 */}
      <div className="mt-8 grid gap-5 md:grid-cols-2">
        <div className="h-44 rounded-2xl bg-[var(--color-sage-50)] border border-[var(--color-sage-100)]" />
        <div className="h-44 rounded-2xl bg-[var(--color-sage-50)] border border-[var(--color-sage-100)]" />
        <div className="h-44 rounded-2xl bg-[var(--color-sage-50)] border border-[var(--color-sage-100)]" />
        <div className="h-44 rounded-2xl bg-[var(--color-sage-50)] border border-[var(--color-sage-100)]" />
      </div>
    </div>
  );
}
