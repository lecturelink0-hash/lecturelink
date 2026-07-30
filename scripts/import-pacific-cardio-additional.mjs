import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const payloadDir = resolve(root, 'outputs/pacific-cardio-20-additional/supabase-payload');
const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const questions = JSON.parse(await readFile(resolve(payloadDir, 'questions.json'), 'utf8'));
const images = JSON.parse(await readFile(resolve(payloadDir, 'open_images.json'), 'utf8'));
const storage = JSON.parse(await readFile(resolve(payloadDir, 'storage.json'), 'utf8'));
if (questions.length !== 20 || new Set(questions.map(q => q.id)).size !== 20) {
  throw new Error('Expected exactly 20 unique questions');
}

const subTopicIds = [
  '97e6b6b6-a295-4769-9cd1-d2839decc77c', '4f38cfb2-db6b-45d5-a17c-80d7f6de4a56',
  'e7ec4c9e-a256-471a-9d5c-7da9f6fc6517', '4dfa4da8-b66f-4e66-b212-e36692d47113',
  'cec0e2af-dd22-47cb-8694-0fc913e4d6cb', '4f9fdbec-8579-4368-8c34-5ad887d6e55e',
  '79d6c394-5482-40cf-8563-efa5fa60786f', '5036ad78-70e8-41a9-8404-fba02952b9c3',
  '30932607-02ec-4d7d-9023-0dd624e3330b', 'c38965e5-eacb-442d-9141-8b040c6b57dc',
  'e82a3248-75f5-405f-bab1-3c3018c5d8f0', '80657d40-88c7-4337-8f56-266569316ca3',
  'c7b8115c-e82f-4c36-9025-aa6b2651b993', '69e77613-78e8-4869-9fd1-59ed9a8e46a0',
  '71d18b86-cb9a-41da-839e-8e79a8db0f11', '38733638-fc40-434a-b9d0-973d4596e586',
  'd2e5bdcb-d02e-4387-ac08-64395e5f4d14', 'fec6e004-244f-4284-9762-3efeafa39484',
  '831945e7-d4c7-4dbb-af26-8bf0b4b6d486', '38733638-fc40-434a-b9d0-973d4596e586',
];

async function rest(path, init = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const idFilter = questions.map(q => q.id).join(',');
const existingQuestions = await rest(`questions?id=in.(${idFilter})&select=*`);
const sourceFilters = images.map(i => `and(source.eq.${encodeURIComponent(i.source)},source_id.eq.${encodeURIComponent(i.source_id)})`).join(',');
const existingImages = await rest(`open_images?or=(${sourceFilters})&select=*`);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(payloadDir, `db-backup-${timestamp}.json`);
await writeFile(backupPath, JSON.stringify({ existingQuestions, existingImages, storagePaths: storage.map(x => x.path) }, null, 2));
if (existingQuestions.length && existingQuestions.length !== 20) {
  throw new Error(`Partial prior import detected (${existingQuestions.length}/20); no writes performed`);
}
if (existingQuestions.length === 20) {
  console.log(JSON.stringify({ result: 'already-imported', questions: 20, backupPath }));
  process.exit(0);
}

for (const item of storage) {
  const body = await readFile(item.local);
  const response = await fetch(`${url}/storage/v1/object/open_images/${item.path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': item.content_type, 'x-upsert': 'true' },
    body,
  });
  if (!response.ok) throw new Error(`Storage upload failed ${item.path}: ${await response.text()}`);
}

const imageRows = images.map((image) => {
  const questionIndex = questions.findIndex(q => q._open_image_key?.[1] === image.source_id);
  return { ...image, sub_topic_id: questionIndex >= 0 ? subTopicIds[questionIndex] : null };
});
const savedImages = await rest('open_images?on_conflict=source,source_id', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify(imageRows),
});
const imageIdByKey = new Map(savedImages.map(i => [`${i.source}:${i.source_id}`, i.id]));
const publicBase = `${url}/storage/v1/object/public/open_images/`;
const sourceMeta = JSON.parse(await readFile(resolve(root, 'outputs/pacific-cardio-20-additional/questions.json'), 'utf8'));
const rows = questions.map((q, index) => {
  const openImageId = q._open_image_key ? imageIdByKey.get(`${q._open_image_key[0] === 'europe_pmc' ? 'pmc_open_access' : q._open_image_key[0]}:${q._open_image_key[1]}`) : null;
  const imagePath = q.image_url?.split('/open_images/')[1];
  return {
    id: q.id, sub_topic_id: subTopicIds[index], stem: q.stem, choices: q.choices,
    answer_index: q.answer_index, explanation: q.explanation,
    concepts: [sourceMeta[index].part, sourceMeta[index].sub_topic],
    difficulty: q.difficulty, review_notes: q.review_notes,
    image_url: imagePath ? publicBase + imagePath : null,
    image_type: q.image_type === 'echocardiography' ? 'ultrasound' : q.image_type,
    open_image_id: openImageId || null, source: 'ai_generated', tier: 'community', status: 'active',
  };
});
const inserted = await rest('questions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(rows),
});
const verified = await rest(`questions?id=in.(${idFilter})&select=id,sub_topic_id,stem,choices,answer_index,explanation,difficulty,image_url,image_type,open_image_id,source,tier,status`);
if (inserted.length !== 20 || verified.length !== 20 || verified.some(q => q.status !== 'active')) {
  throw new Error(`Post-write verification failed: inserted=${inserted.length}, verified=${verified.length}`);
}
for (const item of storage) await stat(item.local);
const afterPath = resolve(payloadDir, `db-after-${timestamp}.json`);
await writeFile(afterPath, JSON.stringify(verified, null, 2));
console.log(JSON.stringify({ result: 'imported', questions: verified.length, images: savedImages.length, backupPath, afterPath }));
