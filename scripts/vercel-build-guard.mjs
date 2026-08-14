// Production 빌드는 main에서 온 배포만 허용한다.
//
// vercel.json의 ignoreCommand(vercel-ignore-build.mjs)는 git 연동 빌드에만
// 평가되고, 로컬에서 `vercel --prod`로 올리는 CLI 배포에는 평가되지 않는다.
// 그 틈으로 로컬 작업 트리가 프로덕션을 덮어쓰는 사고가 반복돼(2026-08-08,
// 08-11, 08-14) 빌드 단계에서 한 번 더 막는다. 이 스크립트는 build 스크립트
// 첫 단계로 실행되므로 CLI 배포의 Vercel 빌드에도 항상 걸린다.
//
// 한계: `vercel deploy --prebuilt`는 Vercel에서 빌드 자체를 건너뛰므로 이
// 가드도 우회된다. 의도적인 비상 배포는 --build-env ALLOW_NON_MAIN_PRODUCTION=1
// 로 허용할 수 있다.

const isVercel = process.env.VERCEL === '1';
const target = process.env.VERCEL_ENV;
const ref = process.env.VERCEL_GIT_COMMIT_REF ?? '';

if (!isVercel || target !== 'production' || ref === 'main') {
  process.exit(0);
}

if (process.env.ALLOW_NON_MAIN_PRODUCTION === '1') {
  console.warn(
    `Production build guard bypassed via ALLOW_NON_MAIN_PRODUCTION (ref: "${ref || 'no git metadata'}").`,
  );
  process.exit(0);
}

console.error(
  [
    '',
    'Production build blocked: this deployment is not from the main branch.',
    `  git ref: ${ref ? `"${ref}"` : '(none — local tree uploaded via `vercel --prod`)'}`,
    '',
    '프로덕션은 main 머지 → Vercel 자동배포로만 반영됩니다.',
    '변경 사항은 브랜치로 푸시해 PR을 열고, 확인이 필요하면 preview 배포(`vercel`)를 쓰세요.',
    '비상 시에만: vercel --prod --build-env ALLOW_NON_MAIN_PRODUCTION=1',
    '',
  ].join('\n'),
);
process.exit(1);
