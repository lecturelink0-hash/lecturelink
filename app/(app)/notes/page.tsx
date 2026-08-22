'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { api, ApiError } from '@/lib/api/client';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { UploadDropZone } from '@/components/ui/UploadDropZone';
import { UploadNextSteps } from '@/components/ui/UploadNextSteps';
import { GuideLabel } from '@/components/ui/GuideLabel';
import { Segmented } from '@/components/ui/Segmented';
import GenerationLoadingGame, {
  STAGE_LABELS,
  STAGE_RANGES,
} from '@/components/notes/GenerationLoadingGame';
import {
  FileText,
  Image as ImageIcon,
  Presentation,
  Loader2,
  Plus,
  ArrowRight,
  Check,
  ChevronDown,
  Pencil,
  X,
  CheckCircle2,
  XCircle,
  BookmarkPlus,
} from 'lucide-react';
import { QuestionStem } from '@/components/ui/QuestionStem';

type UploadStatus =
  | 'uploaded'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 클라이언트 전용 상태 'uploading' 추가: 파일 선택 즉시 목록에 표시하고
 * 본체 업로드(PUT)는 백그라운드로 진행한다. 서버 응답(UploadStatus)과 호환.
 */
type ClientUploadStatus = UploadStatus | 'uploading';

type UploadKind = 'material' | 'reference';

interface UploadRow {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  status: ClientUploadStatus;
  page_count: number | null;
  processed_at: string | null;
  created_at: string;
  error_message: string | null;
  processing_stage: string | null;
  progress_current: number;
  progress_total: number;
  completed_question_count: number;
  target_question_count: number | null;
  heartbeat_at: string | null;
  /** 생성 결과에서 사용자에게 알릴 사실(P8). 서버가 완료 시 채운다. */
  notice?: UploadNoticeItem[] | null;
}

/** lib/ai/upload-notice.ts 의 UploadNotice 와 같은 형태(서버 응답을 그대로 받는다). */
interface UploadNoticeItem {
  code: string;
  count?: number;
  detail?: string;
}

interface InitUploadRes {
  upload_id: string;
  storage_path: string;
  signed_upload_url: string;
  signed_token: string;
  expires_in_seconds: number;
}

interface ProcessRes {
  upload_id: string;
  status?: 'queued' | 'completed';
  queue_message_id?: string;
  generated_count?: number;
  private_question_ids?: string[];
  content_summary?: string;
  unmatched?: number;
  extract_stats?: {
    pages: number;
    croppedImages: number;
    ocrChars: number;
  };
  cost_usd?: number;
  duration_ms?: number;
}

interface UploadDetailRes {
  id: string;
  status: UploadStatus;
  processed_at: string | null;
  error_message: string | null;
}

interface AnalyzeRes {
  title: string;
  subject: string;
  topic: string;
  keywords: string[];
  difficulty: '하' | '중' | '상';
  question_type: '지식형' | '임상형' | '이미지형';
  /** false = 텍스트를 못 읽어(이미지·스캔본) 기본값이 채워진 응답 — 추천으로 적용하지 않는다. */
  analyzed?: boolean;
  /** 의학 자료로 보이는지(P6). false 면 생성 전에 확인을 받는다(차단하지 않는다). */
  is_medical?: boolean;
  /** 자료 성격. 'exam'(기출·족보)이면 참고 자료로 옮기기를 권유한다. */
  material_kind?: string;
  /** 판정 확신도 0~1. 낮으면 확인을 받는다. */
  confidence?: number;
  /** 자료 쪽 수(PPTX 는 슬라이드 수). 로딩 화면의 남은 시간이 쓴다(P10). */
  page_count?: number;
  /** 본문 텍스트가 없는 스캔본인지. 페이지 전체 OCR 경로라 소요가 다르다(P10). */
  is_scan?: boolean;
}

interface SubjectRow {
  id: string;
  name: string;
}

/**
 * GET /api/private-questions 응답의 개별 문항 형태.
 * (route.ts 의 정규화 결과와 일치)
 */
interface GenQ {
  id: string;
  stem: string;
  choices: string[];
  difficulty: number;
  sub_topic_id: string | null;
  images?: { url: string; kind: string | null; caption: string | null }[];
}

interface AttemptResponse {
  attempt_id: string;
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}

interface QuestionOutcome extends AttemptResponse {
  selected_index: number;
}

interface PrivateQuestionsRes {
  items: GenQ[];
  total: number;
  limit: number;
  offset: number;
}

/** 생성 완료 후 결과 뷰에 표시할 데이터. */
interface GeneratedResult {
  total: number;
  questions: GenQ[];
}

const ACCEPT =
  '.pdf,.ppt,.pptx,.docx,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp';

const MAX_MATERIAL_FILES = 5; // 한 번에 업로드 가능한 학습자료 개수 상한

/** 지문의 [이미지 N](배치 전체 순번)을 문항별 이미지 라벨(등장 순서 1,2,…)과 맞춘다. */
function withImageLabels(stem: string): string {
  const seen: string[] = [];
  // [이미지 N]/(이미지 N)/이미지 N 형태와 무관하게 번호만 등장 순서(1,2,…)로 재매김.
  return stem.replace(/이미지\s*(\d+)/g, (_m, n) => {
    let pos = seen.indexOf(n);
    if (pos === -1) { seen.push(n); pos = seen.length - 1; }
    return `이미지 ${pos + 1}`;
  });
}
const DIFFICULTIES = ['하', '중', '상'] as const;
const QUESTION_TYPES = ['지식형', '임상형', '이미지형'] as const;

/**
 * DB / 서버에서 받은 error_message 를 UI 표시용으로 정제.
 */
function formatUploadError(raw: string | null | undefined): string {
  const m = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!m) return '처리 중 알 수 없는 오류가 발생했습니다.';
  return m.length > 140 ? m.slice(0, 137) + '...' : m;
}

/** 낙관적(업로드 진행 중) 행의 클라이언트 전용 id 접두어 — 서버 API 호출 대상이 아님. */
const LOCAL_ID_PREFIX = 'local-';

/**
 * 서버 처리 단계(processing_stage)를 파일 1개 기준 0~100 진행률로 환산.
 *
 * 서버는 progress_current/progress_total 을 단계마다 서로 다른 분모(vision=페이지 수,
 * ocr=crop 수, generating=문항 수)로 0부터 다시 카운트한다. 이 값을 그대로 %로 쓰면
 * 게이지가 100%까지 찼다가 다음 단계에서 0%로 되돌아간다. 각 단계를 고정 가중 구간에
 * 매핑해 단계가 넘어갈수록 항상 앞으로만 가게 한다.
 *
 * 구간표(STAGE_RANGES)는 로딩 화면이 남은 시간 보정에도 같은 표를 쓰므로
 * GenerationLoadingGame 에서 한 번만 정의하고 여기서 가져다 쓴다.
 */

function uploadStageProgress(u: UploadRow): number {
  // 완료/실패/취소 = 이 파일 몫은 끝 — 다음 파일로 진행률이 넘어가도록 100 취급.
  if (u.status === 'completed' || u.status === 'failed' || u.status === 'cancelled') {
    return 100;
  }
  const stageKey =
    u.processing_stage && STAGE_RANGES[u.processing_stage]
      ? u.processing_stage
      : u.status === 'processing'
        ? 'downloading'
        : 'queued';
  const [lo, hi] = STAGE_RANGES[stageKey];
  const generating = stageKey === 'generating' || stageKey === 'partially_completed';
  const total = generating
    ? u.target_question_count ?? u.progress_total
    : u.progress_total;
  const cur = generating
    ? Math.max(u.progress_current, u.completed_question_count)
    : u.progress_current;
  const frac = total > 0 ? Math.min(1, Math.max(0, cur / total)) : 0;
  return lo + (hi - lo) * frac;
}

