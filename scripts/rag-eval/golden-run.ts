/**
 * 골든셋 실행 하네스 (RAG 실행계획 v1.1 · G0 기준선 · E5 `off`/`on` 실행)
 *
 * 골든셋 자료를 테스트 계정으로 올리고 **운영과 같은 생성 함수**
 * (`generatePrivateQuestionsFromUpload`)를 직접 불러 문항을 만든 뒤, 실행 한 번마다
 * 업로드 상태·문항·청크·비용 행·진단을 JSON 으로 떠 둔다. 끝나면 원가·시간 기준선을 요약한다.
 *
 * 큐(QStash)와 할당량 차감(consumeQuotaCheckedStrict)은 거치지 않는다. 둘 다 생성 결과·원가에
 * 영향을 주지 않고, 할당량은 테스트 계정의 월 한도를 금방 소진시킨다.
 *
 *   set -a; . <secrets.env>; set +a
 *   cd <돌려 볼 코드의 체크아웃>        # 생성 코드는 **현재 폴더**의 것을 쓴다
 *   npx tsx <이 파일 경로> \
 *     --manifest <골든셋 폴더>/manifest.json --user <테스트 계정 uuid> --confirm-email <그 계정 이메일> \
 *     --label g0-off --runs 3 --out <골든셋 폴더>/runs
 *
 * 옵션
 *   --manifest <경로>        자료 목록(JSON). 형식은 아래 Manifest 참고. 저장소 밖에 둔다.
 *   --user <uuid>            실행 계정 id. 테스트 계정 또는 동의를 받은 팀원 계정만 쓴다.
 *   --confirm-email <이메일>  그 계정의 이메일. 다르면 실행하지 않는다(엉뚱한 계정 방지).
 *   --label <이름>           실행 묶음 이름(g0-off, pre-c, e5-on …). 출력 하위 폴더가 된다.
 *   --runs <n>               자료당 반복 횟수 (기본 1)
 *   --out <폴더>             결과 폴더. 저장소 밖에 둔다(문항·청크에 강의 원문이 들어간다).
 *   (코드 버전)              생성 코드는 현재 폴더(cwd)의 것을 쓴다. C 적용 전 비교처럼 다른
 *                            커밋으로 돌릴 때는 그 worktree 로 cd 해서 실행한다. tsx 는 `@/…`
 *                            별칭을 **시작 폴더의 tsconfig** 로 풀기 때문에, 다른 폴더의 코드를
 *                            경로로만 불러오면 별칭 import 가 시작 폴더 쪽 파일로 섞여 들어간다.
 *   --count <n>              요청 문항 수 (기본 10 — E5 조건)
 *   --difficulty <하|중|상>   (기본 중)
 *   --only <key,key>         이 자료만
 *   --budget <USD>           이번 실행 묶음(label) 누적 원가 상한. 넘으면 멈춘다 (기본 40)
 *   --global-day-limit <USD> 오늘(UTC) 운영 전체 AI 비용이 이 값을 넘으면 멈춘다 (기본 60).
 *                            운영 일일 캡(MAX_DAILY_AI_COST_USD, 기본 100)에 실제 사용자가 걸리지 않게.
 *   --keep-voyage            VOYAGE_API_KEY 를 지우지 않는다. 운영 Voyage 키는 죽어 있으므로(F7)
 *                            기본값은 지우고 돈다 — 그래야 운영과 같은 경로를 탄다.
 *   --dry-run                계정·자료·환경 점검만 하고 생성하지 않는다.
 *
 * 실행 간 격리
 *   생성 파이프라인은 같은 사용자가 같은 파일(content_sha256)을 전에 올렸으면 그때 만든 발문을
 *   "피해야 할 발문"으로 프롬프트에 싣는다(P11). 같은 자료를 3회 돌리면 2·3회차가 1회차의
 *   영향을 받아 기준선이 흔들린다. 그래서 매 실행 직전에 **이 하네스가 만든 업로드**(결과 폴더의
 *   기록·시작 표지에 적힌 id)만 골라 content_sha256 을 비운다. 원래 해시는 결과 JSON 에 남긴다.
 *   계정 주인이 직접 올린 업로드는 건드리지 않는다. 그런 업로드에 같은 파일이 있으면 그 자료는
 *   이전 발문이 섞이므로 실행하지 않고 건너뛴다(실제 사용자 계정으로 돌려도 안전하게).
 *
 * 정리
 *   `scripts/rag-eval/golden-cleanup.ts` 가 결과 폴더에 적힌 업로드만 지운다(스토리지·행).
 *   ai_cost_log 행은 측정 기록이라 남긴다. 생성 직전에 run<n>.pending.<업로드id>.json(업로드 id)을 먼저
 *   써 두므로, 하네스가 중간에 죽어도 그 업로드를 찾아 지울 수 있다.
 *
 * 저장소가 public 이므로 manifest·결과 폴더는 절대 커밋하지 않는다(v1.1 R3).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── 인자 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name: string, fallback: string | null = null): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const flag = (name: string) => argv.includes(name);

const manifestPath = opt('--manifest');
const userId = opt('--user');
const confirmEmail = opt('--confirm-email');
const label = opt('--label');
const outRoot = opt('--out');
const repoRoot = process.cwd();
const runs = Number(opt('--runs', '1'));
const count = Number(opt('--count', '10'));
const difficulty = (opt('--difficulty', '중') ?? '중') as '하' | '중' | '상';
const only = (opt('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const budgetUsd = Number(opt('--budget', '40'));
const globalDayLimitUsd = Number(opt('--global-day-limit', '60'));
const dryRun = flag('--dry-run');

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
if (!manifestPath || !userId || !confirmEmail || !label || !outRoot) {
  die('필수: --manifest --user --confirm-email --label --out (파일 머리말 참고)');
}
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label)) die(`--label 은 영문·숫자·._- 만: ${label}`);
if (!Number.isInteger(runs) || runs < 1) die('--runs 는 1 이상 정수');
if (!['하', '중', '상'].includes(difficulty)) die('--difficulty 는 하|중|상');

// ── 자료 목록 ─────────────────────────────────────────────────────────────────
/**
 * manifest.json
 * {
 *   "materials": [
 *     { "key": "S1", "file": "0904_1_위식도역류질환.pdf", "kind": "slide", "subject": "소화기" },
 *     { "key": "I1", "file": "해부조직1.pdf", "kind": "image", "subject": "소화기", "imageType": true }
 *   ]
 * }
 * kind: slide | notes | scan | image. file 은 manifest 기준 상대 경로도 된다.
 * imageType: true 면 요청 유형에 이미지형을 더한다(E5 조건: 이미지 자료 1건은 이미지형 포함).
 */
