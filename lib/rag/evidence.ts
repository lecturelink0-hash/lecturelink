/**
 * 묶음 근거 — 생성 묶음의 칸에 배정된 출제 단위들의 근거 팩을 하나의 생성 입력으로 묶는다
 * (RAG 실행계획 v1.1 · 5.2 G·I · PR I)
 *
 * on 에서만 쓴다. 묶음 하나는 칸(문항) 1~2개이고 칸마다 단위가 하나다(PR G 배정 + PR H 근거 부족 교체).
 *  - 단위 팩들의 청크를 합치고 중복을 없앤 뒤 [E1]… 번호를 새로 붙인다. 생성은 이 번호로 인용한다.
 *  - 단위 목록(주제·목표·근거 번호·칸 유형)을 문항 순서대로 붙인다. HyDE 발문은 넣지 않는다(검색 전용, 5.2 D).
 *  - 검증기 입력은 문항마다 그 문항의 근거(인용이 가장 많이 속한 단위의 팩 + 팩 밖 인용 청크)로 준다(5.2 I, F4).
 *
 * 외부 모듈은 잎 모듈만 불러온다 — 검사 스크립트(`npm run check:rag-cite`)가 이 파일을 직접 불러온다.
 */
import type { EvidenceChunk } from './cite.ts';
import type { PackEntry, UnitRetrieval } from './pack.ts';
import { unitFits, type PlanUnit, type SlotType } from './plan.ts';
import type { BatchQuota } from '../ai/type-plan.ts';

export interface SlotEvidenceInput {
  /** generation_slot. */
  slot: number;
  type: SlotType;
  unit: PlanUnit | null;
  retrieval: UnitRetrieval | null;
  /** 근거 부족(D3) 교체 뒤에도 맞는 단위가 없어 교체 전 단위를 그대로 쓰는 칸(PR J 에서 적게 제공·알림으로 바뀐다). */
  insufficient: boolean;
}

export interface BatchEvidenceUnit {
  slot: number;
  unitId: string;
  type: SlotType;
  refs: string[];
  insufficient: boolean;
  needsImage: boolean;
  figures: string[];
}

export interface BatchEvidence {
  /** 생성 입력(근거 자료 + 출제 단위 목록). */
  text: string;
  /** 번호 → 청크(모델에게 보인 글). */
  chunks: Map<string, EvidenceChunk>;
  units: BatchEvidenceUnit[];
  /** 근거 자료 부분의 글자 수(단위 목록 제외). */
  evidenceChars: number;
}

const SLOT_LABEL: Record<SlotType, string> = {
  image: '그림 판독 칸',
  clinical: '임상 증례형 칸',
  knowledge: '지식형 칸',
  free: '유형 자유 칸',
};

function kindLabel(kind: string): string {
  return kind === 'ocr' ? ', 그림 속 글자(OCR)' : kind === 'image_caption' ? ', 그림 설명' : '';
}

