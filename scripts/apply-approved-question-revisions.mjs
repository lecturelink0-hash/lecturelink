/**
 * Safely apply an approved revision batch to Supabase.
 *
 * Dry run (default):
 *   node scripts/apply-approved-question-revisions.mjs \
 *     --input outputs/nephrology-review/four-unit-review-v15/revision-drafts.json \
 *     --batch-id nephrology-v15-20260728
 *
 * Apply:
 *   node scripts/apply-approved-question-revisions.mjs \
 *     --input outputs/nephrology-review/four-unit-review-v15/revision-drafts.json \
 *     --batch-id nephrology-v15-20260728 \
 *     --direct-patch \
 *     --apply
 *
 * Required local configuration (.env.local or .env; never commit it):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const APPLY_RPC = 'apply_approved_question_revision';
const PAGE_SIZE = 40;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const name = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    index += 1;
  }
  return args;
}

async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match && process.env[match[1]] === undefined) {
          process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
        }
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
}

function snapshotHash(question) {
  const stableQuestion = {
    stem: question.stem,
    choices: question.choices,
    answer_index: question.answer_index,
    explanation: question.explanation,
    concepts: question.concepts,
    difficulty: question.difficulty,
    image_url: question.image_url ?? null,
    image_type: question.image_type ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(stableQuestion))
    .digest('hex');
}

function validateRevision(item) {
  const revision = item.revision;
  if (!item.id || !item.source_content_hash || !revision) {
    throw new Error(`${item.id ?? 'unknown'}: revision metadata is incomplete`);
  }
  if (!revision.stem?.trim() || !revision.explanation?.trim()) {
    throw new Error(`${item.id}: stem or explanation is empty`);
  }
  if (!Array.isArray(revision.choices) || revision.choices.length !== 5) {
    throw new Error(`${item.id}: exactly five choices are required`);
  }
  if (
    !Number.isInteger(revision.answer_index) ||
    revision.answer_index < 0 ||
    revision.answer_index > 4
  ) {
    throw new Error(`${item.id}: answer index is invalid`);
  }
  if (!Number.isInteger(revision.difficulty) || revision.difficulty < 1 || revision.difficulty > 3) {
    throw new Error(`${item.id}: difficulty must be between 1 and 3`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const batchId = args['batch-id'];
  const apply = args.apply === true;
  const directPatch = args['direct-patch'] === true;
  if (!input || !batchId) {
    throw new Error('Usage: --input <revision-drafts.json> --batch-id <id> [--apply]');
  }

  await loadEnv();
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    throw new Error('Supabase URL or service-role key is missing');
  }

  const document = JSON.parse(await fs.readFile(input, 'utf8'));
  const revisions = document.revisions ?? [];
  if (document.database_write !== 'none' || revisions.length === 0) {
    throw new Error('Input is not a non-empty review draft');
  }
  revisions.forEach(validateRevision);

  const apiUrl = `${baseUrl}/rest/v1`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  async function request(endpoint, options = {}) {
    const response = await fetch(`${apiUrl}/${endpoint}`, {
      ...options,
      headers: { ...headers, ...(options.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Supabase ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  let schemaReady = true;
  try {
    await request('question_revisions?select=id&limit=1');
    const openApi = await request('');
    schemaReady = Boolean(
      openApi?.paths?.[`/rpc/${APPLY_RPC}`],
    );
  } catch (error) {
    if (error.status === 404 || error.status === 400) {
      schemaReady = false;
    } else {
      throw error;
    }
  }

  if (!schemaReady && !directPatch) {
    console.log(
      JSON.stringify(
        {
          status: 'schema_missing',
          required_migration:
            'supabase/migrations/00029_question_revisions.sql',
          apply_requested: apply,
          direct_patch_available: true,
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  const liveRows = [];
  const ids = revisions.map((item) => item.id);
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const pageIds = ids.slice(offset, offset + PAGE_SIZE);
    const query = new URLSearchParams({
      select:
        'id,stem,choices,answer_index,explanation,concepts,difficulty,image_url,image_type,tier,status,updated_at',
      id: `in.(${pageIds.join(',')})`,
    });
    const page = await request(`questions?${query.toString()}`);
    liveRows.push(...page);
  }
  const liveById = new Map(liveRows.map((row) => [row.id, row]));

  const pending = [];
  const alreadyApplied = [];
  const conflicts = [];
  for (const item of revisions) {
    const live = liveById.get(item.id);
    if (!live) {
      conflicts.push({ id: item.id, reason: 'missing_live_question' });
      continue;
    }
    const liveHash = snapshotHash(live);
    const desiredHash = snapshotHash({
      ...item.revision,
      image_url: live.image_url,
      image_type: live.image_type,
    });
    if (liveHash === desiredHash) {
      alreadyApplied.push(item.id);
      continue;
    }
    if (liveHash !== item.source_content_hash) {
      conflicts.push({ id: item.id, reason: 'live_content_changed' });
      continue;
    }
    pending.push({ item, live, desiredHash });
  }

  const preflight = {
    status: conflicts.length === 0 ? 'ready' : 'conflict',
    mode: apply ? 'apply' : 'dry_run',
    apply_method: schemaReady
      ? 'revision_rpc'
      : 'direct_patch_with_local_backup',
    batch_id: batchId,
    revision_count: revisions.length,
    pending_count: pending.length,
    already_applied_count: alreadyApplied.length,
    conflict_count: conflicts.length,
    answer_meaning_changed_count: revisions.filter(
      (item) => item.revision.answer_meaning_changed,
    ).length,
    schema_ready: schemaReady,
  };
  console.log(JSON.stringify(preflight, null, 2));

  if (conflicts.length > 0) {
    console.error(JSON.stringify({ conflicts }, null, 2));
    process.exitCode = 3;
    return;
  }
  if (!apply) return;

  const checkpointPath = path.resolve(
    args.checkpoint ??
      `outputs/nephrology-review/${batchId}-apply-checkpoint.json`,
  );
  const backupPath = path.resolve(
    args.backup ??
      `outputs/nephrology-review/${batchId}-preapply-target-backup.json`,
  );
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(
    backupPath,
    `${JSON.stringify(
      {
        batch_id: batchId,
        created_at: new Date().toISOString(),
        source_input: path.resolve(input),
        rows: liveRows,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const applied = [];
  for (const { item, live } of pending) {
    const revision = item.revision;
    let revisionId = null;
    let resultingUpdatedAt = null;
    if (schemaReady) {
      revisionId = await request(`rpc/${APPLY_RPC}`, {
        method: 'POST',
        body: JSON.stringify({
          p_question_id: item.id,
          p_expected_updated_at: live.updated_at,
          p_stem: revision.stem,
          p_choices: revision.choices,
          p_answer_index: revision.answer_index,
          p_explanation: revision.explanation,
          p_concepts: revision.concepts ?? [],
          p_difficulty: revision.difficulty,
          p_changed_by: null,
          p_approved_by: null,
          p_review_notes: 'KMLE·국시 형식 임상 검수 v15 승인 반영',
          p_mark_curated: false,
          p_batch_id: batchId,
          p_change_note: '신장 4개 단원 v15 검수 승인본 적용',
          p_source_content_hash: item.source_content_hash,
          p_action: 'apply',
        }),
      });
    } else {
      const query = new URLSearchParams({
        id: `eq.${item.id}`,
        updated_at: `eq.${live.updated_at}`,
      });
      const updatedRows = await request(`questions?${query.toString()}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          stem: revision.stem,
          choices: revision.choices,
          answer_index: revision.answer_index,
          explanation: revision.explanation,
          concepts: revision.concepts ?? [],
          difficulty: revision.difficulty,
          review_notes: 'KMLE·국시 형식 임상 검수 v15 승인 반영',
        }),
      });
      if (!Array.isArray(updatedRows) || updatedRows.length !== 1) {
        throw new Error(`${item.id}: version-guarded update changed no row`);
      }
      resultingUpdatedAt = updatedRows[0].updated_at ?? null;
    }
    applied.push({
      question_id: item.id,
      revision_id: revisionId,
      resulting_updated_at: resultingUpdatedAt,
    });
    await fs.writeFile(
      checkpointPath,
      `${JSON.stringify(
        {
          batch_id: batchId,
          input: path.resolve(input),
          apply_method: schemaReady
            ? 'revision_rpc'
            : 'direct_patch_with_local_backup',
          backup: backupPath,
          applied,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const verificationRows = [];
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const pageIds = ids.slice(offset, offset + PAGE_SIZE);
    const query = new URLSearchParams({
      select:
        'id,stem,choices,answer_index,explanation,concepts,difficulty,image_url,image_type,tier,status,updated_at',
      id: `in.(${pageIds.join(',')})`,
    });
    const page = await request(`questions?${query.toString()}`);
    verificationRows.push(...page);
  }
  const verifiedById = new Map(
    verificationRows.map((row) => [row.id, row]),
  );
  const verificationFailures = revisions
    .filter((item) => {
      const live = verifiedById.get(item.id);
      if (!live) return true;
      return (
        snapshotHash(live) !==
        snapshotHash({
          ...item.revision,
          image_url: live.image_url,
          image_type: live.image_type,
        })
      );
    })
    .map((item) => item.id);

  const result = {
    status: verificationFailures.length === 0 ? 'applied' : 'verification_failed',
    batch_id: batchId,
    applied_count: applied.length,
    already_applied_count: alreadyApplied.length,
    verified_count: revisions.length - verificationFailures.length,
    verification_failure_count: verificationFailures.length,
    checkpoint: checkpointPath,
    backup: backupPath,
    apply_method: schemaReady
      ? 'revision_rpc'
      : 'direct_patch_with_local_backup',
  };
  console.log(JSON.stringify(result, null, 2));
  if (verificationFailures.length > 0) {
    console.error(JSON.stringify({ verification_failures: verificationFailures }, null, 2));
    process.exitCode = 4;
  }
}

await main();