interface Material {
  key: string;
  file: string;
  kind: 'slide' | 'notes' | 'scan' | 'image';
  subject?: string;
  imageType?: boolean;
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { materials: Material[] };
const manifestDir = dirname(resolve(manifestPath));
const materials = manifest.materials
  .filter((m) => only.length === 0 || only.includes(m.key))
  .map((m) => ({ ...m, file: isAbsolute(m.file) ? m.file : join(manifestDir, m.file) }));
if (materials.length === 0) die('실행할 자료가 없습니다.');
const keys = new Set<string>();
for (const m of materials) {
  if (keys.has(m.key)) die(`manifest key 중복: ${m.key}`);
  keys.add(m.key);
  if (!existsSync(m.file)) die(`파일 없음: ${m.key} ${m.file}`);
  if (extname(m.file).toLowerCase() !== '.pdf') die(`골든셋은 PDF 만 다룬다: ${m.key}`);
}

// 결과 폴더가 저장소 안이면 거부한다 — 문항·청크에 강의 원문이 들어간다.
const outDir = resolve(outRoot, label);
for (const guarded of [repoRoot, process.cwd()]) {
  const rel = outDir.startsWith(guarded + '/') || outDir === guarded;
  if (rel && existsSync(join(guarded, '.git'))) die(`결과 폴더가 git 저장소 안입니다: ${outDir}`);
}

// ── 환경 ──────────────────────────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) die('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) die('생성 모델 키(GEMINI_API_KEY)가 필요합니다.');
if (!flag('--keep-voyage') && process.env.VOYAGE_API_KEY) {
  delete process.env.VOYAGE_API_KEY;
  console.log('· VOYAGE_API_KEY 를 비웠습니다(운영과 같게). 유지하려면 --keep-voyage');
}
// 생성 동작에 영향을 주는 설정. 값이 아니라 설정 여부·값 자체를 남긴다(비밀이 아닌 것만).
const BEHAVIOR_ENV = [
  'AI_PROVIDER', 'GEMINI_GEN_MODEL', 'GEMINI_VISION_MODEL', 'GEMINI_VERIFY_MODEL', 'GEMINI_IMAGE_MODEL',
  'GEMINI_THINKING_BUDGET', 'GEMINI_TIMEOUT_MS', 'PRIVATE_VERIFY_MODE', 'PRIVATE_BLIND_MODE', 'OCR_BACKEND',
  'ENABLE_TEXT_INPAINT', 'ENABLE_IMAGE_MARKERS', 'EMBEDDING_MODEL', 'VOYAGE_EMBED_MODEL', 'PRIVATE_RAG_MODE',
] as const;
const envSnapshot = Object.fromEntries(BEHAVIOR_ENV.map((k) => [k, process.env[k] ?? null]));

const db: SupabaseClient = createClient(url, serviceKey, { auth: { persistSession: false } });
const BUCKET = 'user_uploads';

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const usd = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(4)}`);

async function fetchAll<T>(build: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function globalSpendTodayUsd(): Promise<number> {
  const { data, error } = await db.rpc('check_daily_cost_within', { threshold_usd: 1e9 });
  if (error) throw new Error(`오늘 비용 조회 실패: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return Number(row?.current_usd ?? 0);
}