/** `[E1] (p.3) 본문` — 근거 팩(formatPack)과 같은 표기. */
export function formatEvidenceChunk(c: Pick<EvidenceChunk, 'ref' | 'pageIndex' | 'kind' | 'text'>): string {
  return `[${c.ref}] (p.${c.pageIndex}${kindLabel(c.kind)}) ${c.text}`;
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * 칸들의 단위 팩을 묶음 근거로 합친다. 팩이 있는 칸이 하나도 없으면 null(호출자는 현행 컨텍스트로 폴백).
 * 팩이 빈 칸은 단위 목록에서 빠진다 — 그 문항은 같은 묶음의 다른 근거로 만들어진다.
 */
export function buildBatchEvidence(slots: readonly SlotEvidenceInput[]): BatchEvidence | null {
  const chunks = new Map<string, EvidenceChunk>();
  const refOfChunk = new Map<string, string>();
  const units: BatchEvidenceUnit[] = [];
  const lines: string[] = [];
  for (const s of slots) {
    const pack: readonly PackEntry[] = s.retrieval?.pack ?? [];
    if (!s.unit || pack.length === 0) continue;
    const refs: string[] = [];
    pack.forEach((e, i) => {
      let ref = refOfChunk.get(e.chunkId);
      if (!ref) {
        ref = `E${chunks.size + 1}`;
        refOfChunk.set(e.chunkId, ref);
        chunks.set(ref, {
          ref,
          chunkId: e.chunkId,
          pageIndex: e.pageIndex,
          kind: e.kind,
          text: e.text,
          score: e.score,
          rank: i + 1,
          unitId: s.unit!.id,
        });
      }
      if (!refs.includes(ref)) refs.push(ref);
    });
    units.push({
      slot: s.slot,
      unitId: s.unit.id,
      type: s.type,
      refs,
      insufficient: s.insufficient,
      needsImage: s.unit.needsImage,
      figures: [...s.unit.figures],
    });
    lines.push(
      `${units.length}. [${SLOT_LABEL[s.type]}] 주제: ${oneLine(s.unit.topic, 80)} / 목표: ${oneLine(s.unit.objective, 160)} / 근거: ${refs.join(', ')}`,
    );
  }
  if (chunks.size === 0) return null;
  const evidenceText = [...chunks.values()].map(formatEvidenceChunk).join('\n\n');
  const text =
    `### 근거 자료 (강의자료에서 이번 묶음의 출제 단위에 맞춰 고른 부분)\n${evidenceText}\n\n` +
    `### 출제 단위 (문항 1개씩, 이 순서대로)\n${lines.join('\n')}`;
  return { text, chunks, units, evidenceChars: evidenceText.length };
}

/**
 * 한 문항의 근거 단위 — 인용 번호가 가장 많이 속한 단위. 인용이 없거나 동률이면 문항 순서(index)의 단위,
 * 그것도 없으면 첫 단위.
 */
export function unitForQuestion(ev: BatchEvidence, citedRefs: readonly string[], index: number): BatchEvidenceUnit | null {
  if (ev.units.length === 0) return null;
  const fallback = ev.units[index] ?? ev.units[0];
  let best: BatchEvidenceUnit | null = null;
  let bestHits = 0;
  for (const u of ev.units) {
    const hits = citedRefs.filter((r) => u.refs.includes(r)).length;
    if (hits > bestHits || (hits === bestHits && hits > 0 && u === fallback)) {
      best = u;
      bestHits = hits;
    }
  }
  return bestHits > 0 && best ? best : fallback;
}

/** 검증기 입력 — 그 문항 단위의 팩 + 팩 밖 인용 청크(같은 [E] 번호). */
export function questionEvidenceText(ev: BatchEvidence, citedRefs: readonly string[], index: number): string {
  const unit = unitForQuestion(ev, citedRefs, index);
  const refs = [...(unit?.refs ?? [])];
  for (const r of citedRefs) if (ev.chunks.has(r) && !refs.includes(r)) refs.push(r);
  return refs
    .map((r) => ev.chunks.get(r))
    .filter((c): c is EvidenceChunk => Boolean(c))
    .map(formatEvidenceChunk)
    .join('\n\n');
}

/** 묶음의 이미지 칸 단위가 가리키는 그림(계획 입력의 그림 id). */
export function batchFigureIds(ev: BatchEvidence): string[] {
  return [...new Set(ev.units.filter((u) => u.type === 'image' && u.needsImage).flatMap((u) => u.figures))];
}

/**
 * 칸마다 쓸 단위·근거를 고른다. D3 교체 뒤 단위(after)를 쓰고, 칸이 비었으면 교체 전 단위(before)를 근거
 * 부족 표시와 함께 쓴다. 단위 정보·검색 결과는 id 로 찾는다.
 */
export function slotEvidenceInputs(args: {
  slots: readonly number[];
  /** generation_slot → D3 교체 뒤 배정. */
  after: ReadonlyMap<number, { type: SlotType; unitId: string | null }>;
  /** generation_slot → 교체 전 배정. */
  before: ReadonlyMap<number, { type: SlotType; unitId: string | null }>;
  units: ReadonlyMap<string, PlanUnit>;
  retrievals: ReadonlyMap<string, UnitRetrieval>;
}): SlotEvidenceInput[] {
  return args.slots.map((slot) => {
    const a = args.after.get(slot);
    const b = args.before.get(slot);
    const useBefore = !a?.unitId && Boolean(b?.unitId);
    const unitId = a?.unitId ?? b?.unitId ?? null;
    const type: SlotType = a?.type ?? b?.type ?? 'free';
    return {
      slot,
      type,
      unit: unitId ? (args.units.get(unitId) ?? null) : null,
      retrieval: unitId ? (args.retrievals.get(unitId) ?? null) : null,
      insufficient: useBefore,
    };
  });
}

// ── 근거 부족(D3)·보충 (PR J) ────────────────────────────────────────────────

/**
 * 근거 부족 칸을 뺀 묶음 쿼터 — 빠진 칸의 유형(D3 교체 뒤)만큼 줄인다. 그 유형 몫이 이미 0 이면 free → 아무 유형 순으로 줄인다.
 * 합은 남은 칸 수와 같다.
 */
export function reduceQuota(quota: BatchQuota, skippedTypes: readonly SlotType[]): BatchQuota {
  const q = { ...quota };
  for (const t of skippedTypes) {
    const order: SlotType[] = [t, 'free', 'knowledge', 'clinical', 'image'];
    const k = order.find((x) => q[x] > 0);
    if (k) q[k] -= 1;
  }
  return q;
}

/** 쿼터를 칸 유형 목록으로 편다(이미지 → 임상 → 지식 → free, assignUnitsToSlots 와 같은 순서). */
export function expandQuota(quota: BatchQuota): SlotType[] {
  return [
    ...Array<SlotType>(Math.max(0, quota.image)).fill('image'),
    ...Array<SlotType>(Math.max(0, quota.clinical)).fill('clinical'),
    ...Array<SlotType>(Math.max(0, quota.knowledge)).fill('knowledge'),
    ...Array<SlotType>(Math.max(0, quota.free)).fill('free'),
  ];
}

/**
 * 보충 묶음의 칸마다 쓸 단위 — 부족 유형에 맞춰 다시 고른다(5.2 D3 '유형 교정은 대체된 단위 기준으로 다시 계산').
 *  - 칸의 원래 단위가 원하는 유형에 맞으면 그대로
 *  - 아니면 아직 안 쓴 예비 단위 중 근거가 충분하고(이미지면 그림 일치까지) 유형이 맞는 것
 *  - 그것도 없으면 원래 단위
 * used 는 고른 예비 단위를 기록한다(라운드를 넘어 같은 예비를 두 번 쓰지 않게 호출자가 들고 있는다).
 */
export function backfillSlotInputs(args: {
  slots: readonly number[];
  /** 칸별로 원하는 유형(보충 쿼터를 expandQuota 로 편 것). 모자라면 'free'. */
  wanted: readonly SlotType[];
  /** generation_slot → 칸의 단위(D3 교체 뒤). */
  slotUnit: ReadonlyMap<number, string | null>;
  /** 예비 단위 id(우선순). */
  reserve: readonly string[];
  used: Set<string>;
  units: ReadonlyMap<string, PlanUnit>;
  retrievals: ReadonlyMap<string, UnitRetrieval>;
}): Array<SlotEvidenceInput & { fromReserve: boolean }> {
  const ok = (id: string, t: SlotType) => {
    const u = args.units.get(id);
    const r = args.retrievals.get(id);
    if (!u || !r?.sufficient || r.pack.length === 0) return false;
    if (t === 'image' && r.captionMatch !== true) return false;
    return unitFits(u, t);
  };
  return args.slots.map((slot, i) => {
    const t: SlotType = args.wanted[i] ?? 'free';
    const own = args.slotUnit.get(slot) ?? null;
    let unitId = own;
    let fromReserve = false;
    if (!(own && ok(own, t)) && t !== 'free') {
      const pick = args.reserve.find((id) => !args.used.has(id) && ok(id, t));
      if (pick) {
        args.used.add(pick);
        unitId = pick;
        fromReserve = true;
      }
    }
    return {
      slot,
      type: t,
      unit: unitId ? (args.units.get(unitId) ?? null) : null,
      retrieval: unitId ? (args.retrievals.get(unitId) ?? null) : null,
      insufficient: false,
      fromReserve,
    };
  });
}
