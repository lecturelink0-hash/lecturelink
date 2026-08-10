import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/db/admin';
import { extractTeachingMaterial, TEACHING_MATERIAL_BUCKET, type TeachingMaterialRow } from './materials';

export function classifyMaterialError(error: unknown, fileType: string) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('storage_failed')) return { code: 'storage_failed', message: '저장된 원본 파일을 불러오지 못했습니다. 파일을 삭제한 뒤 다시 올려주세요.' };
  if (lower.includes('database_failed')) return { code: 'database_failed', message: '처리 결과를 저장하지 못했습니다. 잠시 후 다시 처리해주세요.' };
  if (/password|encrypted|암호/.test(lower)) return { code: 'encrypted_pdf', message: '암호화된 PDF는 처리할 수 없습니다. 암호를 해제한 뒤 다시 올려주세요.' };
  if (/timeout|timed out|abort/.test(lower)) return { code: 'extraction_timeout', message: '자료 처리 시간이 초과되었습니다. 다시 처리를 눌러주세요.' };
  if (/upload_integrity_failed/.test(lower)) return { code: 'upload_integrity_failed', message: '업로드된 파일이 원본과 일치하지 않습니다. 파일을 다시 선택해 올려주세요.' };
  if (/읽을 수 있는 텍스트|empty_material/.test(lower)) return { code: 'empty_material', message: '읽을 수 있는 텍스트가 없습니다. 스캔 자료라면 텍스트가 포함된 PDF로 다시 올려주세요.' };
  if (fileType === 'pdf') return { code: 'invalid_pdf', message: 'PDF 구조를 읽지 못했습니다. 파일을 다시 저장한 뒤 올려주세요.' };
  if (fileType === 'pptx') return { code: 'invalid_pptx', message: 'PPTX 구조를 읽지 못했습니다. 파일을 다시 저장한 뒤 올려주세요.' };
  return { code: 'processing_failed', message: '강의자료를 처리하지 못했습니다. 다시 시도해주세요.' };
}

export async function processTeachingMaterial(materialId: string, professorId: string) {
  const admin = createAdminClient() as any;
  const { data: row } = await admin.from('teaching_materials').select('*').eq('id', materialId).eq('professor_id', professorId).maybeSingle();
  if (!row) throw new Error('material_not_found');
  const material = row as TeachingMaterialRow;
  if (material.status === 'ready') return material;

  const lockMarker = '__processing_locked__';
  const ageMs = Date.now() - new Date(material.updated_at ?? material.created_at).getTime();
  if (material.error_message === lockMarker && ageMs < 2 * 60 * 1000) return null;

  const claimTime = new Date().toISOString();
  let claim = admin.from('teaching_materials')
    .update({ status: 'processing', error_message: lockMarker, updated_at: claimTime })
    .eq('id', materialId).eq('professor_id', professorId)
    .eq('updated_at', material.updated_at ?? material.created_at);
  claim = material.error_message === null
    ? claim.is('error_message', null)
    : claim.eq('error_message', material.error_message);
  const { data: claimed } = await claim.select('*').maybeSingle();
  if (!claimed) return null;

  console.info('[teaching-material]', { stage: 'processing_started', materialId, fileType: material.file_type });
  try {
    const { data: blob, error: downloadError } = await admin.storage.from(TEACHING_MATERIAL_BUCKET).download(material.storage_path);
    if (downloadError || !blob) throw new Error('storage_failed');
    const buffer = await blob.arrayBuffer();
    const bytes = Buffer.from(buffer);
    const expectedSize = Number(material.file_size_bytes);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (
      bytes.byteLength !== expectedSize ||
      actualHash !== material.file_hash ||
      (material.file_type === 'pdf' && !bytes.subarray(0, 1024).toString('latin1').includes('%PDF-'))
    ) {
      throw new Error(`upload_integrity_failed:size=${bytes.byteLength}/${expectedSize},hash=${actualHash === material.file_hash}`);
    }
    const file = new File([buffer], material.file_name, { type: material.mime_type });
    const extracted = await extractTeachingMaterial(file);
    const { data: ready, error: updateError } = await admin.from('teaching_materials').update({
      status: 'ready', page_count: extracted.pages.length, extracted_text: extracted.text,
      extracted_pages: extracted.pages, error_message: null, updated_at: new Date().toISOString(),
    }).eq('id', materialId).eq('professor_id', professorId).select('*').single();
    if (updateError || !ready) {
      const detail = updateError
        ? [updateError.code, updateError.message, updateError.details, updateError.hint].filter(Boolean).join(' | ')
        : 'update_returned_no_row';
      throw new Error(`database_failed:${detail}`);
    }
    console.info('[teaching-material]', { stage: 'processing_complete', materialId, fileType: material.file_type });
    return ready as TeachingMaterialRow;
  } catch (error) {
    const classified = classifyMaterialError(error, material.file_type);
    console.error('[teaching-material]', {
      stage: 'processing_failed',
      materialId,
      fileType: material.file_type,
      errorCode: classified.code,
      cause: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800),
    });
    await admin.from('teaching_materials').update({
      status: 'failed', error_message: `${classified.code}:${classified.message}`, updated_at: new Date().toISOString(),
    }).eq('id', materialId).eq('professor_id', professorId);
    throw new Error(`${classified.code}:${classified.message}`);
  }
}
