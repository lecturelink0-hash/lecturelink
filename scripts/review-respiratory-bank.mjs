import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';

const SOURCE = process.argv[2] ?? 'C:/Users/sixth/Documents/Codex/2026-07-13/new-chat/outputs/respiratory_question_bank/reviews/cumulative_review.html';
const OUT_DIR = process.argv[3] ?? 'outputs/respiratory-editor-review';
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.REVIEW_CONCURRENCY ?? 2)));
const MODEL = process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-haiku-4-5-20251001';
const GEMINI_MODEL = process.env.GEMINI_VERIFY_MODEL ?? 'gemini-2.5-flash';
const GEMINI_MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 13000);
let nextGeminiAt = 0;

function decodeEntities(value) {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function first(text, regex, fallback = '') {
  const match = text.match(regex);
  return match ? decodeEntities(match[1]) : fallback;
}

function parseQuestions(html) {
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) ?? [];
  return articles.map((article, index) => {
    const heading = first(article, /<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const id = heading.match(/RESP-\d{6}/)?.[0] ?? `UNKNOWN-${index + 1}`;
    const stem = first(article, /<p\s+class="stem"[^>]*>([\s\S]*?)<\/p>/i);
    const beforeDetails = article.split(/<details\b/i)[0];
    const choiceBlock = beforeDetails.match(/<ol[^>]*>([\s\S]*?)<\/ol>/i)?.[1] ?? '';
    const choices = [...choiceBlock.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/gi)].map((m, i) => ({
      choice_id: `C${i + 1}`,
      text: decodeEntities(m[2]),
      is_correct: /class="[^"]*correct/.test(m[1]),
    }));
    const details = article.match(/<details\b[\s\S]*?<\/details>/i)?.[0] ?? '';
    const paragraphs = [...details.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decodeEntities(m[1]));
    const explanationItems = [...(details.match(/<ol\s+class="explanations"[^>]*>([\s\S]*?)<\/ol>/i)?.[1] ?? '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => decodeEntities(m[1]));
    const sourceLinks = [...details.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ url: m[1], title: decodeEntities(m[2]) }));
    const sourceParagraph = paragraphs.find((p) => /^(근거|출처)\s*:/.test(p)) ?? '';
    const badge = first(article, /<p\s+class="badge"[^>]*>([\s\S]*?)<\/p>/i);
    return {
      question_id: id,
      heading,
      badge,
      stem,
      lead_in: stem.match(/[^.!?。]+[?？]\s*$/)?.[0]?.trim() ?? '',
      choices,
      existing_answer: choices.find((c) => c.is_correct)?.choice_id ?? null,
      existing_core_explanation: paragraphs.find((p) => /^정답 해설\s*:/.test(p))?.replace(/^정답 해설\s*:\s*/, '') ?? paragraphs[2] ?? '',
      existing_choice_explanations: explanationItems,
      references: sourceLinks,
      reference_text: sourceParagraph.replace(/^(근거|출처)\s*:\s*/, ''),
      reference_date: '2026-07-15',
    };
  });
}

const SYSTEM = `너는 한국 의과대학생 문제은행의 호흡기내과 문항 편집자다. 목표는 정답을 암기시키는 것이 아니라 오답을 만든 임상적 오개념을 교정하는 것이다.

규칙:
1. 먼저 지문만으로 기존 정답이 도출되는지 확인한다.
2. 각 선택지를 독립적으로 분석한다.
3. 정답 선택지는 결정적 단서를 설명한다.
4. 오답 선택지는 의미, 지문과 충돌하는 단서, 맞을 수 있는 조건을 설명한다.
5. 같은 일반론을 반복하지 않는다.
6. 제공된 근거에 없는 수치, 적응증, 금기, 권고 등급을 만들지 않는다.
7. 기존 정답이 의심스러우면 보류한다.
8. 선택지당 2~4문장으로 쓴다.
9. 검증된 근거가 비어 있으면 publication_recommendation은 hold로 한다.
10. 외부 지식으로 출처를 만들어내지 않는다.

금지: 정답 문장 반복, 동일 템플릿 복제, 지문에 없는 상태 가정, 근거 없는 절대 표현.`;

const TOOL = {
  name: 'submit_editor_review',
  description: '문항 편집 검수 결과를 제출한다.',
  input_schema: {
    type: 'object',
    properties: {
      question_id: { type: 'string' },
      answer_consistency: { type: 'string', enum: ['confirmed', 'questionable', 'contradicted'] },
      core_reasoning: {
        type: 'object',
        properties: {
          key_findings: { type: 'array', items: { type: 'string' } },
          clinical_inference: { type: 'string' },
          best_answer: { type: ['string', 'null'] },
        },
        required: ['key_findings', 'clinical_inference', 'best_answer'],
      },
      choice_explanations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            choice_id: { type: 'string' },
            verdict: { type: 'string', enum: ['correct', 'incorrect', 'conditionally_correct'] },
            explanation: { type: 'string' },
            could_be_correct_if: { type: ['string', 'null'] },
            misconception_tag: { type: 'string', enum: ['진단 오류', '검사 순서', '적응증', '금기', '치료 우선순위', '병태생리', '기타'] },
          },
          required: ['choice_id', 'verdict', 'explanation', 'could_be_correct_if', 'misconception_tag'],
        },
      },
      review_flags: { type: 'array', items: { type: 'string' } },
      publication_recommendation: { type: 'string', enum: ['approve', 'revise', 'hold'] },
    },
    required: ['question_id', 'answer_consistency', 'core_reasoning', 'choice_explanations', 'review_flags', 'publication_recommendation'],
  },
};

