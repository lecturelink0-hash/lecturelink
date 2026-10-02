/**
 * material_chunks 의 결정론적 id (RAG 실행계획 v1.1 · Phase 0-c · F3)
 *
 * 종전에는 재처리 때 청크를 전부 지우고 다시 넣어 id(gen_random_uuid)가 매번 바뀌었다.
 * 그 사이에 저장된 문항의 source_refs.chunkIds 는 삭제된 행을 가리키게 되고, RAG 의 근거
 * 인용(evidence.chunk_id)도 같은 이유로 끊긴다. id 를 (업로드, 청크 번호, 내용 지문)에서
 * 계산하면 같은 업로드를 몇 번 다시 처리해도 같은 청크는 같은 id 를 갖는다.
 *
 * UUID v5(RFC 4122, SHA-1 이름 기반)를 쓴다. 컬럼 타입이 uuid 라 형식이 맞아야 하고,
 * 이름 기반이라 계산만으로 재현된다. 암호 용도가 아니므로 SHA-1 로 충분하다.
 *
 * 잎 모듈 규칙: node 내장 모듈 외에는 import 하지 않는다.
 */
import { createHash } from 'node:crypto';

/** material_chunks 전용 네임스페이스. 바꾸면 기존 청크의 id 가 전부 달라진다 — 바꾸지 말 것. */
export const MATERIAL_CHUNK_ID_NAMESPACE = '6f2b1c0e-5a4d-4e8b-9c3a-2d7e1f9b8a64';

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`invalid uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 §4.3 이름 기반 UUID v5. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  return bytesToUuid(bytes);
}

/**
 * (업로드, 청크 번호, 내용 지문) → 청크 id.
 *
 * 내용 지문까지 넣는 이유: OCR 결과와 문항용 이미지 선정은 실행마다 달라질 수 있다. 번호만으로
 * id 를 정하면 재처리 뒤 같은 번호·같은 id 가 **다른 그림의 OCR** 을 가리키게 되고, 예전 문항의
 * 출처가 조용히 엉뚱한 내용을 가리킨다. 지문을 넣으면 내용이 같을 때만 같은 id 가 되고,
 * 내용이 바뀐 청크의 옛 id 는 찾을 수 없는 id 가 되어 어긋남이 드러난다.
 * (같은 자료의 본문 청크는 재처리해도 내용이 같으므로 id 가 유지된다.)
 *
 * 주의: 같은 (upload_id, chunk_index) 행의 id 가 upsert 로 바뀔 수 있다. material_chunks.id 를
 * 참조하는 외래키를 새로 만들 때(예: 00045 의 parent_id)는 ON UPDATE CASCADE 로 두거나
 * 부모를 id 가 아닌 (upload_id, chunk_index) 로 가리켜야 한다.
 */
export function materialChunkId(uploadId: string, chunkIndex: number, contentSha: string): string {
  return uuidV5(`${uploadId}:${chunkIndex}:${contentSha}`, MATERIAL_CHUNK_ID_NAMESPACE);
}

/**
 * 캡션 청크가 가리키는 그림의 id(material_chunks.image_id, RAG 실행계획 v1.1 0-f).
 *
 * 그림만 따로 저장하는 표가 없어(문항에 쓰인 그림만 private_question_images 에 연결 행으로 남는다)
 * 외래키 대신 (업로드, 크롭 PNG 지문)에서 계산한다. 같은 업로드에서 같은 그림이면 재처리해도 같은 id 다.
 * 청크 id 와 섞이지 않게 이름에 'image' 를 넣는다.
 */
export function materialImageId(uploadId: string, imageKey: string): string {
  return uuidV5(`${uploadId}:image:${imageKey}`, MATERIAL_CHUNK_ID_NAMESPACE);
}
