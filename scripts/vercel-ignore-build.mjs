const branch = process.env.VERCEL_GIT_COMMIT_REF;

if (!branch) {
  console.error('Vercel build blocked: VERCEL_GIT_COMMIT_REF is unavailable.');
  process.exit(0);
}

if (branch !== 'main') {
  console.log(`Vercel build skipped for non-production branch: ${branch}`);
  process.exit(0);
}

console.log('Vercel build allowed for main.');
process.exit(1);
