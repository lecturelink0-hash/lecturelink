/**
 * 골든셋 실행 정리 — golden-run.ts 가 만든 테스트 업로드를 지운다.
 *
 *   npx tsx scripts/rag-eval/golden-cleanup.ts --out <결과 폴더> --label g0-off \
 *     --user <테스트 계정 uuid> --confirm-email <이메일> [--dry-run]
 *
 *   --label <이름>     결과 폴더의 이 실행 묶음에 적힌 업로드만 (여러 개면 쉼표)
 *   결과 기록(run<n>.json)과 시작 표지(run<n>.pending.<업로드id>.json) 둘 다 읽으므로, 하네스가 중간에
 *   죽어 기록 없이 남은 업로드도 지워진다. 계정 주인이 직접 올린 업로드는 대상이 아니다.
 *
 * 지우는 것: 스토리지 객체({user}/{upload}/…, crops 포함), user_uploads 행.
 * 문항·문항 이미지 연결·청크는 user_uploads 외래키(on delete cascade)로 함께 지워진다.
 * 남기는 것: ai_cost_log 행(측정 기록), 로컬 결과 JSON.
 *
 * 테스트 계정 확인(--confirm-email)을 통과하지 못하면 아무것도 지우지 않는다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const flag = (name: string) => argv.includes(name);
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const userId = opt('--user');
const confirmEmail = opt('--confirm-email');
const outRoot = opt('--out');
const labels = (opt('--label') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dryRun = flag('--dry-run');
if (!userId || !confirmEmail) die('필수: --user --confirm-email');
if (!outRoot || labels.length === 0) die('--out 과 --label 이 필요합니다.');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) die('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
const db = createClient(url, key, { auth: { persistSession: false } });
const BUCKET = 'user_uploads';

async function listRecursive(prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await db.storage.from(BUCKET).list(prefix, { limit: 100, offset });
    if (error) throw new Error(`스토리지 목록 실패 ${prefix}: ${error.message}`);
    for (const item of data ?? []) {
      const path = `${prefix}/${item.name}`;
      // 폴더 항목은 id 가 null 이다.
      if (item.id === null) out.push(...(await listRecursive(path)));
      else out.push(path);
    }
    if (!data || data.length < 100) break;
  }
  return out;
}

async function main() {
  const { data: authUser, error } = await db.auth.admin.getUserById(userId!);
  if (error || !authUser?.user) die(`계정 조회 실패: ${error?.message ?? '없음'}`);
  if ((authUser.user.email ?? '').toLowerCase() !== confirmEmail!.toLowerCase()) {
    die('--confirm-email 이 계정 이메일과 다릅니다. 아무것도 지우지 않습니다.');
  }

  let uploadIds: string[] = [];
  {
    for (const label of labels) {
      const dir = resolve(outRoot!, label);
      if (!existsSync(dir)) die(`결과 폴더 없음: ${dir}`);
      for (const k of readdirSync(dir)) {
        const kd = join(dir, k);
        if (k.endsWith('.json')) continue;
        for (const f of readdirSync(kd)) {
          if (!/^run\d+(\.(pending|invalid)\.[0-9a-f-]+)?\.json$/.test(f)) continue;
          const rec = JSON.parse(readFileSync(join(kd, f), 'utf8'));
          if (rec.userId !== userId) die(`다른 계정의 기록이 섞여 있습니다: ${join(kd, f)}`);
          uploadIds.push(rec.uploadId);
        }
      }
    }
  }
  uploadIds = [...new Set(uploadIds)];
  console.log(`대상 업로드 ${uploadIds.length}건${dryRun ? ' (dry-run)' : ''}`);

  let objects = 0;
  let rows = 0;
  for (const id of uploadIds) {
    const { data: row } = await db.from('user_uploads').select('id, user_id').eq('id', id).maybeSingle();
    if (row && row.user_id !== userId) die(`업로드 ${id} 의 소유자가 테스트 계정이 아닙니다. 멈춥니다.`);
    const paths = await listRecursive(`${userId}/${id}`);
    if (!dryRun && paths.length > 0) {
      for (let i = 0; i < paths.length; i += 100) {
        const { error: rmErr } = await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
        if (rmErr) die(`스토리지 삭제 실패 ${id}: ${rmErr.message}`);
      }
    }
    objects += paths.length;
    if (row) {
      if (!dryRun) {
        const { error: delErr } = await db.from('user_uploads').delete().eq('id', id).eq('user_id', userId!);
        if (delErr) die(`행 삭제 실패 ${id}: ${delErr.message}`);
      }
      rows += 1;
    }
  }
  console.log(`${dryRun ? '지울' : '지운'} 스토리지 객체 ${objects}개 · user_uploads 행 ${rows}개 (문항·청크는 연쇄 삭제)`);
}

main().catch((e) => {
  console.error('[golden-cleanup] 실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