interface CostRow {
  endpoint: string;
  model?: string;
  cost_usd: number | string;
  input_tokens?: number;
  output_tokens?: number;
  metadata: Record<string, unknown> | null;
  created_at?: string;
}

async function costRowsFor(uploadId: string): Promise<CostRow[]> {
  return fetchAll<CostRow>(() =>
    db
      .from('ai_cost_log')
      .select('endpoint, model, cost_usd, input_tokens, output_tokens, metadata, created_at')
      .eq('metadata->>uploadId', uploadId)
      .order('created_at', { ascending: true }),
  );
}

/**
 * 비용 행이 다 들어올 때까지 기다린다. 헤지 패자 호출은 파이프라인이 끝난 뒤에 응답이 와서
 * 행이 늦게 붙는다. 행 수가 두 번 연속 그대로이고 진단 행이 있으면 끝난 것으로 본다.
 */
async function settledCostRows(uploadId: string): Promise<CostRow[]> {
  let last = -1;
  let stable = 0;
  let rows: CostRow[] = [];
  for (let i = 0; i < 24; i += 1) {
    rows = await costRowsFor(uploadId);
    const hasDiag = rows.some((r) => r.endpoint === 'private.diagnostics');
    stable = rows.length === last ? stable + 1 : 0;
    last = rows.length;
    if (hasDiag && stable >= 2) break;
    await sleep(5000);
  }
  return rows;
}

function mimeFor(file: string): string {
  return extname(file).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream';
}

function runFile(key: string, run: number) {
  return join(outDir, key, `run${run}.json`);
}

/** 결과 폴더 전체(모든 label)에서 이 하네스가 만든 업로드 id — 기록과 시작 표지 둘 다. */
function harnessUploadIds(): Set<string> {
  const ids = new Set<string>();
  const root = resolve(outRoot!);
  if (!existsSync(root)) return ids;
  for (const lab of readdirSync(root)) {
    const ld = join(root, lab);
    if (lab.endsWith('.json') || !existsSync(ld)) continue;
    for (const key of readdirSync(ld)) {
      const kd = join(ld, key);
      if (key.endsWith('.json')) continue;
      for (const f of readdirSync(kd)) {
        if (!/^run\d+(\.(pending|invalid)\.[0-9a-f-]+)?\.json$/.test(f)) continue;
        const rec = JSON.parse(readFileSync(join(kd, f), 'utf8'));
        if (rec.uploadId) ids.add(rec.uploadId);
      }
    }
  }
  return ids;
}