async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    } catch {}
  }
}

function geminiSchema(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  const type = Array.isArray(node.type) ? node.type.find((v) => v !== 'null') : node.type;
  if (type) out.type = String(type).toUpperCase();
  if (Array.isArray(node.type) && node.type.includes('null')) out.nullable = true;
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = node.enum;
  if (node.properties) out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, geminiSchema(v)]));
  if (node.required) out.required = node.required;
  if (node.items) out.items = geminiSchema(node.items);
  return out;
}

async function callGemini(question) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const waitForSlot = Math.max(0, nextGeminiAt - Date.now());
    if (waitForSlot) await new Promise((resolve) => setTimeout(resolve, waitForSlot));
    nextGeminiAt = Date.now() + GEMINI_MIN_INTERVAL_MS;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: `다음 문항을 검수하라. 제공된 JSON 밖의 근거를 만들어내지 마라.\n\n${JSON.stringify(question)}` }] }],
      tools: [{ functionDeclarations: [{ name: TOOL.name, description: TOOL.description, parameters: geminiSchema(TOOL.input_schema) }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL.name] } },
      generationConfig: { maxOutputTokens: 3500, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(90000),
    });
    const text = await response.text();
    if (response.status === 429 && attempt < 8) {
      const seconds = Number(text.match(/retry in ([0-9.]+)s/i)?.[1] ?? 15);
      await new Promise((resolve) => setTimeout(resolve, Math.max(15000, Math.ceil(seconds * 1000))));
      continue;
    }
    if (!response.ok) throw new Error(`Gemini API ${response.status}: ${text.slice(0, 500)}`);
    const json = JSON.parse(text);
    const call = json.candidates?.[0]?.content?.parts?.find((part) => part.functionCall)?.functionCall;
    if (!call?.args) throw new Error('Gemini 구조화된 결과 없음');
    return { input: call.args, model: GEMINI_MODEL };
  }
  throw new Error('Gemini 재시도 한도 초과');
}

async function callAnthropic(client, question) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3500,
    temperature: 0,
    system: SYSTEM,
    messages: [{ role: 'user', content: `다음 문항을 검수하라. 제공된 JSON 밖의 근거를 만들어내지 마라.\n\n${JSON.stringify(question)}` }],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
  });
  const block = response.content.find((item) => item.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('구조화된 결과 없음');
  return { input: block.input, model: MODEL };
}

async function main() {
  await loadEnv();
  const useGemini = Boolean(process.env.GEMINI_API_KEY);
  if (!useGemini && !process.env.ANTHROPIC_API_KEY) throw new Error('GEMINI_API_KEY 또는 ANTHROPIC_API_KEY가 없습니다.');
  await fs.mkdir(OUT_DIR, { recursive: true });
  const html = await fs.readFile(SOURCE, 'utf8');
  const questions = parseQuestions(html);
  await fs.writeFile(path.join(OUT_DIR, 'extracted-questions.json'), JSON.stringify(questions, null, 2), 'utf8');

  const resultFile = path.join(OUT_DIR, 'editor-reviews.jsonl');
  let completed = new Set();
  try {
    const prior = await fs.readFile(resultFile, 'utf8');
    completed = new Set(prior.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).question_id));
  } catch {}

  const limit = Number(process.env.REVIEW_LIMIT ?? 0);
  const allPending = questions.filter((q) => !completed.has(q.question_id));
  const pending = limit > 0 ? allPending.slice(0, limit) : allPending;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90000, maxRetries: 2 });
  let cursor = 0;
  let ok = completed.size;
  const failures = [];
  let fatalError = null;

  async function worker() {
    while (true) {
      if (fatalError) return;
      const index = cursor++;
      if (index >= pending.length) return;
      const q = pending[index];
      try {
        const reviewed = useGemini ? await callGemini(q) : await callAnthropic(client, q);
        const result = { ...reviewed.input, _meta: { model: reviewed.model, reviewed_at: new Date().toISOString(), has_reference: q.references.length > 0 || Boolean(q.reference_text) } };
        await fs.appendFile(resultFile, `${JSON.stringify(result)}\n`, 'utf8');
        ok += 1;
        if (ok % 10 === 0 || ok === questions.length) console.log(`progress ${ok}/${questions.length}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ question_id: q.question_id, error: message });
        if (/credit balance is too low|authentication_error|invalid x-api-key|api key not valid/i.test(message)) {
          fatalError = message;
        }
        console.error(`failed ${q.question_id}: ${failures.at(-1).error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  let resultText = '';
  try { resultText = await fs.readFile(resultFile, 'utf8'); } catch {}
  const lines = resultText.trim().split(/\r?\n/).filter(Boolean);
  const results = lines.map((line) => JSON.parse(line)).sort((a, b) => a.question_id.localeCompare(b.question_id));
  await fs.writeFile(path.join(OUT_DIR, 'editor-reviews.json'), JSON.stringify(results, null, 2), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'failures.json'), JSON.stringify(failures, null, 2), 'utf8');
  const summary = {
    source: SOURCE,
    total: questions.length,
    completed: results.length,
    failures: failures.length,
    fatal_error: fatalError,
    recommendations: Object.groupBy(results, (r) => r.publication_recommendation),
    consistency: Object.groupBy(results, (r) => r.answer_consistency),
  };
  for (const key of ['recommendations', 'consistency']) {
    summary[key] = Object.fromEntries(Object.entries(summary[key]).map(([k, v]) => [k, v.length]));
  }
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