export default function NotesPage() {
  const materialInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);

  // 원본 학습자료(문제 생성용)와 보조 참고문항을 별도 상태로 관리.
  const [materials, setMaterials] = useState<UploadRow[]>([]);
  // 렌더 시점과 무관하게 현재 목록을 읽어야 하는 비동기 콜백용 미러.
  const materialsRef = useRef<UploadRow[]>([]);
  // 업로드가 끝나기 전에 사용자가 지운 임시 행 id — 완료 콜백이 서버 잔여물을 정리할 때 사용.
  const cancelledUploadsRef = useRef<Set<string>>(new Set());
  const [references, setReferences] = useState<UploadRow[]>([]);
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  // 생성 세션(여러 자료를 순차 생성하는 동안 전체) — 대기 미니게임 로딩 화면 표시용.
  const [genSession, setGenSession] = useState(false);
  // 생성 세션 전체 진행률: 이번 세션의 파일 수 / 끝난 파일 수 / 지금까지의 최대 진행률.
  // 진행 바가 단계·파일 전환 시 뒤로 가지 않도록(100%→0% 리셋 방지) 최대값을 유지한다.
  const genFilesTotalRef = useRef(0);
  const genFilesDoneRef = useRef(0);
  const genMaxProgressRef = useRef(0);

  // 문제 세트 정보 폼
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [folder, setFolder] = useState('');
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTIES)[number]>('중');
  const [questionTypes, setQuestionTypes] =
    useState<Array<(typeof QUESTION_TYPES)[number]>>(['지식형']);
  const [count, setCount] = useState(10);
  // 사용자가 난이도·유형을 직접 만졌는지 — 만진 뒤에는 AI 추천이 덮어쓰지 않는다.
  const difficultyTouchedRef = useRef(false);
  const typesTouchedRef = useRef(false);

  // AI 자동 분석 추천 설정
  const [analyzing, setAnalyzing] = useState(false);
  const [recommendation, setRecommendation] = useState<AnalyzeRes | null>(null);

  // 생성 결과 뷰
  const [generated, setGenerated] = useState<GeneratedResult | null>(null);
  const [showResult, setShowResult] = useState(false);

  // 추천 설정(과목·주제·키워드) 직접 수정 모드
  const [editingRec, setEditingRec] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState('');

  useEffect(() => {
    refresh();
    loadSubjects();
  }, []);

  useEffect(() => {
    materialsRef.current = materials;
  }, [materials]);

  async function loadSubjects() {
    try {
      const rows = await api.get<SubjectRow[]>(
        '/api/subjects?with_sub_topics=false',
      );
      setSubjects(rows);
    } catch {
      // 폴더 목록 로드 실패는 무시 — 수동 입력 흐름엔 영향 없음.
    }
  }

  async function refresh() {
    try {
      // 문제 생성 화면은 "이번에 올린 자료"만 보여준다. 이전에 업로드한 이력 자료를
      // 목록에 새로 끌어오지 않고(헷갈림 방지 — 완료/과거 파일은 '내 문제집'에 있음),
      // 현재 화면에 있는 자료의 상태만 서버 최신값으로 갱신한다.
      const up = await api.get<UploadRow[]>('/api/uploads');
      const byId = new Map(up.map((u) => [u.id, u] as const));
      setMaterials((prev) => prev.map((m) => byId.get(m.id) ?? m));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '데이터를 불러오지 못했습니다';
      console.error(msg);
    }
  }

  /** 공통 업로드: signed URL 발급 → PUT → upload 행 반환. */
  async function uploadFile(file: File): Promise<UploadRow | null> {
    const init = await api.post<InitUploadRes>('/api/uploads', {
      file_name: file.name,
      file_type: file.type,
      file_size_bytes: file.size,
    });

    const putRes = await fetch(init.signed_upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!putRes.ok) {
      throw new Error(`파일 업로드 실패 (HTTP ${putRes.status})`);
    }

    return {
      id: init.upload_id,
      file_name: file.name,
      file_type: file.type,
      file_size_bytes: file.size,
      status: 'uploaded',
      page_count: null,
      processed_at: null,
      created_at: new Date().toISOString(),
      error_message: null,
      processing_stage: null,
      progress_current: 0,
      progress_total: 0,
      completed_question_count: 0,
      target_question_count: null,
      heartbeat_at: null,
    };
  }

  async function handleMaterialFile(file: File) {
    if (materials.length >= MAX_MATERIAL_FILES) {
      alert(`학습자료는 한 번에 최대 ${MAX_MATERIAL_FILES}개까지 업로드할 수 있어요.`);
      return;
    }
    // 낙관적 표시: 파일 선택 즉시 목록에 올려 다음 단계(설정 입력)를 바로 진행할 수 있게
    // 하고, 실제 업로드(signed URL 발급 + PUT)는 백그라운드로 계속한다.
    const tempId = `${LOCAL_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempRow: UploadRow = {
      id: tempId,
      file_name: file.name,
      file_type: file.type,
      file_size_bytes: file.size,
      status: 'uploading',
      page_count: null,
      processed_at: null,
      created_at: new Date().toISOString(),
      error_message: null,
      processing_stage: null,
      progress_current: 0,
      progress_total: 0,
      completed_question_count: 0,
      target_question_count: null,
      heartbeat_at: null,
    };
    setMaterials((prev) => [tempRow, ...prev]);
    setUploadingMaterial(true);
    if (materialInputRef.current) materialInputRef.current.value = '';
    try {
      const row = await uploadFile(file);
      if (!row) return;
      // 취소 판정은 반드시 ref 로 한다. setMaterials 의 업데이터는 호출 직후가 아니라
      // 다음 렌더에서 실행되므로, 업데이터 안에서 세운 플래그를 바로 읽으면 항상
      // "취소됨"으로 보여 방금 업로드한 행을 지워 버린다(업로드가 통째로 사라지는 버그).
      if (cancelledUploadsRef.current.has(tempId)) {
        cancelledUploadsRef.current.delete(tempId);
        // 대기 중 행을 사용자가 삭제한 경우 — 서버에 만들어진 행/파일 정리(베스트에포트).
        api.delete(`/api/uploads/${row.id}`).catch(() => {});
        return;
      }
      // 분석 대상 = 이미 업로드가 끝난 자료(서버 id) + 이번에 올린 자료.
      // 방금 올린 파일을 맨 앞에 — 서버는 앞 2개만 분석하므로 뒤에 두면 3번째 파일부터
      // 방금 올린 자료가 분석에서 빠진다.
      const idsForAnalyze = [
        row.id,
        ...materialsRef.current
          .filter((m) => m.id !== tempId && !m.id.startsWith(LOCAL_ID_PREFIX))
          .map((m) => m.id),
      ];
      setMaterials((prev) => prev.map((m) => (m.id === tempId ? row : m)));
      // 학습자료 업로드 완료 → AI 자동 분석으로 추천 설정/폼 채움.
      runAnalyze(idsForAnalyze);
    } catch (e) {
      setMaterials((prev) => prev.filter((m) => m.id !== tempId));
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : '업로드 실패';
      alert(msg);
    } finally {
      setUploadingMaterial(false);
    }
  }

  async function handleReferenceFile(file: File) {
    setUploadingReference(true);
    try {
      const row = await uploadFile(file);
      if (!row) return;
      setReferences((prev) => [row, ...prev]);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : '업로드 실패';
      alert(msg);
    } finally {
      setUploadingReference(false);
      if (referenceInputRef.current) referenceInputRef.current.value = '';
    }
  }

  /** 학습자료 기반 AI 자동 분석 → 추천 설정 + 폼 자동 채움. 실패해도 무시. */
  async function runAnalyze(uploadIds: string[]) {
    if (uploadIds.length === 0) return;
    setAnalyzing(true);
    try {
      const res = await api.post<AnalyzeRes>('/api/uploads/analyze', {
        upload_ids: uploadIds,
      });
      setRecommendation(res);
      // 사용자가 아직 입력하지 않은 필드만 자동 채움(사용자 수정 우선).
      setTitle((cur) => cur || res.title);
      setTopic((cur) => cur || res.topic);
      // 난이도·유형은 (a) 모델이 실제로 자료를 읽은 응답이고 (b) 사용자가 아직 안 만졌을 때만
      // 채운다. 텍스트를 못 읽은 폴백('중'/'임상형')이 사용자의 선택을 덮어쓰던 문제(2026-08-18).
      if (res.analyzed !== false) {
        if (res.difficulty && !difficultyTouchedRef.current) setDifficulty(res.difficulty);
        if (res.question_type && !typesTouchedRef.current) setQuestionTypes([res.question_type]);
      }
      // 저장 폴더도 AI 추천 과목명으로 자동 지정(사용자 수정 가능).
      if (res.subject) {
        const match = subjects.find(
          (s) => s.name === res.subject || s.name.includes(res.subject) || res.subject.includes(s.name),
        );
        if (match) setFolder((cur) => cur || match.id);
      }
    } catch {
      // 분석 실패/지연 시에도 화면은 수동 입력으로 정상 동작.
    } finally {
      setAnalyzing(false);
    }
  }

  async function pollUploadStatus(
    uploadId: string,
    /** 진행이 멈췄을 때 생성 요청을 다시 보내는 함수(큐 고착 자동 회복). */
    rekick?: () => Promise<unknown>,
  ): Promise<UploadDetailRes | null> {
    // 대용량 강의록은 OCR과 문항 생성에 5분 이상 걸릴 수 있다. 큐 작업은
    // 브라우저 요청과 독립적으로 진행되므로 충분히 기다리고 완료 상태를 복구한다.
    // 큐 고착 자동 회복: 워커가 작업을 집어가지 못하면(전달 실패·함수 사망) 진행이 멈춘 채
    // 영원히 끝나지 않는다. 서버는 heartbeat 기준으로 재점유를 허용하므로, 진행 신호가
    // 일정 시간 없으면 사용자가 아무 것도 하지 않아도 생성 요청을 다시 보내 되살린다.
    const STALL_MS = 150_000; // 서버의 queued 고착 기준(120s)보다 넉넉히
    const MAX_REKICKS = 2;
    let lastSignature = '';
    let lastChangeAt = Date.now();
    let rekicks = 0;
    for (let i = 0; i < 300; i += 1) {
      try {
        const list = await api.get<UploadRow[]>('/api/uploads');
        const found = list.find((u) => u.id === uploadId);
        if (!found) return null;
        setMaterials((prev) =>
          prev.map((m) => (m.id === uploadId ? { ...m, ...found } : m)),
        );
        const signature = [
          found.status,
          found.processing_stage ?? '',
          found.progress_current,
          found.completed_question_count,
        ].join('|');
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastChangeAt = Date.now();
        } else if (
          rekick &&
          rekicks < MAX_REKICKS &&
          Date.now() - lastChangeAt > STALL_MS &&
          (found.status === 'queued' || found.status === 'processing')
        ) {
          rekicks += 1;
          lastChangeAt = Date.now();
          console.warn(
            `[notes] 생성이 ${Math.round(STALL_MS / 1000)}초간 멈춤 — 재요청 ${rekicks}/${MAX_REKICKS}`,
          );
          // 실패해도 폴링은 계속한다(서버가 아직 살아있다고 판단하면 409 를 준다).
          await rekick().catch(() => {});
        }
        // ⚠ 부분 공개는 하지 않는다(사용자 결정 2026-08-22).
        //
        // 종전에는 첫 배치가 끝나는 즉시 그때까지의 문항을 화면에 띄웠다. 그런데 생성은
        // 그 뒤로도 계속 문항을 지우고(그림 참조 정리·재사용 상한) 다시 채우기 때문에,
        // 먼저 공개된 목록은 최종본과 다르고 개수도 도중에 늘었다 줄었다 한다.
        // 이제 완료 시점에 전량을 한 번에 공개한다 — 아래 completed 분기에서 조회한다.
        if (found.status === 'completed' || found.status === 'failed') {
          return {
            id: found.id,
            status: found.status,
            processed_at: found.processed_at,
            error_message: found.error_message,
          };
        }
      } catch {
        // 일시적 에러는 무시하고 재시도
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }

  /** 특정 업로드로 생성된 문항을 조회해 반환. 실패 시 빈 배열. */
  async function fetchGeneratedQuestions(uploadId: string): Promise<GenQ[]> {
    try {
      const res = await api.get<PrivateQuestionsRes>(
        `/api/private-questions?upload_id=${uploadId}&limit=50&mode=quiz`,
      );
      return res.items;
    } catch {
      // 조회 실패는 무시 — 다른 자료의 결과만이라도 보여준다.
      return [];
    }
  }

  /**
   * 하나의 학습자료를 처리하고, 성공 시 생성된 문항을 반환.
   * 에러(quota/cost/실패)는 alert 로 유지하고 빈 배열 반환.
   */
  async function kickoffProcessing(uploadId: string): Promise<GenQ[]> {
    setProcessingId(uploadId);
    try {
      const sendProcess = () =>
        api.post<ProcessRes>(`/api/uploads/${uploadId}/process`, {
          desired_count: count,
          // style 은 현행 유지(사용자 결정 2026-08-19) — 바꾸면 전 사용자 출제 톤이
          // 즉시 달라지므로 기준선 대비 A/B 후에 정한다.
          style: 'professor',
          // P5 — 화면의 '단원/주제'·'핵심 키워드'를 실제로 싣는다.
          topic: topic.trim() || undefined,
          keywords: recommendation?.keywords?.length ? recommendation.keywords : undefined,
          difficulty,
          question_types: questionTypes,
          title: title.trim() || undefined,
          reference_upload_ids: references.map((reference) => reference.id),
        });
      const res = await sendProcess();

      if (res.status === 'queued') {
        const final = await pollUploadStatus(uploadId, sendProcess);
        if (final?.status === 'completed') {
          return await fetchGeneratedQuestions(uploadId);
        }
        if (final?.status === 'failed') {
          alert(`처리 실패: ${formatUploadError(final.error_message)}`);
        } else {
          alert('문항 생성이 계속 진행 중입니다. 잠시 후 강의노트에서 완료 상태를 확인해 주세요.');
        }
        return [];
      }

      // 동기 완료
      return await fetchGeneratedQuestions(uploadId);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'quota_exceeded') {
        alert('월간 업로드 한도에 도달했습니다. 결제 플랜에서 업그레이드해주세요.');
      } else if (e instanceof ApiError && e.code === 'cost_cap_exceeded') {
        alert('일일 AI 비용 한도에 도달했습니다. 잠시 후 다시 시도해주세요.');
      } else {
        const msg = e instanceof ApiError ? e.message : '생성 실패';
        alert(msg);
      }
      return [];
    } finally {
      setProcessingId(null);
      await refresh();
    }
  }

  /** 업로드된 모든 학습자료에 대해 순차 생성 → 결과 뷰로 전환. */
  async function handleGenerate() {
    if (materials.some((m) => m.status === 'uploading')) {
      alert('파일 업로드가 아직 진행 중이에요. 잠시 후(수 초 내) 다시 시도해주세요.');
      return;
    }
    const pending = materials.filter((m) => m.status === 'uploaded' || m.status === 'failed');
    if (pending.length === 0) {
      alert('생성할 학습자료를 먼저 업로드해주세요.');
      return;
    }
    // ── 자료 판정 확인(P6). **차단하지 않는다** — 오탐으로 정상 강의록을 막는 쪽이 더 나쁘다.
    // 확인을 취소하면 생성 자체가 시작되지 않으므로 쿼터도 차감되지 않는다.
    if (recommendation?.analyzed !== false) {
      const notMedical = recommendation?.is_medical === false;
      const lowConfidence = (recommendation?.confidence ?? 1) < 0.5;
      const looksLikeExam = recommendation?.material_kind === 'exam';
      if (notMedical || lowConfidence) {
        const message = notMedical
          ? '올리신 자료가 의학 학습자료가 아닌 것 같아요.\n그래도 문제를 만들까요? 문항 품질을 보장하기 어렵습니다.'
          : '자료에서 내용을 충분히 읽지 못했어요(표지·목차만 있는 자료일 수 있어요).\n그래도 문제를 만들까요?';
        if (!confirm(message)) return;
      } else if (looksLikeExam) {
        // 기출·족보는 학습자료로 두면 그 문항이 그대로 다시 나온다(감사에서 국시 기출로 실증).
        // 지금은 권유만 한다 — 강제 전환·차단은 별도 정책(R6)에서 정한다.
        if (
          !confirm(
            '올리신 자료가 기출·족보처럼 이미 문제 형태로 보여요.\n' +
              '학습자료로 두면 그 문항이 거의 그대로 다시 나올 수 있어요. ' +
              '왼쪽 “참고 자료”로 올리면 형식만 참고합니다.\n\n그래도 이대로 생성할까요?',
          )
        ) {
          return;
        }
      }
    }
    const collected: GenQ[] = [];
    // 세션 전체 진행률 초기화(파일 수 기준) — 진행 바는 세션 동안 단조 증가한다.
    genFilesTotalRef.current = pending.length;
    genFilesDoneRef.current = 0;
    genMaxProgressRef.current = 0;
    setGenSession(true); // 대기 미니게임 로딩 화면 on
    try {
      for (const m of pending) {
        const qs = await kickoffProcessing(m.id);
        collected.push(...qs);
        genFilesDoneRef.current += 1;
        // 파일이 끝날 때마다 결과를 띄우지 않는다(사용자 결정 2026-08-22) — 자료가 여러
        // 개면 문제 화면이 열린 뒤에도 목록이 계속 늘어나 몇 문항짜리인지 알 수 없었다.
        // 전부 끝난 뒤 아래에서 한 번에 공개한다. 진행 상황은 대기 화면이 보여 준다.
      }
    } finally {
      setGenSession(false); // 생성 완료 → 즉시 게임 종료, 문제 화면으로 전환
    }
    // 전량 완료 후 1회 공개.
    if (collected.length > 0) {
      setGenerated({ total: collected.length, questions: collected });
      setShowResult(true);
    }
  }

  async function handleDelete(kind: UploadKind, uploadId: string) {
    if (!confirm('이 자료와 연결된 모든 생성 문항이 함께 삭제됩니다. 계속하시겠어요?')) {
      return;
    }
    if (uploadId.startsWith(LOCAL_ID_PREFIX)) {
      // 아직 서버에 없는(업로드 진행 중) 행 — 화면에서만 제거하고 취소 표시를 남기면
      // 업로드 완료 콜백이 서버 측 잔여물을 정리한다.
      if (kind === 'material') {
        cancelledUploadsRef.current.add(uploadId);
        setMaterials((prev) => prev.filter((m) => m.id !== uploadId));
      } else {
        setReferences((prev) => prev.filter((r) => r.id !== uploadId));
      }
      return;
    }
    try {
      await api.delete(`/api/uploads/${uploadId}`);
      if (kind === 'material') {
        setMaterials((prev) => prev.filter((m) => m.id !== uploadId));
      } else {
        setReferences((prev) => prev.filter((r) => r.id !== uploadId));
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '삭제 실패';
      alert(msg);
    }
  }

  /** 결과 뷰 → 새 자료로 다시 시작. 업로드/추천/생성 상태 초기화. */
  function resetForNew() {
    setShowResult(false);
    setGenerated(null);
    setMaterials([]);
    setReferences([]);
    setRecommendation(null);
    setTitle('');
    setTopic('');
    setFolder('');
    setDifficulty('중');
    setQuestionTypes(['지식형']);
    setCount(10);
    difficultyTouchedRef.current = false;
    typesTouchedRef.current = false;
  }

  // 이번 생성 결과의 알림(P8) — 여러 자료를 돌렸으면 같은 코드끼리 합산해 한 줄로 보여준다
  // (자료 3개에서 같은 경고가 세 줄로 반복되면 사용자가 읽지 않는다).
  const sessionNotices: UploadNoticeItem[] = (() => {
    const merged = new Map<string, UploadNoticeItem>();
    for (const m of materials) {
      for (const n of m.notice ?? []) {
        const prev = merged.get(n.code);
        if (prev) prev.count = (prev.count ?? 0) + (n.count ?? 0);
        else merged.set(n.code, { ...n });
      }
    }
    return [...merged.values()];
  })();

  const isGenerating = processingId !== null;

  // ─────────────────────────────────────────────────────────────
  // (L) 생성 대기 로딩 화면(미니게임) — 생성 세션 동안 최상단 표시.
  //     완료되면 genSession 이 false 가 되어 즉시 결과 뷰로 전환된다.
  // ─────────────────────────────────────────────────────────────
  // 첫 문항이 도착해 결과 뷰가 열렸으면(showResult) 게임 대신 결과 뷰를 보여준다 —
  // "첫 문항부터 바로 풀 수 있게" 하려던 부분 공개가 이 분기에 가려 한 번도 보이지 않았다.
  if (genSession && !showResult) {
    const pm = materials.find((m) => m.id === processingId) ?? null;
    // 세션 전체 진행률 = (끝난 파일 수 + 현재 파일의 단계별 진행률) / 파일 수.
    // 단계 전환·파일 전환 시에도 이전 최대값을 유지해 게이지가 절대 뒤로 가지 않는다.
    const fileProgress = pm ? uploadStageProgress(pm) : 0;
    const filesTotal = Math.max(1, genFilesTotalRef.current);
    const overall =
      ((genFilesDoneRef.current + fileProgress / 100) / filesTotal) * 100;
    const genProgress = Math.max(
      genMaxProgressRef.current,
      Math.min(99, Math.max(3, overall)),
    );
    genMaxProgressRef.current = genProgress;
    return (
      <GenerationLoadingGame
        progress={genProgress}
        fileName={pm?.file_name ?? undefined}
        stage={pm?.processing_stage ?? (pm?.status === 'processing' ? 'downloading' : 'queued')}
        // 남은 시간 예측 입력 — 요청 규모는 시작 시점에 이미 알고 있다.
        // '이미지형' 포함 여부가 소요를 4~5배 가른다(실측: 텍스트만 7.7초 vs 이미지 포함 32~53초).
        desiredCount={count}
        withImages={questionTypes.includes('이미지형')}
        filesTotal={filesTotal}
        // 남은 시간 예측의 실제 변수(P10). 분석이 실패했으면 0 이 가고, 그때는 화면이
        // 실측 중앙값을 쓴다 — 0 을 쪽 수로 그대로 믿으면 예측이 크게 모자란다.
        pageCount={recommendation?.page_count ?? 0}
        isScan={recommendation?.is_scan ?? false}
      />
    );
  }

  // ─────────────────────────────────────────────────────────────
  // (B) 생성 결과 뷰
  // ─────────────────────────────────────────────────────────────
  if (showResult && generated) {
    return (
      <ResultView
        result={generated}
        title={title}
        difficulty={difficulty}
        questionType={questionTypes.join(' · ')}
        requestedTotal={count * Math.max(1, genFilesTotalRef.current || materials.length || 1)}
        generating={genSession}
        notices={sessionNotices}
        onReset={resetForNew}
      />
    );
  }

  // ─────────────────────────────────────────────────────────────
  // (A) 업로드 / 설정 폼 뷰
  // ─────────────────────────────────────────────────────────────
  // 학습자료가 1회 이상 업로드되기 전에는 '학습자료' 칸만 노출한다.
  // (참고 자료 / 추천 설정 / 문제 세트 정보 / 생성 요약은 업로드 후 등장)
  const hasUploaded = materials.length > 0;
  // 이번 생성에서 실제로 처리될 자료 수(아직 생성 안 됐거나 실패한 것) — 문항 수는 자료마다 곱해진다.
  const pendingMaterialCount = materials.filter(
    (m) => m.status === 'uploaded' || m.status === 'failed',
  ).length;
  const folderName = subjects.find((s) => s.id === folder)?.name ?? '미지정';
  // 좌측 상단 STEP 필 — 자료 업로드 → AI 강의록 판독 중 → 판독 완료(문제 생성) 3단계.
  // analyzing이 판독 중, recommendation이 판독 결과이므로 그 둘로 단계를 판정한다.
  const stepLabel = analyzing
    ? 'STEP 2 / 3 · 자동분석 설정 확인'
    : recommendation
      ? 'STEP 3 / 3 · 문제 생성'
      : 'STEP 1 / 3 · 자료 업로드';

  return (
    <div className="ll-upload-page content">
      {/* 헤더 — 상단 내비로 바로 들어오는 페이지라 '홈으로' 링크는 두지 않는다. */}
      <section className="page-head"><div><span className="eyebrow" aria-live="polite">{stepLabel}</span><h1><span className="headline-accent">내 학습자료</span>로<br/>문제를 만들어보세요</h1><p className="lead">강의자료와 기출문제를 업로드하고 원하는 범위의 예상 문제를 생성해 보세요.</p></div><div className="guide"><Link href="/tutorial" className="guide-trigger"><span className="guide-icon">?</span><GuideLabel /></Link><div className="guide-panel"><h2>어떻게 사용하나요?</h2><ol><li><strong>학습자료 업로드</strong>: 업로드한 자료를 기반으로 문제를 생성합니다.</li><li><strong>참고 자료 추가</strong>: 예시 문항의 형식(발문·선지 구성)을 참고합니다. 내용과 난이도의 근거로는 쓰지 않아요.</li><li><strong>문제 세트 정보 확인</strong>: 이름과 주제를 확인하고 수정합니다.</li></ol></div></div></section>

      <div
        className={clsx(
          'layout grid grid-cols-1 gap-6',
          hasUploaded
            ? 'items-start lg:grid-cols-[1.5fr_1fr]'
            : 'items-stretch lg:grid-cols-[minmax(0,440px)_auto_minmax(0,1fr)]',
        )}
      >
        {/* 좌측: 학습자료 · 참고 자료 · 문제 세트 정보 */}
        <div className="stack">
          {/* 학습자료 (필수) — 업로드 전에는 '1' 단계 번호를 붙여 시작점을 명확히 한다. */}
          <div className={clsx(!hasUploaded && 'relative')}>
            {!hasUploaded && (
              <span
                className="absolute -top-3 -left-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)] text-base font-bold text-white shadow-[0_4px_10px_rgba(24,40,32,0.18)]"
                aria-hidden
              >
                1
              </span>
            )}
            <Card className="pad">
              <CardHead
                title="학습자료"
                description="문제 생성에 사용할 자료를 업로드하세요."
                action={<Badge variant="default">필수</Badge>}
              />

              <UploadDropZone
                uploading={uploadingMaterial}
                onFile={handleMaterialFile}
                inputRef={materialInputRef}
                accept={ACCEPT}
                title="파일을 끌어오거나 클릭해 업로드"
                hint="PDF, PPTX, DOCX, 이미지 파일 지원"
              />

              {materials.length > 0 && (
                <div className="space-y-2 mt-4">
                  {materials.map((u) => (
                    <FileRow
                      key={u.id}
                      upload={u}
                      isProcessing={processingId === u.id}
                      onDelete={() => handleDelete('material', u.id)}
                    />
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* 참고 자료 (선택) — 업로드 후 노출 */}
          {hasUploaded && (
            <Card className="pad">
              <CardHead
                title="참고 자료 (선택)"
                description="기존 문제·예시 문항을 함께 올려두면 문제집에 보관돼요. 문항은 위 학습 자료를 기준으로 생성됩니다."
                action={<Badge variant="gray">선택</Badge>}
              />

              <input
                ref={referenceInputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleReferenceFile(f);
                }}
              />

              {references.length > 0 && (
                <div className="space-y-2 mb-3">
                  {references.map((u) => (
                    <FileRow
                      key={u.id}
                      upload={u}
                      isProcessing={false}
                      onDelete={() => handleDelete('reference', u.id)}
                    />
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => referenceInputRef.current?.click()}
                disabled={uploadingReference}
                className="add-ref"
              >
                {uploadingReference ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                이미지 · PDF 추가
              </button>

              <p className="text-sm text-[var(--color-muted)] mt-3">
                참고 자료는 선택이며, 문항 생성은 위 학습 자료를 기준으로 진행돼요.
              </p>
            </Card>
          )}

          {/* 문제 세트 정보 — 업로드 후 노출 */}
          {hasUploaded && (
            <Card className="pad">
              <CardHead
                title="문제 세트 정보"
                description="생성할 문제들의 기본 정보를 설정하세요."
              />

              <div className="form-grid">
                <Field label="문제집 이름" hint="생성된 문제 세트의 이름이에요. 업로드한 자료를 분석해 AI가 자동으로 지어주며, 자유롭게 바꿀 수 있어요.">
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="예: 순환기 1차 대비 문제집"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--color-border)] text-sm text-sage-800 bg-white focus:outline-none focus:border-sage-500"
                  />
                </Field>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="단원 / 주제" hint="문제집 표시용 주제예요. (지금은 문항 생성 조건에는 반영되지 않고, 자료 전체 내용에서 출제돼요.)">
                    <input
                      type="text"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      placeholder="예: 판막질환"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--color-border)] text-sm text-sage-800 bg-white focus:outline-none focus:border-sage-500"
                    />
                  </Field>
                  <Field label="저장 폴더" hint="자료 내용에 맞춰 AI가 제안한 과목이에요. 실제 분류는 생성된 문항의 세부주제를 기준으로 자동 지정돼요.">
                    <select
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--color-border)] text-sm text-sage-800 bg-white focus:outline-none focus:border-sage-500"
                    >
                      <option value="">폴더 선택</option>
                      {subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <Field label="난이도" hint="쉬움은 기본 개념 위주, 어려움은 지엽적·응용 내용까지 물어봐요. 난이도가 올라갈수록 문항이 까다로워져요.">
                    <Segmented
                      options={DIFFICULTIES}
                      value={difficulty}
                      onChange={(v) => {
                        difficultyTouchedRef.current = true;
                        setDifficulty(v);
                      }}
                    />
                  </Field>
                  <Field
                    label="문항 유형"
                    hint="지식형: 개념·정의를 확인하는 문항 / 임상형: 환자 증례로 진단·처치를 묻는 문항 / 이미지형: 자료의 의료 이미지를 판독해 푸는 문항"
                  >
                    <MultiSegmented
                      options={QUESTION_TYPES}
                      values={questionTypes}
                      onChange={(v) => {
                        typesTouchedRef.current = true;
                        setQuestionTypes(v);
                      }}
                    />
                  </Field>
                </div>

                <div>
                  <div className="range-head">
                    <span className="text-xs font-medium text-[var(--color-muted)]">
                      생성 문항 수
                    </span>
                    <strong className="range-value">
                      {count}
                      <span className="text-xs font-normal text-[var(--color-muted)] ml-0.5">
                        문항
                      </span>
                    </strong>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    className="w-full accent-[var(--color-accent)]"
                  />
                  <div className="range-scale">
                    <span>1</span>
                    <span>10</span>
                    <span>20</span>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>

        {/* 업로드 전: 점선 화살표 → 앞으로의 과정을 미리 보여주는 고스트 패널.
            (오른쪽 빈 공간을 채워 사용자가 흐름을 이해하게 한다) */}
        {!hasUploaded && (
          <div className="hidden lg:flex items-center justify-center self-center">
            <div className="flex items-center text-[var(--color-sage-400)]">
              <span className="block w-12 border-t-2 border-dashed border-current" />
              <ArrowRight className="w-6 h-6 -ml-1.5" strokeWidth={2.4} />
            </div>
          </div>
        )}
        {!hasUploaded && (
          <UploadNextSteps
            steps={[
              { number: 2, title: '자동 분석 · 설정 확인', description: 'AI가 제목·과목·난이도를 추천해요. 참고 자료도 추가할 수 있어요.' },
              { number: 3, title: '문제 생성', description: '올린 자료를 바탕으로 예상 문제 세트가 자동으로 만들어져요.' },
            ]}
            footer={<>먼저 왼쪽 <b className="text-sage-700">1. 학습자료</b> 칸에 파일을 올려주세요. 올리는 즉시 위 단계가 순서대로 나타납니다.</>}
          />
        )}

        {/* 우측: 추천 설정 · 생성 요약 — 업로드 후 노출 */}
        {hasUploaded && (
          <aside className="summary">
            {/* 추천 설정 */}
            <Card className="pad">
              <CardHead
                title="추천 설정"
                description="업로드된 자료를 기반으로 AI가 생성 설정을 제안합니다."
                action={
                  recommendation && !analyzing ? (
                    <button
                      type="button"
                      onClick={() => setEditingRec((v) => !v)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-muted)] hover:text-sage-700 transition-colors"
                    >
                      {editingRec ? (
                        <><Check className="w-3.5 h-3.5" strokeWidth={2.5} />완료</>
                      ) : (
                        <><Pencil className="w-3.5 h-3.5" strokeWidth={2} />수정</>
                      )}
                    </button>
                  ) : undefined
                }
              />

              {analyzing ? (
                <div className="flex items-center gap-2 text-sm text-[var(--color-muted)] py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  자료를 분석하는 중...
                </div>
              ) : recommendation ? (
                editingRec ? (
                  <div className="space-y-3">
                    <div className="flex gap-4 items-center">
                      <label className="w-16 flex-shrink-0 text-sm text-[var(--color-muted)]">과목</label>
                      <input
                        value={recommendation.subject}
                        onChange={(e) => setRecommendation({ ...recommendation, subject: e.target.value })}
                        placeholder="과목"
                        className="flex-1 h-9 rounded-lg border border-[var(--color-border)] px-2.5 text-sm text-sage-800 outline-none focus:border-sage-600"
                      />
                    </div>
                    <div className="flex gap-4 items-center">
                      <label className="w-16 flex-shrink-0 text-sm text-[var(--color-muted)]">주제</label>
                      <input
                        value={recommendation.topic}
                        onChange={(e) => { setRecommendation({ ...recommendation, topic: e.target.value }); setTopic(e.target.value); }}
                        placeholder="주제"
                        className="flex-1 h-9 rounded-lg border border-[var(--color-border)] px-2.5 text-sm text-sage-800 outline-none focus:border-sage-600"
                      />
                    </div>
                    <div className="flex gap-4">
                      <label className="w-16 flex-shrink-0 text-sm text-[var(--color-muted)] pt-2">핵심 키워드</label>
                      <div className="flex-1 min-w-0">
                        {recommendation.keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {recommendation.keywords.map((k) => (
                              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-sage-100)] px-2 py-0.5 text-xs font-medium text-sage-800">
                                {k}
                                <button type="button" aria-label={`${k} 삭제`} onClick={() => setRecommendation({ ...recommendation, keywords: recommendation.keywords.filter((x) => x !== k) })} className="text-[var(--color-muted)] hover:text-[var(--color-warn)]">
                                  <X className="w-3 h-3" strokeWidth={2.5} />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <input
                          value={keywordDraft}
                          onChange={(e) => setKeywordDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const v = keywordDraft.trim();
                              if (v && !recommendation.keywords.includes(v)) {
                                setRecommendation({ ...recommendation, keywords: [...recommendation.keywords, v] });
                              }
                              setKeywordDraft('');
                            }
                          }}
                          placeholder="키워드 입력 후 Enter"
                          className="w-full h-9 rounded-lg border border-[var(--color-border)] px-2.5 text-sm text-sage-800 outline-none focus:border-sage-600"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <dl className="space-y-3">
                      <div className="flex gap-4">
                        <dt className="w-16 flex-shrink-0 text-sm text-[var(--color-muted)]">
                          과목
                        </dt>
                        <dd className="text-sm font-semibold text-sage-800">
                          {recommendation.subject || '—'}
                        </dd>
                      </div>
                      <div className="flex gap-4">
                        <dt className="w-16 flex-shrink-0 text-sm text-[var(--color-muted)]">
                          주제
                        </dt>
                        <dd className="text-sm font-semibold text-sage-800">
                          {recommendation.topic || '—'}
                        </dd>
                      </div>
                      {recommendation.keywords.length > 0 && (
                        <div className="flex gap-4">
                          <dt className="w-16 flex-shrink-0 text-sm text-[var(--color-muted)] pt-1">
                            핵심 키워드
                          </dt>
                          <dd className="flex flex-wrap gap-1.5">
                            {recommendation.keywords.map((k) => (
                              <Badge key={k} variant="default">
                                {k}
                              </Badge>
                            ))}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {recommendation.analyzed === false ? (
                      <div className="mt-4 text-xs font-medium text-[var(--color-muted)]">
                        자료에서 텍스트를 읽지 못해 추천을 만들지 못했어요. 아래 난이도·유형을 직접 확인해 주세요.
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 mt-4 text-xs font-medium text-sage-700">
                        <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                        추천 설정이 적용되었습니다.
                      </div>
                    )}
                  </>
                )
              ) : (
                <div className="text-sm text-[var(--color-muted)] py-1">
                  자료를 분석해 과목·주제·키워드를 제안합니다.
                </div>
              )}
            </Card>

            {/* 생성 요약 + CTA */}
            <Card className="pad summary-hero">
              <CardHead
                title="생성 요약"
                description="설정을 확인하고 문제 생성을 시작하세요."
              />
              <dl className="summary-list">
                <SummaryRow label="문제집" value={title || '미입력'} />
                <SummaryRow label="저장 위치" value={folderName} />
                <SummaryRow label="학습자료" value={`${materials.length}개`} />
                <SummaryRow label="참고 자료" value={`${references.length}개`} />
                <SummaryRow label="난이도" value={difficulty} />
                <SummaryRow
                  label="문항 수"
                  value={
                    pendingMaterialCount > 1
                      ? `${count}문항 × ${pendingMaterialCount}개 자료 = ${count * pendingMaterialCount}문항`
                      : `${count}문항`
                  }
                />
              </dl>

              <Button
                variant="accent"
                size="lg"
                fullWidth
                className="primary-btn"
                loading={isGenerating}
                disabled={isGenerating || materials.length === 0}
                onClick={handleGenerate}
              >
                문제 생성 시작
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 생성 결과 뷰 컴포넌트
// ─────────────────────────────────────────────────────────────
/**
 * 생성 알림 문구(P8). 서버는 코드·개수만 주고 문구는 화면이 만든다 —
 * 문구를 서버에 두면 표현을 바꿀 때마다 배포가 필요하고, 코드가 화면 언어에 묶인다.
 */
const NOTICE_TEXT: Record<string, (n: UploadNoticeItem) => string> = {
  shortfall: (n) => `요청한 문항 중 ${n.count ?? 0}개를 만들지 못했어요.`,
  no_image: () => '이미지형을 골랐지만 자료에서 쓸 만한 의료 이미지를 찾지 못했어요.',
  text_truncated: () => '자료가 길어 앞부분을 중심으로 출제했어요.',
  reference_ignored: (n) => `참고 자료 ${n.count ?? 0}건은 형식을 읽지 못해 반영하지 못했어요.`,
  transient_error: () => '생성 중 일시적인 오류가 있었어요.',
};

function GenerationNotices({ notices }: { notices: UploadNoticeItem[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2,#fbfaf7)] px-4 py-3">
      <ul className="space-y-1.5">
        {notices.map((n, i) => {
          const headline = NOTICE_TEXT[n.code]?.(n);
          if (!headline) return null;
          return (
            <li key={`${n.code}-${i}`} className="flex gap-2 text-sm text-sage-800">
              <span aria-hidden className="mt-[0.15rem] text-[var(--color-muted)]">·</span>
              <span>
                {headline}
                {n.detail && (
                  <span className="text-[var(--color-muted)]"> {n.detail}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResultView({
  result,
  title,
  difficulty,
  questionType,
  requestedTotal,
  generating = false,
  notices = [],
  onReset,
}: {
  result: GeneratedResult;
  title: string;
  difficulty: string;
  questionType: string;
  /** 요청한 총 문항 수(문항 수 × 학습자료 수) — 실제 생성 수가 이보다 적으면 알려 준다. */
  requestedTotal?: number;
  /** 아직 나머지 문항을 만드는 중인지(부분 공개 상태). */
  generating?: boolean;
  /** 생성 결과에서 사용자에게 알릴 사실(P8) — 이번 세션의 학습자료들에서 모은다. */
  notices?: UploadNoticeItem[];
  onReset: () => void;
}) {
  const [outcomes, setOutcomes] = useState<Record<string, QuestionOutcome>>({});
  const [savingWrong, setSavingWrong] = useState(false);
  const [wrongSaved, setWrongSaved] = useState(false);
  const completedCount = Object.keys(outcomes).length;
  const wrongQuestions = result.questions.filter(
    (question) => outcomes[question.id] && !outcomes[question.id].is_correct,
  );

  async function saveWrongAnswers() {
    if (wrongQuestions.length === 0) return;
    setSavingWrong(true);
    try {
      await Promise.all(
        wrongQuestions.map((question) =>
          api.post('/api/wrong-answers', {
            private_question_id: question.id,
            sub_topic_id: question.sub_topic_id,
            selected_index: outcomes[question.id].selected_index,
            source: 'lecture_note',
          }),
        ),
      );
      setWrongSaved(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : '오답노트 저장에 실패했습니다.');
    } finally {
      setSavingWrong(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* 헤더 */}
      <div className="mb-8">
        <h1 className="text-[2.4rem] leading-[1.1] font-bold text-sage-800 tracking-[-0.03em]">
          {generating ? '먼저 도착한 문항부터 풀어보세요' : '문제집이 완성됐어요'}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge variant="private">{result.total}문항</Badge>
          {generating && <Badge variant="default">나머지 문항 만드는 중…</Badge>}
          {!generating && requestedTotal !== undefined && result.total < requestedTotal && (
            <Badge variant="default">요청 {requestedTotal}문항 중 {result.total}문항 생성됨</Badge>
          )}
          <Badge variant="default">요청 난이도 {difficulty}</Badge>
          <Badge variant="default">{questionType}</Badge>
          {title && (
            <span className="text-sm text-[var(--color-muted)]">· {title}</span>
          )}
        </div>
      </div>

      {/* 생성 알림(P8) — 생성 중에는 확정되지 않았으므로 완료 후에만 보여준다. */}
      {!generating && <GenerationNotices notices={notices} />}

      {/* 상단 액션 */}
      <div className="flex flex-wrap gap-3 mb-6">
        <Link href="/library">
          <Button variant="secondary">내 문제집에서 보기</Button>
        </Link>
        <Button variant="accent" onClick={onReset}>
          새 자료로 만들기
        </Button>
      </div>

      {/* 생성 문항 목록 */}
      {result.questions.length > 0 ? (
        <div className="space-y-4">
          {result.questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              q={q}
              index={i + 1}
              outcome={outcomes[q.id] ?? null}
              onGraded={(outcome) =>
                setOutcomes((current) => ({ ...current, [q.id]: outcome }))
              }
            />
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-[var(--color-muted)]">
            생성된 문항을 불러오지 못했습니다. 내 문제집에서 확인해주세요.
          </p>
        </Card>
      )}

      {completedCount === result.questions.length && result.questions.length > 0 && (
        <Card className="mt-6">
          <div className="text-center">
            <CheckCircle2 className="w-8 h-8 text-sage-700 mx-auto mb-3" />
            <h2 className="text-xl font-bold text-sage-800">풀이를 완료했습니다</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              정답 {completedCount - wrongQuestions.length}개 · 오답 {wrongQuestions.length}개
            </p>
          </div>
          {wrongQuestions.length > 0 && (
            <div className="mt-5 border-t border-[var(--color-border)] pt-5">
              {wrongSaved ? (
                <div className="flex items-center justify-center gap-2 text-sm font-semibold text-sage-700">
                  <CheckCircle2 className="w-4 h-4" />
                  틀린 문항을 오답노트에 담았습니다.
                </div>
              ) : (
                <Button fullWidth onClick={saveWrongAnswers} loading={savingWrong}>
                  <BookmarkPlus className="w-4 h-4" />
                  오답 {wrongQuestions.length}문항 오답노트에 담기
                </Button>
              )}
            </div>
          )}
        </Card>
      )}

      {/* 하단 액션 */}
      <div className="flex flex-wrap gap-3 mt-8">
        <Link href="/library">
          <Button variant="secondary">내 문제집에서 보기</Button>
        </Link>
        <Button variant="accent" onClick={onReset}>
          새 자료로 만들기
        </Button>
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  index,
  outcome,
  onGraded,
}: {
  q: GenQ;
  index: number;
  outcome: QuestionOutcome | null;
  onGraded: (outcome: QuestionOutcome) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 풀이 시간 실측 — 카드가 화면에 절반 이상 들어온 시점(또는 첫 선택 시점 중 이른 쪽)부터
  // 제출까지. 종전에는 시간을 아예 안 보냈다(오답 사유 분석이 쓸 수 있는 신호가 없었다).
  const shownAtRef = useRef<number | null>(null);
  const stemRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stemRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (shownAtRef.current === null && entries.some((e) => e.isIntersecting)) {
          shownAtRef.current = Date.now();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  async function submitAnswer() {
    if (selected === null || outcome) return;
    setSubmitting(true);
    try {
      const startedAt = shownAtRef.current ?? Date.now();
      const response = await api.post<AttemptResponse>('/api/attempts', {
        question_id: q.id,
        selected_index: selected,
        time_spent_seconds: Math.min(3600, Math.max(0, Math.round((Date.now() - startedAt) / 1000))),
        track: 'lecture_note',
      });
      onGraded({ ...response, selected_index: selected });
    } catch (error) {
      alert(error instanceof Error ? error.message : '채점에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      {/*
        번호를 flex 열이 아니라 float 로 띄운다. flex 로 두면 번호 칸(2.25rem + 간격 0.875rem)이
        발문 마지막 줄까지 빈 열로 남아, 모바일에서 발문이 카드 폭의 3/4 만 쓰게 된다.
        float 은 자기 높이(2.25rem)만큼만 줄을 밀어내므로 번호 줄과 그 아래 한 줄까지만
        들여쓰이고, 그 아래부터는 발문이 카드 폭을 모두 쓴다.
        (아래 여백을 더 줘서 들여쓰기를 한 줄 더 끌고 갈 수도 있으나, 그러면 발문이 짧은
         카드가 그 여백만큼 오히려 커진다 — 여백을 줄이려는 목적과 어긋나 두지 않는다.)
        overflow-hidden 은 발문이 짧을 때 float 이 아래 이미지·선택지로 새지 않도록 가둔다.
      */}
      <div ref={stemRef} className="mb-5 overflow-hidden">
        <span
          className="ll-chip text-sm font-bold tabular-nums"
          style={{
            float: 'left',
            width: '2.25rem',
            height: '2.25rem',
            marginRight: '0.875rem',
          }}
        >
          {index}
        </span>
        <QuestionStem
          className="text-base text-sage-800 font-medium leading-relaxed pt-1.5"
          text={withImageLabels(q.stem)}
        />
      </div>

      {q.images && q.images.length > 0 && (
        <div className="mb-5 space-y-2">
          {q.images.map((img, ii) => (
            <figure key={ii}>
              <figcaption className="text-[12px] font-semibold text-sage-700 mb-1">이미지 {ii + 1}</figcaption>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={`이미지 ${ii + 1}`} className="w-full max-h-80 object-contain rounded-xl border border-[var(--color-border)] bg-white" />
            </figure>
          ))}
        </div>
      )}

      <ol className="space-y-2">
        {q.choices.map((choice, ci) => {
          const isSelected = selected === ci;
          const isCorrect = outcome?.correct_index === ci;
          const isWrong = Boolean(outcome && isSelected && !outcome.is_correct);
          return (
            <li
              key={ci}
              className="list-none"
            >
              <button
                type="button"
                onClick={() => {
                  if (outcome) return;
                  if (shownAtRef.current === null) shownAtRef.current = Date.now();
                  setSelected(ci);
                }}
                disabled={outcome !== null}
                className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left text-sm transition-colors ${
                  isCorrect
                    ? 'border-sage-600 bg-[var(--color-curated-bg)] text-sage-800 font-medium'
                    : isWrong
                      ? 'border-[var(--color-warn)] bg-[var(--color-warn-bg)] text-sage-800'
                      : isSelected
                        ? 'border-sage-600 bg-[var(--color-sage-100)] text-sage-800'
                        : 'border-[var(--color-border)] bg-white text-sage-800 hover:border-sage-400'
                }`}
              >
                <span className="flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center bg-sage-700 text-white">
                  {ci + 1}
                </span>
                <span className="flex-1">{choice}</span>
                {isCorrect && <CheckCircle2 className="w-4 h-4 text-sage-700" />}
                {isWrong && <XCircle className="w-4 h-4 text-[var(--color-warn)]" />}
              </button>
            </li>
          );
        })}
      </ol>

      {!outcome ? (
        <div className="mt-4 flex justify-end">
          <Button
            variant="accent"
            onClick={submitAnswer}
            disabled={selected === null}
            loading={submitting}
          >
            제출하고 채점
          </Button>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-sage-50)] p-4">
          <div className={`text-sm font-bold ${outcome.is_correct ? 'text-sage-700' : 'text-[var(--color-warn)]'}`}>
            {outcome.is_correct ? '정답입니다.' : `오답입니다. 정답은 ${outcome.correct_index + 1}번입니다.`}
          </div>
          {outcome.explanation && (
            <p className="mt-2 text-sm text-sage-700 leading-relaxed whitespace-pre-line">
              {outcome.explanation}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      {/* 라벨(난이도/문항 유형 등) 위에 마우스를 올리면 설명 툴팁이 뜬다(사용 설명서와 동일 구동). */}
      <span
        className={clsx('field-label', hint && 'has-hint')}
        data-tip={hint || undefined}
        tabIndex={hint ? 0 : undefined}
      >
        {label}
        {hint && <span className="field-help" aria-hidden>?</span>}
      </span>
      {children}
    </label>
  );
}

