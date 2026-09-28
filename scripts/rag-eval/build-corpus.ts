/**
 * 오프라인 재생 코퍼스 만들기 (RAG 실행계획 v1.1 · 0-i · 실험 E1~E3)
 *
 * 골든셋 자료를 **운영과 같은 추출 경로**(extractFromBuffer, 이미지형 미선택)로 페이지 본문까지
 * 뽑고, E2 조건별로 청크를 만든다. 모델 호출·DB 접근 없음(텍스트 전용 경로는 외부 호출이 없다).
 *
 *   cd <체크아웃> && npx tsx scripts/rag-eval/build-corpus.ts \
 *     --manifest <골든셋>/manifest.json --out <작업 폴더>/corpus.json [--check-runs <결과 폴더>/g0-off]
 *
 * 청크 조건
 *   L1_1200 : 운영 청크(buildTextFirstChunks, 1,200자) — E1·E3·E2-a·E2-b 의 검색 단위
 *   L1_600  : 같은 규칙, 600자 — E2-c 의 검색 단위
 *   pages   : 페이지 본문(level 0) — E2-b·E2-c 의 부모
 * 본문 청크만 다룬다. OCR·이미지 캡션 청크는 이미지형 요청에서만 생기므로 PR F 이후 평가한다.
 *
 * --check-runs 를 주면 G0 실행 기록의 운영 청크(material_chunks)와 L1_1200 이 내용 지문까지
 * 같은지 대조한다. 다르면 이 코퍼스는 운영을 대변하지 못하므로 실패로 끝낸다.
 *
 * 출력에는 강의 원문이 들어가므로 저장소 밖에 둔다(v1.1 R3).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const manifestPath = opt('--manifest');
const outPath = opt('--out');
const checkRuns = opt('--check-runs');
if (!manifestPath || !outPath) {
  console.error('필수: --manifest <manifest.json> --out <corpus.json>');
  process.exit(1);
}
if (existsSync(join(dirname(resolve(outPath)), '.git')) || resolve(outPath).startsWith(process.cwd() + '/')) {
  console.error('출력이 저장소 안입니다. 강의 원문이 들어가므로 저장소 밖에 두세요.');
  process.exit(1);
}

interface Material {
  key: string;
  file: string;
  kind: string;
  subject?: string;
}
export interface CorpusChunk {
  id: string;
  chunkIndex: number;
  pageIndex: number;
  parentId: string;
  text: string;
  sha: string;
}
export interface CorpusMaterial {
  key: string;
  kind: string;
  subject: string | null;
  fileSha256: string;
  pages: Array<{ id: string; pageIndex: number; text: string }>;
  L1_1200: CorpusChunk[];
  L1_600: CorpusChunk[];
}

(async () => {
  const imp = (rel: string) => import(pathToFileURL(join(process.cwd(), rel)).href);
  const { extractFromBuffer } = await imp('lib/ai/private-generation.ts');
  const { buildTextFirstChunks } = await imp('lib/extract/chunk.ts');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { materials: Material[] };
  const base = dirname(resolve(manifestPath));
  const out: CorpusMaterial[] = [];
  let mismatch = 0;

  for (const m of manifest.materials) {
    const file = isAbsolute(m.file) ? m.file : join(base, m.file);
    const buf = readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const warnings: string[] = [];
    const diag = { timings: {}, extract: {}, embedded: {} };
    const { slides } = await extractFromBuffer({
      buffer: ab,
      fileType: 'application/pdf',
      userIdForLog: 'rag-eval',
      wantsImages: false,
      maxFeatured: 0,
      warnings,
      diag,
    });
    const pages = (slides as Array<{ pageIndex: number; text: string }>)
      .filter((s) => (s.text ?? '').trim().length > 0)
      .map((s) => ({ id: `${m.key}#p${s.pageIndex}`, pageIndex: s.pageIndex, text: s.text }));
    const input = pages.map((p) => ({ pageIndex: p.pageIndex, slideText: p.text, ocrTexts: [] }));
    const mk = (size: number) =>
      (buildTextFirstChunks(input, { maxChars: size }) as Array<{ chunkIndex: number; pageIndex: number; text: string; sha256: string }>).map(
        (c) => ({
          id: `${m.key}#${size}:${c.chunkIndex}`,
          chunkIndex: c.chunkIndex,
          pageIndex: c.pageIndex,
          parentId: `${m.key}#p${c.pageIndex}`,
          text: c.text,
          sha: c.sha256,
        }),
      );
    const material: CorpusMaterial = {
      key: m.key,
      kind: m.kind,
      subject: m.subject ?? null,
      fileSha256: createHash('sha256').update(buf).digest('hex'),
      pages,
      L1_1200: mk(1200),
      L1_600: mk(600),
    };
    out.push(material);

    let note = '';
    if (checkRuns) {
      const rec = join(checkRuns, m.key, 'run1.json');
      if (existsSync(rec)) {
        const prod = (JSON.parse(readFileSync(rec, 'utf8')).chunks as Array<{ kind: string; content_sha: string }>)
          .filter((c) => c.kind === 'slide_text')
          .map((c) => c.content_sha);
        const mine = material.L1_1200.map((c) => c.sha);
        const same = prod.length === mine.length && prod.every((s, i) => s === mine[i]);
        if (!same) mismatch += 1;
        note = same ? ` · 운영 청크와 동일(${prod.length})` : ` · 운영 청크와 다름(운영 ${prod.length} vs ${mine.length})`;
      } else {
        note = ' · 대조할 기록 없음';
      }
    }
    console.log(
      `${m.key.padEnd(4)} ${m.kind.padEnd(6)} 페이지 ${String(pages.length).padStart(3)} · 청크 1200=${material.L1_1200.length} 600=${material.L1_600.length} · 글자 ${pages.reduce((a, p) => a + p.text.length, 0)}${note}`,
    );
  }

  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), materials: out }, null, 1));
  console.log(`→ ${outPath}`);
  if (mismatch > 0) {
    console.error(`운영 청크와 다른 자료 ${mismatch}건 — 코퍼스가 운영을 대변하지 못합니다.`);
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
