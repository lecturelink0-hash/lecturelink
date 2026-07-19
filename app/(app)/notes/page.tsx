'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { api, ApiError } from '@/lib/api/client';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  Upload,
  FileText,
  Image as ImageIcon,
  Presentation,
  Loader2,
  Plus,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Pencil,
  X,
  CheckCircle2,
  XCircle,
  BookmarkPlus,
} from 'lucide-react';

type UploadStatus =
  | 'uploaded'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

type UploadKind = 'material' | 'reference';

interface UploadRow {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  status: UploadStatus;
  page_count: number | null;
  processed_at: string | null;
  created_at: string;
  error_message: string | null;
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
  return stem.replace(/\[이미지\s*(\d+)\]/g, (_m, n) => {
    let pos = seen.indexOf(n);
    if (pos === -1) { seen.push(n); pos = seen.length - 1; }
    return `[이미지 ${pos + 1}]`;
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

export default function NotesPage() {
  const materialInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);

  // 원본 학습자료(문제 생성용)와 보조 참고문항을 별도 상태로 관리.
  const [materials, setMaterials] = useState<UploadRow[]>([]);
  const [references, setReferences] = useState<UploadRow[]>([]);
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  // 문제 세트 정보 폼
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [folder, setFolder] = useState('');
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTIES)[number]>('중');
  const [questionType, setQuestionType] =
    useState<(typeof QUESTION_TYPES)[number]>('지식형');
  const [count, setCount] = useState(10);

  // AI 자동 분석 추천 설정
  const [analyzing, setAnalyzing] = useState(false);
  const [recommendation, setRecommendation] = useState<AnalyzeRes | null>(null);

  // 생성 결과 뷰
  const [generated, setGenerated] = useState<GeneratedResult | null>(null);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    refresh();
    loadSubjects();
  }, []);

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
    };
  }

  async function handleMaterialFile(file: File) {
    if (materials.length >= MAX_MATERIAL_FILES) {
      alert(`학습자료는 한 번에 최대 ${MAX_MATERIAL_FILES}개까지 업로드할 수 있어요.`);
      return;
    }
    setUploadingMaterial(true);
    try {
      const row = await uploadFile(file);
      if (!row) return;
      const next = [row, ...materials];
      setMaterials(next);
      // 학습자료 업로드 완료 → AI 자동 분석으로 추천 설정/폼 채움.
      runAnalyze(next.map((m) => m.id));
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : '업로드 실패';
      alert(msg);
    } finally {
      setUploadingMaterial(false);
      if (materialInputRef.current) materialInputRef.current.value = '';
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
      if (res.difficulty) setDifficulty(res.difficulty);
      if (res.question_type) setQuestionType(res.question_type);
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

  async function pollUploadStatus(uploadId: string): Promise<UploadDetailRes | null> {
    // 대용량 강의록은 OCR과 문항 생성에 5분 이상 걸릴 수 있다. 큐 작업은
    // 브라우저 요청과 독립적으로 진행되므로 충분히 기다리고 완료 상태를 복구한다.
    for (let i = 0; i < 300; i += 1) {
      try {
        const list = await api.get<UploadRow[]>('/api/uploads');
        const found = list.find((u) => u.id === uploadId);
        if (!found) return null;
        setMaterials((prev) =>
          prev.map((m) => (m.id === uploadId ? { ...m, ...found } : m)),
        );
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
      const res = await api.post<ProcessRes>(`/api/uploads/${uploadId}/process`, {
        desired_count: count,
        style: 'professor',
        difficulty,
        question_type: questionType,
        title: title.trim() || undefined,
        reference_upload_ids: references.map((reference) => reference.id),
      });

      if (res.status === 'queued') {
        const final = await pollUploadStatus(uploadId);
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
    const pending = materials.filter((m) => m.status === 'uploaded' || m.status === 'failed');
    if (pending.length === 0) {
      alert('생성할 학습자료를 먼저 업로드해주세요.');
      return;
    }
    const collected: GenQ[] = [];
    for (const m of pending) {
      const qs = await kickoffProcessing(m.id);
      collected.push(...qs);
    }
    // 생성된 문항이 하나라도 있으면 결과 뷰로 전환.
    if (collected.length > 0) {
      setGenerated({ total: collected.length, questions: collected });
      setShowResult(true);
    }
  }

  async function handleDelete(kind: UploadKind, uploadId: string) {
    if (!confirm('이 자료와 연결된 모든 생성 문항이 함께 삭제됩니다. 계속하시겠어요?')) {
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
    setQuestionType('지식형');
    setCount(10);
  }

  const isGenerating = processingId !== null;

  // ─────────────────────────────────────────────────────────────
  // (B) 생성 결과 뷰
  // ─────────────────────────────────────────────────────────────
  if (showResult && generated) {
    return (
      <ResultView
        result={generated}
        title={title}
        difficulty={difficulty}
        questionType={questionType}
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
  const folderName = subjects.find((s) => s.id === folder)?.name ?? '미지정';

  return (
    <div className="ll-upload-page content">
      {/* 헤더 */}
      <Link
        href="/dashboard"
        className="back"
      >
        <ArrowLeft className="w-4 h-4" />
        홈으로
      </Link>
      <section className="page-head"><div><span className="eyebrow">STEP 1 / 1 · 자료 업로드</span><h1>학습자료를 업로드하고<br/><span className="headline-accent">문제를 생성</span>하세요</h1><p className="lead">강의자료와 참고 문항을 바탕으로 예상 문제를 생성합니다.</p></div><div className="guide"><Link href="/tutorial" className="guide-trigger"><span className="guide-icon">?</span>사용 설명서</Link><div className="guide-panel"><h2>어떻게 사용하나요?</h2><ol><li><strong>학습자료 업로드</strong>: 업로드한 자료를 기반으로 문제를 생성합니다.</li><li><strong>참고 자료 추가</strong>: 예시 문항의 형식과 난이도를 반영합니다.</li><li><strong>문제 세트 정보 확인</strong>: 이름과 주제를 확인하고 수정합니다.</li></ol></div></div></section>

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

              <DropZone
                uploading={uploadingMaterial}
                onFile={handleMaterialFile}
                inputRef={materialInputRef}
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
                  <Field label="단원 / 주제" hint="문제가 다룰 핵심 주제예요. 이 주제를 중심으로 문항이 생성돼요.">
                    <input
                      type="text"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      placeholder="예: 판막질환"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--color-border)] text-sm text-sage-800 bg-white focus:outline-none focus:border-sage-500"
                    />
                  </Field>
                  <Field label="저장 폴더" hint="문제집이 저장될 과목 폴더예요. 자료 내용에 맞춰 AI가 자동 선택하며, 내 문제집에서 이 폴더로 찾을 수 있어요.">
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="난이도" hint="쉬움은 기본 개념 위주, 어려움은 지엽적·응용 내용까지 물어봐요. 난이도가 올라갈수록 문항이 까다로워져요.">
                    <Segmented
                      options={DIFFICULTIES}
                      value={difficulty}
                      onChange={setDifficulty}
                    />
                  </Field>
                  <Field
                    label="문항 유형"
                    hint="지식형: 개념·정의를 확인하는 문항 / 임상형: 환자 증례로 진단·처치를 묻는 문항 / 이미지형: 자료의 의료 이미지를 판독해 푸는 문항"
                  >
                    <Segmented
                      options={QUESTION_TYPES}
                      value={questionType}
                      onChange={setQuestionType}
                      cards
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
          <div className="flex flex-col justify-center rounded-2xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-sage-50)]/50 p-6">
            <p className="text-sm font-bold text-sage-700 mb-4">업로드하면 이렇게 진행돼요</p>
            <ol className="space-y-4">
              <li className="flex items-start gap-3">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[var(--color-sage-400)] text-base font-bold text-[var(--color-sage-500)]">2</span>
                <div>
                  <div className="text-sm font-semibold text-sage-700">자동 분석 · 설정 확인</div>
                  <div className="text-xs text-[var(--color-muted)] mt-0.5 leading-relaxed">AI가 제목·과목·난이도를 추천해요. 참고 자료도 추가할 수 있어요.</div>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[var(--color-sage-400)] text-base font-bold text-[var(--color-sage-500)]">3</span>
                <div>
                  <div className="text-sm font-semibold text-sage-700">문제 생성</div>
                  <div className="text-xs text-[var(--color-muted)] mt-0.5 leading-relaxed">올린 자료를 바탕으로 예상 문제 세트가 자동으로 만들어져요.</div>
                </div>
              </li>
            </ol>
            <p className="mt-5 text-xs text-[var(--color-muted)] leading-relaxed">
              먼저 왼쪽 <b className="text-sage-700">1. 학습자료</b> 칸에 파일을 올려주세요. 올리는 즉시 위 단계가 순서대로 나타납니다.
            </p>
          </div>
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
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-muted)]">
                    <Pencil className="w-3.5 h-3.5" strokeWidth={2} />
                    수정
                  </span>
                }
              />

              {analyzing ? (
                <div className="flex items-center gap-2 text-sm text-[var(--color-muted)] py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  자료를 분석하는 중...
                </div>
              ) : recommendation ? (
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
                  <div className="flex items-center gap-1.5 mt-4 text-xs font-medium text-sage-700">
                    <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                    추천 설정이 적용되었습니다.
                  </div>
                </>
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
                <SummaryRow label="문항 수" value={`${count}문항`} />
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
function ResultView({
  result,
  title,
  difficulty,
  questionType,
  onReset,
}: {
  result: GeneratedResult;
  title: string;
  difficulty: string;
  questionType: string;
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
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent-bg)] px-3 py-1.5 text-[0.72rem] font-bold tracking-wide text-[var(--color-accent-dark)] mb-4">
          <Check className="w-3.5 h-3.5" strokeWidth={2.6} />
          STEP 2 / 2 · 생성 완료
        </span>
        <h1 className="text-[2.4rem] leading-[1.1] font-bold text-sage-800 tracking-[-0.03em]">
          문제집이 완성됐어요
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge variant="private">{result.total}문항</Badge>
          <Badge variant="default">난이도 {difficulty}</Badge>
          <Badge variant="default">{questionType}</Badge>
          {title && (
            <span className="text-sm text-[var(--color-muted)]">· {title}</span>
          )}
        </div>
      </div>

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

  async function submitAnswer() {
    if (selected === null || outcome) return;
    setSubmitting(true);
    try {
      const response = await api.post<AttemptResponse>('/api/attempts', {
        question_id: q.id,
        selected_index: selected,
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
      <div className="flex items-start gap-3.5 mb-5">
        <span
          className="ll-chip flex-shrink-0 text-sm font-bold tabular-nums"
          style={{ width: '2.25rem', height: '2.25rem' }}
        >
          {index}
        </span>
        <p className="text-base text-sage-800 font-medium leading-relaxed pt-1.5">
          {withImageLabels(q.stem)}
        </p>
      </div>

      {q.images && q.images.length > 0 && (
        <div className="mb-5 space-y-2">
          {q.images.map((img, ii) => (
            <figure key={ii}>
              <figcaption className="text-[12px] font-semibold text-sage-700 mb-1">이미지 {ii + 1}</figcaption>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.caption ?? `이미지 ${ii + 1}`} className="w-full max-h-80 object-contain rounded-xl border border-[var(--color-border)] bg-white" />
              {img.caption && (
                <figcaption className="mt-1 text-[12px] text-[var(--color-muted)] text-center">{img.caption}</figcaption>
              )}
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
                onClick={() => !outcome && setSelected(ci)}
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
      <span className="field-label">
        {label}
        {hint && (
          <span
            title={hint}
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--color-border)] text-[9px] font-bold text-[var(--color-muted)] cursor-help"
          >
            ?
          </span>
        )}
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

function Segmented<T extends string>({
  options,
  value,
  onChange,
  cards = false,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  cards?: boolean;
}) {
  return (
    <div className={cards ? 'checkset' : 'segmented'}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            aria-pressed={active}
            className={`${cards ? 'check-card' : ''} ${active ? 'active' : ''}`}
          >
            {cards && <span className="check-box" aria-hidden />}
            {opt}
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

function DropZone({
  uploading,
  onFile,
  inputRef,
  title,
  hint,
}: {
  uploading: boolean;
  onFile: (file: File) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  title: string;
  hint: string;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      className={clsx(
        'dropzone',
        dragOver
          ? 'border-sage-600 ll-tint'
          : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-sage-400 hover:bg-[var(--color-sage-50)]',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <div className="flex justify-center mb-3">
        {uploading ? (
          <span className="upload-badge">
            <Loader2 className="w-5 h-5 animate-spin" />
          </span>
        ) : (
          <span className="upload-badge">
            <Upload className="w-5 h-5" strokeWidth={1.9} />
          </span>
        )}
      </div>
      <div className="drop-title">
        {uploading ? '업로드 중...' : title}
      </div>
      <div className="drop-help">{hint}</div>
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
          <StatusLabel status={upload.status} isProcessing={isProcessing} />
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
  status,
  isProcessing,
}: {
  status: UploadStatus;
  isProcessing: boolean;
}) {
  if (status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--color-beta)]">
        <Loader2 className="w-3 h-3 animate-spin" />
        큐 대기
      </span>
    );
  }
  if (isProcessing || status === 'processing') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--color-beta)]">
        <Loader2 className="w-3 h-3 animate-spin" />
        AI 처리 중
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