function readRunRecords(): Array<Record<string, any>> {
  if (!existsSync(outDir)) return [];
  const out: Array<Record<string, any>> = [];
  for (const key of readdirSync(outDir)) {
    const dir = join(outDir, key);
    if (!existsSync(dir) || key.endsWith('.json')) continue;
    for (const f of readdirSync(dir)) {
      if (/^run\d+\.json$/.test(f)) out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
  }
  return out;
}

// ── 본 실행 ──────────────────────────────────────────────────────────────────
async function main() {
  // 생성 코드는 현재 폴더의 것을 쓴다(파일 머리말 '코드 버전').
  if (!existsSync(join(repoRoot, 'lib/ai/private-generation.ts')) || !existsSync(join(repoRoot, 'tsconfig.json'))) {
    die(`현재 폴더가 lecturelink 체크아웃이 아닙니다: ${repoRoot}`);
  }
  const imp = (rel: string) => import(pathToFileURL(join(repoRoot, rel)).href);
  const { generatePrivateQuestionsFromUpload } = await imp('lib/ai/private-generation.ts');
  const { buildStoragePath } = await imp('lib/storage/paths.ts');
  const { summarizeUploadCosts } = await imp('lib/metrics/upload-cost.ts');

  // 계정 확인 — 운영 사용자에게 돌리는 사고를 막는다.
  const { data: authUser, error: authErr } = await db.auth.admin.getUserById(userId!);
  if (authErr || !authUser?.user) die(`계정 조회 실패: ${authErr?.message ?? '없음'}`);
  if ((authUser.user.email ?? '').toLowerCase() !== confirmEmail!.toLowerCase()) {
    die('--confirm-email 이 계정 이메일과 다릅니다. 실행하지 않습니다.');
  }
  const { data: profile } = await db.from('users').select('id, plan_tier').eq('id', userId!).maybeSingle();
  if (!profile) die('public.users 에 계정 행이 없습니다(가입 절차가 끝나지 않음).');

  const gitHead = (() => {
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }).trim();
      const dirty = git('status', '--porcelain', '--untracked-files=no') ? '+dirty' : '';
      return `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('rev-parse', '--short=12', 'HEAD')}${dirty}`;
    } catch {
      return null;
    }
  })();

  console.log(`[golden-run] label=${label} runs=${runs} 자료 ${materials.length}건 · 요청 ${count}문항 난이도 ${difficulty}`);
  console.log(`  repo=${repoRoot} (${gitHead ?? '?'}) · 결과 → ${outDir}`);
  console.log(`  예산 ${usd(budgetUsd)} · 운영 오늘 비용 상한 ${usd(globalDayLimitUsd)} · 설정 ${JSON.stringify(envSnapshot)}`);

  const fileInfo = new Map<string, { buf: Buffer; sha: string }>();
  for (const m of materials) {
    const buf = readFileSync(m.file);
    fileInfo.set(m.key, { buf, sha: sha256(buf) });
    console.log(`  ${m.key.padEnd(4)} ${m.kind.padEnd(6)} ${(buf.byteLength / 1e6).toFixed(1).padStart(5)}MB ${basename(m.file)}`);
  }
  if (dryRun) {
    console.log(`dry-run: 운영 오늘 비용 ${usd(await globalSpendTodayUsd())}. 생성하지 않고 끝냅니다.`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  let spent = readRunRecords().reduce((a, r) => a + Number(r.cost?.totalUsd ?? 0), 0);
  if (spent > 0) console.log(`  이 label 의 기존 실행 원가 ${usd(spent)} 를 예산에 포함합니다.`);

  for (let run = 1; run <= runs; run += 1) {
    for (const m of materials) {
      const target = runFile(m.key, run);
      if (existsSync(target)) {
        console.log(`- ${m.key} run${run}: 이미 있음(건너뜀)`);
        continue;
      }
      if (spent >= budgetUsd) {
        console.log(`예산 ${usd(budgetUsd)} 도달(누적 ${usd(spent)}). 멈춥니다.`);
        return summarize(summarizeUploadCosts);
      }
      const today = await globalSpendTodayUsd();
      if (today >= globalDayLimitUsd) {
        console.log(`운영 오늘 비용 ${usd(today)} ≥ ${usd(globalDayLimitUsd)}. 실제 사용자 보호를 위해 멈춥니다.`);
        return summarize(summarizeUploadCosts);
      }

      const { buf, sha } = fileInfo.get(m.key)!;
      // 실행 간 격리(P11) — 같은 해시 업로드 중 이 하네스가 만든 것만 해시를 비운다.
      const { data: sameSha, error: shaErr } = await db
        .from('user_uploads')
        .select('id')
        .eq('user_id', userId!)
        .eq('content_sha256', sha);
      if (shaErr) die(`같은 파일 조회 실패: ${shaErr.message}`);
      const ours = harnessUploadIds();
      const foreign = (sameSha ?? []).filter((r) => !ours.has(r.id as string));
      if (foreign.length > 0) {
        console.log(`- ${m.key} run${run}: 계정 주인이 같은 파일을 올린 이력 ${foreign.length}건 — 이전 발문이 섞이므로 건너뜀`);
        continue;
      }
      const toClear = (sameSha ?? []).map((r) => r.id as string);
      if (toClear.length > 0) {
        const { error: isoErr } = await db
          .from('user_uploads')
          .update({ content_sha256: null })
          .in('id', toClear)
          .eq('user_id', userId!);
        if (isoErr) die(`격리 실패(content_sha256 비우기): ${isoErr.message}`);
      }

      const uploadId = randomUUID();
      const fileName = basename(m.file);
      const storagePath: string = buildStoragePath(userId!, uploadId, fileName);
      // 시작 표지 — 중간에 죽어도 정리 스크립트가 이 업로드를 찾을 수 있게 먼저 남긴다.
      const pendingFile = target.replace(/\.json$/, `.pending.${uploadId}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(pendingFile, JSON.stringify({ label, key: m.key, run, uploadId, userId, startedAt: new Date().toISOString() }));
      const { error: upErr } = await db.storage
        .from(BUCKET)
        .upload(storagePath, buf, { contentType: mimeFor(m.file), upsert: false });
      if (upErr) die(`스토리지 업로드 실패 ${m.key}: ${upErr.message}`);
      const { error: insErr } = await db.from('user_uploads').insert({
        id: uploadId,
        user_id: userId,
        file_name: fileName,
        file_type: mimeFor(m.file),
        file_size_bytes: buf.byteLength,
        storage_path: storagePath,
        status: 'uploaded',
      });
      if (insErr) die(`user_uploads 생성 실패 ${m.key}: ${insErr.message}`);

      const request = {
        uploadId,
        userId: userId!,
        desiredCount: count,
        style: 'professor' as const, // 학생 화면(notes)이 보내는 값
        difficulty,
        questionTypes: m.imageType ? ['지식형', '임상형', '이미지형'] : ['지식형', '임상형'],
        title: `golden ${label} ${m.key} r${run}`,
      };
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      let result: Record<string, unknown> | null = null;
      let error: string | null = null;
      process.stdout.write(`- ${m.key} run${run} ${uploadId} … `);
      try {
        result = await generatePrivateQuestionsFromUpload(request);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const wallMs = Date.now() - t0;

      const costRows = await settledCostRows(uploadId);
      const [{ data: uploadRow }, questions, images, chunks] = await Promise.all([
        db.from('user_uploads').select('*').eq('id', uploadId).maybeSingle(),
        fetchAll<Record<string, unknown>>(() =>
          db.from('private_questions').select('*').eq('upload_id', uploadId).order('created_at', { ascending: true }),
        ),
        fetchAll<Record<string, unknown>>(() =>
          db.from('private_question_images').select('*').eq('upload_id', uploadId),
        ),
        fetchAll<Record<string, unknown>>(() =>
          db
            .from('material_chunks')
            .select('id, chunk_index, page_index, kind, char_count, content_sha, text')
            .eq('upload_id', uploadId)
            .order('chunk_index', { ascending: true }),
        ),
      ]);
      const { uploads: perUpload } = summarizeUploadCosts({
        rows: costRows,
        questionCounts: { [uploadId]: questions.length },
        uploadIds: [uploadId],
      });
      const cost = perUpload[0] ?? null;
      const diagnostics = costRows.filter((r) => r.endpoint === 'private.diagnostics').at(-1)?.metadata ?? null;

      const record = {
        label,
        key: m.key,
        run,
        kind: m.kind,
        subject: m.subject ?? null,
        file: fileName,
        fileSha256: sha,
        uploadId,
        userId,
        repo: { root: repoRoot, head: gitHead },
        env: envSnapshot,
        request,
        startedAt,
        wallMs,
        error,
        result,
        upload: uploadRow,
        questions,
        images,
        chunks,
        costRows,
        cost,
        diagnostics,
      };
      // 결제·크레딧 오류(402 · RESOURCE_EXHAUSTED)로 일부 배치가 빠진 실행은 기준선에 넣으면 안 된다.
      // 문항 수가 줄고 원가가 낮게 잡혀 기준선을 끌어내린다. 기록은 따로 남기고 멈춘다.
      const billingError = /\b402\b|RESOURCE_EXHAUSTED|prepayment credits/i.test(
        `${error ?? ''} ${JSON.stringify(diagnostics?.warnings ?? [])} ${JSON.stringify((diagnostics as any)?.batches ?? [])}`,
      );
      if (billingError) {
        writeFileSync(target.replace(/\.json$/, `.invalid.${uploadId}.json`), JSON.stringify(record, null, 2));
        rmSync(pendingFile, { force: true });
        console.log(`결제·크레딧 오류 — 이 실행(${uploadId})은 무효로 따로 남기고 멈춥니다. 정리 스크립트가 지웁니다.`);
        return summarize(summarizeUploadCosts);
      }
      writeFileSync(target, JSON.stringify(record, null, 2));
      rmSync(pendingFile, { force: true });
      spent += Number(cost?.totalUsd ?? 0);
      console.log(
        `${uploadRow?.status ?? '?'} · 문항 ${questions.length} · ${usd(cost?.totalUsd)} (문항당 ${usd(cost?.perQuestionUsd)}) · ${(wallMs / 1000).toFixed(0)}s` +
          (error ? ` · 오류: ${error.slice(0, 160)}` : ''),
      );
    }
  }
  return summarize(summarizeUploadCosts);
}

// ── 요약 ──────────────────────────────────────────────────────────────────────
function summarize(summarizeUploadCosts: (i: any) => any) {
  const records = readRunRecords();
  if (records.length === 0) return;
  const rows = records.flatMap((r) => r.costRows ?? []);
  const questionCounts = Object.fromEntries(records.map((r) => [r.uploadId, (r.questions ?? []).length]));
  const { aggregate } = summarizeUploadCosts({
    rows,
    questionCounts,
    uploadIds: records.map((r) => r.uploadId),
  });
  const wall = records.map((r) => Number(r.wallMs)).sort((a, b) => a - b);
  const p95Wall = wall[Math.min(wall.length - 1, Math.ceil(0.95 * wall.length) - 1)];
  const byKey: Record<string, unknown> = {};
  for (const r of records) {
    const k = (byKey[r.key] ??= { kind: r.kind, runs: [] as unknown[] }) as { runs: unknown[] };
    k.runs.push({
      run: r.run,
      uploadId: r.uploadId,
      status: r.upload?.status ?? null,
      questions: (r.questions ?? []).length,
      totalUsd: r.cost?.totalUsd ?? null,
      hedgeLoserUsd: r.cost?.hedgeLoserUsd ?? null,
      perQuestionUsd: r.cost?.perQuestionUsd ?? null,
      gapRatio: r.cost?.gapRatio ?? null,
      wallMs: r.wallMs,
      error: r.error,
    });
  }
  const summary = { label, generatedAt: new Date().toISOString(), runs: records.length, aggregate, p95WallMs: p95Wall, byKey };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n[요약]', label);
  console.log(
    `실행 ${records.length}회 · 총 ${usd(aggregate.totalUsd)} · 저장 문항 ${aggregate.totalQuestions} · ` +
      `문항당 원가 중앙값 ${usd(aggregate.medianPerQuestionUsd)} (가중 ${usd(aggregate.pooledPerQuestionUsd)})`,
  );
  console.log(
    `처리 시간 p95: 진단 ${aggregate.p95TotalMs == null ? '—' : (aggregate.p95TotalMs / 1000).toFixed(0) + 's'} · 벽시계 ${(p95Wall / 1000).toFixed(0)}s · ` +
      `원가 귀속 교차 검증 ${aggregate.gapWithinTolerance}/${aggregate.gapChecked} 통과`,
  );
  console.log(`→ ${join(outDir, 'summary.json')}`);
}

main().catch((e) => {
  console.error('[golden-run] 실패:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