/** 카드 상단 헤딩 — 볼드 제목 + 설명 + 우측 액션 (플랫·절제 톤). */
function CardHead({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card-head">
      <div className="min-w-0">
        <h2>{title}</h2>
        {description && (
          <p>
            {description}
          </p>
        )}
      </div>
      {action && <div className="tag">{action}</div>}
    </div>
  );
}

function MultiSegmented<T extends string>({
  options,
  values,
  onChange,
}: {
  options: readonly T[];
  values: T[];
  onChange: (values: T[]) => void;
}) {
  return (
    <div className="checkset" role="group" aria-label="문항 유형 복수 선택">
      {options.map((option) => {
        const active = values.includes(option);
        return (
          <button
            key={option}
            type="button"
            className={`check-card ${active ? 'active' : ''}`}
            aria-pressed={active}
            onClick={() => {
              if (active && values.length === 1) return;
              onChange(active ? values.filter((value) => value !== option) : [...values, option]);
            }}
          >
            <span className="check-box" aria-hidden />
            {option}
          </button>
        );
      })}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-item">
      <dt className="text-sm text-[var(--color-muted)]">{label}</dt>
      <dd className="text-sm font-semibold text-sage-800 text-right">{value}</dd>
    </div>
  );
}

function FileRow({
  upload,
  isProcessing,
  onDelete,
}: {
  upload: UploadRow;
  isProcessing: boolean;
  onDelete: () => void;
}) {
  const Icon = fileIcon(upload.file_type);
  const sizeMB = (upload.file_size_bytes / 1_000_000).toFixed(1);
  const errMsg =
    upload.status === 'failed' ? formatUploadError(upload.error_message) : null;

  return (
    <div className="file-row">
      <span className="file-icon"><Icon
        className="icon"
        strokeWidth={1.7}
      /></span>
      <div className="file-main">
        <div className="file-name">{upload.file_name}</div>
        <div className="file-meta">
          <span>{sizeMB} MB</span>
          <StatusLabel upload={upload} isProcessing={isProcessing} />
        </div>
        {errMsg && (
          <div
            className="text-[11px] text-[var(--color-warn)] mt-1 line-clamp-2"
            title={errMsg}
          >
            {errMsg}
          </div>
        )}
      </div>
      <button
        onClick={onDelete}
        className="p-1.5 text-[var(--color-muted)] hover:text-[var(--color-warn)] transition-colors"
        title="삭제"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function StatusLabel({
  upload,
  isProcessing,
}: {
  upload: UploadRow;
  isProcessing: boolean;
}) {
  const { status } = upload;
  if (status === 'uploading') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--color-beta)]">
        <Loader2 className="w-3 h-3 animate-spin" />
        업로드 중
      </span>
    );
  }
  if (status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--color-beta)]">
        <Loader2 className="w-3 h-3 animate-spin" />
        큐 대기
      </span>
    );
  }
  if (isProcessing || status === 'processing') {
    // 로딩 화면과 같은 문구를 쓴다(중복 정의가 서로 어긋나지 않게).
    const stageLabel = STAGE_LABELS;
    const progress =
      upload.progress_total > 0
        ? ` ${upload.progress_current}/${upload.progress_total}`
        : '';
    return (
      <span className="inline-flex items-center gap-1 text-[var(--color-beta)]">
        <Loader2 className="w-3 h-3 animate-spin" />
        {(upload.processing_stage && stageLabel[upload.processing_stage]) || 'AI 처리 중'}
        {progress}
      </span>
    );
  }
  if (status === 'completed') {
    return <span className="text-sage-700">생성 완료</span>;
  }
  if (status === 'failed') {
    return <span className="text-[var(--color-warn)]">실패</span>;
  }
  if (status === 'cancelled') {
    return <span className="text-[var(--color-muted)]">취소됨</span>;
  }
  return <span className="text-[var(--color-muted)]">대기 중</span>;
}

function fileIcon(mime: string) {
  if (mime.startsWith('image/')) return ImageIcon;
  if (mime.includes('presentation')) return Presentation;
  return FileText;
}
