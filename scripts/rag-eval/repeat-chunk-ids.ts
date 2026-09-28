/**
 * 청크 id 재현성 (G0 '청크 ID') — 같은 upload_id 를 한 번 더 처리해 material_chunks id 가 유지되는지.
 *
 *   cd <체크아웃> && npx tsx scripts/rag-eval/repeat-chunk-ids.ts <결과 폴더>/<label>/<KEY>/run1.json
 *
 * 그 기록의 업로드를 같은 요청 조건으로 다시 생성한다(모델 비용이 한 번 더 든다). 업로드가 이미
 * 정리됐으면 쓸 수 없다. 결과는 기록 옆 chunkid-repeat.json 에 남긴다.
 * 본문 청크는 같은 자료라 전부 같은 id 여야 하고, OCR 청크는 OCR 결과가 같을 때만 같은 id 다
 * (materialChunkId 가 내용 지문을 포함하므로 sameId 와 sameContent 가 같아야 정상).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const recPath = process.argv[2];
if (!recPath) {
  console.error('사용: repeat-chunk-ids.ts <runN.json>');
  process.exit(1);
}
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
type Row = { id: string; chunk_index: number; page_index: number; kind: string; content_sha: string };
const snapshot = async (): Promise<Row[]> => {
  const { data, error } = await db
    .from('material_chunks')
    .select('id, chunk_index, page_index, kind, content_sha')
    .eq('upload_id', rec.uploadId)
    .order('chunk_index');
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
};

(async () => {
  const { generatePrivateQuestionsFromUpload } = await import(
    pathToFileURL(join(process.cwd(), 'lib/ai/private-generation.ts')).href
  );
  const before = await snapshot();
  if (before.length === 0) throw new Error('청크가 없습니다(업로드가 정리됐거나 처리 전).');
  const t0 = Date.now();
  await generatePrivateQuestionsFromUpload(rec.request);
  const after = await snapshot();
  const byIndex = new Map(after.map((c) => [c.chunk_index, c]));
  const compare = (kind: string) => {
    const b = before.filter((c) => c.kind === kind);
    return {
      before: b.length,
      after: after.filter((c) => c.kind === kind).length,
      sameId: b.filter((c) => byIndex.get(c.chunk_index)?.id === c.id).length,
      sameContent: b.filter((c) => byIndex.get(c.chunk_index)?.content_sha === c.content_sha).length,
    };
  };
  const out = { key: rec.key, uploadId: rec.uploadId, ms: Date.now() - t0, slide_text: compare('slide_text'), ocr: compare('ocr') };
  console.log(JSON.stringify(out));
  writeFileSync(recPath.replace(/run\d+\.json$/, 'chunkid-repeat.json'), JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
