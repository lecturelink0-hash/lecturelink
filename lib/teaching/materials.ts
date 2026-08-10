import { createHash } from 'node:crypto';
import { parsePptx } from '@/lib/extract/pptx';
import { extractPdfTextPages } from '@/lib/extract/render-slides';
import { createServerClient } from '@/lib/db/server';
import { ApiException } from '@/lib/utils/api';

export const TEACHING_MATERIAL_BUCKET = 'teaching-materials';
export const MAX_TEACHING_MATERIAL_BYTES = 25 * 1024 * 1024;
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export type CachedMaterialPage = { pageIndex: number; text: string };
export type TeachingMaterialRow = {
  id: string;
  course_id: string;
  professor_id: string;
  file_name: string;
  file_type: 'pdf' | 'pptx';
  mime_type: string;
  file_size_bytes: number;
  file_hash: string;
  storage_path: string;
  status: 'processing' | 'ready' | 'failed';
  page_count: number | null;
  extracted_text: string | null;
  extracted_pages: CachedMaterialPage[];
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export function materialFileType(file: File): 'pdf' | 'pptx' {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (file.type === PPTX_MIME || name.endsWith('.pptx')) return 'pptx';
  throw new ApiException('unsupported_file', 'PPTX 또는 PDF 파일만 지원합니다.', 400);
}

export async function hashFile(file: File) {
  return createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
}

export async function extractTeachingMaterial(file: File): Promise<{
  pages: CachedMaterialPage[];
  text: string;
}> {
  const buffer = await file.arrayBuffer();
  const type = materialFileType(file);
  const pages = type === 'pptx'
    ? parsePptx(buffer).slides.map((slide) => ({ pageIndex: slide.index, text: slide.text }))
    : await extractPdfTextPagesWithFallback(buffer);
  const normalizedPages = pages.map((page) => ({
    ...page,
    text: sanitizeDatabaseText(page.text),
  }));
  const usable = normalizedPages.filter((page) => page.text.trim());
  if (usable.length === 0) {
    throw new ApiException('empty_material', '강의자료에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
  }
  return {
    pages: normalizedPages,
    text: normalizedPages.map((page) => `[${type === 'pptx' ? '슬라이드' : '페이지'} ${page.pageIndex}] ${page.text}`).join('\n').slice(0, 500_000),
  };
}

function sanitizeDatabaseText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function extractPdfTextPagesWithFallback(buffer: ArrayBuffer): Promise<CachedMaterialPage[]> {
  const fallbackErrors: string[] = [];

  try {
    const { default: pdfParse } = await import('pdf-parse');
    const pages: CachedMaterialPage[] = [];
    let pageIndex = 0;
    await pdfParse(Buffer.from(buffer), {
      max: 200,
      pagerender: async (pageData: { getTextContent: (options?: object) => Promise<{ items: Array<{ str?: string }> }> }) => {
        pageIndex += 1;
        const content = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });
        const text = content.items
          .map((item) => item.str ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        pages.push({ pageIndex, text });
        return text;
      },
    });
    if (pages.length > 0) return pages;
    fallbackErrors.push('pdf_parse:no_pages');
  } catch (error) {
    fallbackErrors.push(`pdf_parse:${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return await extractPdfTextPages(buffer);
  } catch (error) {
    fallbackErrors.push(`pdfjs:${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`pdf_extraction_failed:${fallbackErrors.join(' | ')}`);
  }
}

export async function getOwnedTeachingMaterial(materialId: string, professorId: string) {
  const db = await createServerClient() as any;
  const { data } = await db
    .from('teaching_materials')
    .select('*')
    .eq('id', materialId)
    .eq('professor_id', professorId)
    .maybeSingle();
  if (!data) throw new ApiException('material_not_found', '선택한 강의자료를 찾을 수 없습니다.', 404);
  if (data.status !== 'ready') throw new ApiException('material_not_ready', '강의자료 처리가 아직 완료되지 않았습니다.', 409);
  return data as TeachingMaterialRow;
}

export async function loadTeachingMaterialFile(materialId: string, professorId: string) {
  const db = await createServerClient() as any;
  const { data: owned } = await db
    .from('teaching_materials')
    .select('*')
    .eq('id', materialId)
    .eq('professor_id', professorId)
    .maybeSingle();
  if (!owned) throw new ApiException('material_not_found', '선택한 강의자료를 찾을 수 없습니다.', 404);

  let material = owned as TeachingMaterialRow;
  const { data, error } = await db.storage.from(TEACHING_MATERIAL_BUCKET).download(material.storage_path);
  if (error || !data) throw new ApiException('material_download_failed', '저장된 강의자료를 불러오지 못했습니다.', 500);
  const file = new File([await data.arrayBuffer()], material.file_name, { type: material.mime_type });

  if (material.status !== 'ready') {
    try {
      const extracted = await extractTeachingMaterial(file);
      const { data: repaired, error: repairError } = await db
        .from('teaching_materials')
        .update({
          status: 'ready',
          page_count: extracted.pages.length,
          extracted_text: extracted.text,
          extracted_pages: extracted.pages,
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', material.id)
        .eq('professor_id', professorId)
        .select('*')
        .single();
      if (repairError || !repaired) {
        throw new ApiException('material_repair_failed', '강의자료 처리 상태를 갱신하지 못했습니다.', 500);
      }
      material = repaired as TeachingMaterialRow;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '강의자료를 다시 처리하지 못했습니다.';
      await db
        .from('teaching_materials')
        .update({ status: 'failed', error_message: message, updated_at: new Date().toISOString() })
        .eq('id', material.id)
        .eq('professor_id', professorId);
      throw cause;
    }
  }
  return { material, file };
}
