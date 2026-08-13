/**
 * Export a subject's active shared question bank from Supabase without changing it.
 *
 * Usage:
 *   node scripts/export-question-bank.mjs --subject-code nephrology \
 *     --output outputs/nephrology-review/original-questions.json
 *
 * Required local configuration (.env.local or .env; never commit it):
 *   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<server-only secret key>
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PAGE_SIZE = 500;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const name = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${name} 값이 필요합니다.`);
    }
    args[name] = value;
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
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

function toQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

function snapshotHash(question) {
  const stableQuestion = {
    stem: question.stem,
    choices: question.choices,
    answer_index: question.answer_index,
    explanation: question.explanation,
    concepts: question.concepts,
    difficulty: question.difficulty,
    image_url: question.image_url,
    image_type: question.image_type,
  };
  return createHash('sha256').update(JSON.stringify(stableQuestion)).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const subjectCode = args['subject-code'];
  const output = args.output;
  if (!subjectCode || !output) {
    throw new Error('사용법: --subject-code <code> --output <path>');
  }

  await loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다.');
  }

  const apiUrl = `${url}/rest/v1`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };

  async function request(table, params, options = {}) {
    const response = await fetch(`${apiUrl}/${table}?${toQuery(params)}`, {
      headers: { ...headers, ...(options.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  const subjects = await request('subjects', {
    select: 'id,name,code',
    code: `eq.${subjectCode}`,
  });
  const subject = subjects[0];
  if (!subject) throw new Error(`과목을 찾을 수 없습니다: ${subjectCode}`);

  const topics = await request('sub_topics', {
    select: 'id,name,code,sort_order',
    subject_id: `eq.${subject.id}`,
    order: 'sort_order.asc,code.asc',
  });
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));

  const questions = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await request(
      'questions',
      {
        select: 'id,sub_topic_id,stem,choices,answer_index,explanation,concepts,difficulty,image_url,image_type,tier,status,reviewed_by,reviewed_at,review_notes,updated_at,created_at',
        status: 'eq.active',
        sub_topic_id: `in.(${topics.map((topic) => topic.id).join(',')})`,
        order: 'created_at.asc,id.asc',
      },
      { headers: { Range: `${from}-${from + PAGE_SIZE - 1}` } },
    );
    questions.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const exportRows = questions.map((question) => ({
    ...question,
    sub_topic: topicById.get(question.sub_topic_id) ?? null,
    source_updated_at: question.updated_at,
    source_content_hash: snapshotHash(question),
  }));

  const payload = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    source: {
      subject,
      active_only: true,
      question_count: exportRows.length,
    },
    questions: exportRows,
  };

  const outputPath = path.resolve(output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Exported ${exportRows.length} active questions to ${outputPath}`);
}

await main();
