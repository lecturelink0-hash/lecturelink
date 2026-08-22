/**
 * 데이터셋 분리·고정 검사 (성능지표 가이드 §10.2 · 분담표 A7)
 *
 * 가이드 §10.2 데이터 누수 방지:
 *   - 개발셋과 테스트셋을 분리하고 최종 테스트셋은 고정한다.
 *   - 프롬프트와 모델을 테스트셋 결과에 맞춰 반복 수정하지 않는다.
 *
 * 코드가 강제할 수 있는 것과 없는 것을 나눈다.
 *   강제 가능: 테스트셋이 개발 중에 **바뀌지 않았는지**(해시 고정), 같은 경로가 두 갈래에
 *             중복 등록되지 않았는지(분리), 잠긴 항목에 해시가 있는지.
 *   강제 불가: "결과를 보고 프롬프트를 고쳤는가". 이건 사람의 규율이고, 문서로만 남긴다.
 *
 * 잠금이 왜 필요한가: 테스트셋을 조금씩 고치면 점수가 오른다. 고의가 아니어도 그렇다 —
 * 애매한 항목을 지우고 잘 도는 항목을 남기는 방향으로 손이 간다. 해시를 박아 두면
 * 그 변경이 CI 에서 눈에 띄고, 정당한 변경이면 새 id 로 등록하게 된다.
 *
 *   npm run check:datasets            # 검사
 *   npm run check:datasets -- --lock <id>   # 항목을 현재 내용으로 잠근다
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const MANIFEST = 'datasets/manifest.json';
const PURPOSES = new Set(['dev', 'validation', 'test']);

/** 디렉터리는 파일 경로와 내용을 함께 해싱한다 — 파일이 추가·삭제돼도 해시가 바뀌어야 한다. */
function hashPath(target) {
  const hash = createHash('sha256');
  const walk = (current) => {
    const stats = statSync(current);
    if (stats.isFile()) {
      hash.update(relative(target, current) || current);
      hash.update(readFileSync(current));
      return;
    }
    for (const entry of readdirSync(current).sort()) {
      if (entry === '.DS_Store') continue;
      walk(join(current, entry));
    }
  };
  walk(target);
  return hash.digest('hex');
}

function main() {
  const lockIndex = process.argv.indexOf('--lock');
  const lockId = lockIndex >= 0 ? process.argv[lockIndex + 1] : null;

  if (!existsSync(MANIFEST)) {
    console.error(`FAIL  ${MANIFEST} 가 없습니다. 평가 데이터셋 레지스트리는 필수입니다(가이드 §10.2).`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const datasets = manifest.datasets ?? [];
  const problems = [];
  const seenIds = new Set();
  const pathsByPurpose = new Map();
  let locked = false;

  for (const entry of datasets) {
    const label = entry.id ?? '(id 없음)';

    if (!entry.id) problems.push('id 가 없는 항목이 있습니다.');
    else if (seenIds.has(entry.id)) problems.push(`${label}: id 가 중복됩니다.`);
    else seenIds.add(entry.id);

    if (!PURPOSES.has(entry.purpose)) {
      problems.push(`${label}: purpose 는 dev|validation|test 중 하나여야 합니다 (지금 ${entry.purpose}).`);
    }
    if (!entry.path) problems.push(`${label}: path 가 없습니다.`);

    // 분리 검사 — 같은 경로가 두 갈래에 등록되면 그 순간 누수다.
    if (entry.path) {
      for (const [purpose, paths] of pathsByPurpose) {
        if (purpose !== entry.purpose && paths.has(entry.path)) {
          problems.push(`${label}: 같은 경로가 ${purpose} 와 ${entry.purpose} 양쪽에 등록됐습니다 — 누수입니다.`);
        }
      }
      const set = pathsByPurpose.get(entry.purpose) ?? new Set();
      set.add(entry.path);
      pathsByPurpose.set(entry.purpose, set);
    }

    const exists = entry.path && existsSync(entry.path);
    const current = exists ? hashPath(entry.path) : null;

    if (lockId && entry.id === lockId) {
      if (!exists) {
        problems.push(`${label}: 경로가 없어 잠글 수 없습니다 (${entry.path}).`);
      } else {
        entry.locked = true;
        entry.sha256 = current;
        locked = true;
        console.log(`LOCK  ${label} → ${current.slice(0, 16)}…`);
      }
      continue;
    }

    if (!entry.locked) {
      console.log(`SKIP  ${label} (${entry.purpose}) — 미잠금${exists ? '' : ' · 경로 없음(미구축)'}`);
      continue;
    }

    if (!exists) {
      problems.push(`${label}: 잠긴 항목인데 경로가 없습니다 (${entry.path}).`);
      continue;
    }
    if (!entry.sha256) {
      problems.push(
        `${label}: 잠겼는데 해시가 없습니다. 'npm run check:datasets -- --lock ${entry.id}' 로 봉인하세요.`,
      );
      continue;
    }
    if (entry.sha256 !== current) {
      problems.push(
        `${label}: 잠긴 테스트셋의 내용이 바뀌었습니다.\n` +
          `        기록 ${entry.sha256.slice(0, 16)}… / 현재 ${current.slice(0, 16)}…\n` +
          `        이 변경 이후의 수치는 이전 측정치와 비교할 수 없습니다. 정당한 변경이면 새 id 로 등록하세요.`,
      );
      continue;
    }
    console.log(`OK    ${label} (${entry.purpose}) — 고정됨 ${entry.sha256.slice(0, 16)}…`);
  }

  if (lockId && !seenIds.has(lockId)) {
    problems.push(`--lock ${lockId}: 그런 id 가 레지스트리에 없습니다.`);
  }
  if (locked) {
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`\n${MANIFEST} 갱신 완료.`);
  }

  if (problems.length > 0) {
    console.error('\n데이터셋 분리·고정 검사 실패:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\n데이터셋 분리·고정 검사 통과.');
}

main();
