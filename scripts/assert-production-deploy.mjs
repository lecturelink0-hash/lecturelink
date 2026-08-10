import { execFileSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function fail(message) {
  console.error(`\nProduction deploy blocked: ${message}\n`);
  process.exit(1);
}

try {
  const branch = git('branch', '--show-current');
  if (branch !== 'main') fail(`current branch is "${branch || 'detached HEAD'}", not "main".`);
  if (git('status', '--porcelain')) fail('the working tree has uncommitted changes.');

  git('fetch', 'origin', 'main');
  const head = git('rev-parse', 'HEAD');
  const remoteMain = git('rev-parse', 'origin/main');
  if (head !== remoteMain) {
    fail('local HEAD is not exactly the latest origin/main commit. Update main before deploying.');
  }

  console.log(`Production deploy allowed for origin/main at ${head.slice(0, 12)}.`);
} catch (error) {
  if (error?.status === 1) process.exit(1);
  fail(error instanceof Error ? error.message : String(error));
}
