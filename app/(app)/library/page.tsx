'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { findNextUnansweredQuestionId } from '@/lib/library-progress';
import { generatedSetLabel, isGeneratedSet } from '@/lib/generated-sets';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { AiGeneratedNotice } from '@/components/ui/AiGeneratedNotice';
import {
  Heart, Wind, Utensils, Droplet, Droplets, Bug, Activity, Flower2,
  Ribbon, Bone, Scissors, Baby, Brain, Ear, Eye, Fingerprint, Shield, Scale,
  Stethoscope, ChevronLeft, ChevronDown, ChevronRight, AlertTriangle, FileText,
  FolderOpen, Folder, Upload, BookOpen, Search, ArrowLeft, Trash2, type LucideIcon,
  CheckCircle2, XCircle, BookmarkPlus,
} from 'lucide-react';
import { QuestionStem } from '@/components/ui/QuestionStem';
// 목록을 N개씩 끊어 ‹ › 로 넘기는 공용 페이저 — CPX 세부 채점(#191)과 같은 것을 쓴다.
import CpxPagedList from '@/components/cpx/CpxPagedList';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SubTopic {
  id: string;
  name: string;
  parent_id: string | null;
  level: number;
  exam_relevance: 1 | 2 | 3;
  is_risk_category: boolean;
}

interface Subject {
  id: string;
  code: string;
  name: string;
  sub_topics: SubTopic[];
}

interface Upload {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  status: string;
  created_at: string;
}

interface PrivateQuestion {
  id: string;
  stem: string;
  choices: string[];
  answer_index: number;
  explanation: string | null;
  concepts?: string[];
  difficulty: 1 | 2 | 3;
  upload_id: string;
  sub_topic_id?: string | null;
  images?: { url: string; kind: string | null; caption: string | null }[];
}

interface PublicQuestion {
  id: string;
  stem: string;
  choices: string[];
  concepts: string[];
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: string | null;
  tier: 'curated' | 'community' | 'beta';
  badge: { label: string; color: 'curated' | 'community' | 'beta' };
  subjectName: string;
  subTopicName: string;
  subTopicId: string | null;
}

// 선택된 항목 — discriminated union
type ActiveItem =
  | { kind: 'subTopic'; subTopicId: string; name: string; subjectName: string }
  | { kind: 'upload'; uploadId: string; fileName: string };

// 문제집(업로드) 학습 상태 — 풀이 기록 API가 이 화면 범위에 없어 문항 난이도 구성으로 파생.
type SetStatus = 'inprogress' | 'done';

interface UploadProgress {
  total: number;
  attempted: number;
  correct: number;
  lastAttemptedQuestionId?: string | null;
}

interface SetItem {
  upload: Upload;
  count: number;
  status: SetStatus;
  attempted: number;
  correct: number;
  progressTotal: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickIcon(name: string): LucideIcon {
  if (/외과/.test(name)) return Scissors;
  if (/순환|심/.test(name)) return Heart;
  if (/호흡|폐/.test(name)) return Wind;
  if (/소화|위장|간담췌/.test(name)) return Utensils;
  if (/비뇨/.test(name)) return Droplets;
  if (/신장|콩팥/.test(name)) return Droplet;
  if (/감염/.test(name)) return Bug;
  if (/내분비/.test(name)) return Activity;
  if (/알레르기|알러지/.test(name)) return Flower2;
  if (/혈액/.test(name)) return Droplets;
  if (/종양|암/.test(name)) return Ribbon;
  if (/류마티스|정형|골/.test(name)) return Bone;
  if (/부인|산과|소아/.test(name)) return Baby;
  if (/정신|신경/.test(name)) return Brain;
  if (/이비인후/.test(name)) return Ear;
  if (/안과/.test(name)) return Eye;
  if (/피부/.test(name)) return Fingerprint;
  if (/예방/.test(name)) return Shield;
  if (/법규|법/.test(name)) return Scale;
  return Stethoscope;
}

const STATUS_FILTERS: { key: SetStatus | 'all'; label: string }[] = [
  { key: 'all', label: '전체 문제집' },
  { key: 'inprogress', label: '풀이 중' },
  { key: 'done', label: '완료' },
];

/** 문제집 그리드 한 쪽에 보여줄 카드 수 — 모바일에서 목록이 무한히 늘어지지 않게 하는 기준.
 *  실측(폭 386px): 57개 = 15,034px(약 17.9화면) → 5개면 1,306px(1.6화면)·12쪽.
 *  데스크톱은 2열이라 6개면 3줄로 딱 떨어진다(5개는 마지막 줄이 한 칸 비었다). */
const SETS_PER_PAGE = 6;

const STATUS_BADGE: Record<SetStatus, { label: string; variant: 'default' | 'curated' }> = {
  inprogress: { label: '풀이 중', variant: 'default' },
  done: { label: '완료', variant: 'curated' },
};

/** 문항 난이도 구성으로 문제집 상태를 파생(풀이 기록이 아직 없을 때의 근사치). */
function deriveStatus(qs: PrivateQuestion[]): SetStatus {
  return 'inprogress';
}

/**
 * 실제 풀이 기록 기반 상태(진행 우선):
 *  - 아직 다 안 풀었으면 → '풀이 중'
 *  - 다 풀었는데 오답 있으면 → '오답 복습 필요'
 *  - 다 풀고 다 맞으면 → '완료'
 * (attempted > 0 일 때만 호출된다.)
 */
function realStatus(total: number, attempted: number, correct: number): SetStatus {
  if (total > 0 && attempted < total) return 'inprogress';
  return 'done';
}

/**
 * 지문의 이미지 참조 [이미지 N] 을 사용자용 라벨과 맞춘다.
 * 지문의 N 은 생성 배치 전체 기준 순번(예: 11번째=10)이라 문항별 이미지(0부터)와 어긋난다.
 * → 지문에 "등장한 순서"대로 1,2,3… 으로 다시 매겨, 각 이미지의 "이미지 1/2/…" 라벨과 일치시킴.
 */
function withImageLabels(stem: string): string {
  const seen: string[] = [];
  // [이미지 N]/(이미지 N)/이미지 N 형태와 무관하게 번호만 등장 순서(1,2,…)로 재매김.
  return stem.replace(/이미지\s*(\d+)/g, (_m, n) => {
    let pos = seen.indexOf(n);
    if (pos === -1) { seen.push(n); pos = seen.length - 1; }
    return `이미지 ${pos + 1}`;
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function fileTypeLabel(ft: string): string {
  const t = (ft || '').toLowerCase();
  if (t.includes('pdf')) return 'PDF';
  if (t.includes('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg')) return '이미지';
  if (t.includes('word') || t.includes('doc')) return '문서';
  if (t.includes('ppt') || t.includes('presentation')) return '슬라이드';
  return '자료';
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function LibraryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedUploadId = searchParams.get('set');
  const requestedReset = searchParams.get('reset') === '1';
  const requestedResume = searchParams.get('resume') === '1';

  // 폴더 트리 데이터
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);

  // 각 노드별 독립 expand 상태
  // 최상위 키: 'root_national' | 'root_private'
  // 과목 키: 'subject_<id>'
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 세부주제별 문항 수 { subTopicId -> count } — 마운트 시 전역 1회 로드 (null = 로딩 중)
  const [subTopicCounts, setSubTopicCounts] = useState<Record<string, number> | null>(null);

  // 선택된 항목 및 우측 콘텐츠
  const [active, setActive] = useState<ActiveItem | null>(null);
  const [publicQuestions, setPublicQuestions] = useState<PublicQuestion[]>([]);
  const [privateQuestions, setPrivateQuestions] = useState<PrivateQuestion[]>([]);
  const [allPrivateQuestions, setAllPrivateQuestions] = useState<PrivateQuestion[]>([]);
  const [loadingRight, setLoadingRight] = useState(false);
  const [privateQuestionsError, setPrivateQuestionsError] = useState<string | null>(null);
  const [privateQuestionsReloadKey, setPrivateQuestionsReloadKey] = useState(0);

  // 세트별 진행도/정답률 (업로드 id → {total, attempted, correct})
  const [progressByUpload, setProgressByUpload] = useState<Record<string, UploadProgress>>({});
  const [overallProgress, setOverallProgress] = useState<{ attempted: number; correct: number } | null>(null);
  const [progressLoaded, setProgressLoaded] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  // 문항별 최신 풀이(이어풀기 시 이전 답 복원용) — private_question_id → {selectedIndex, isCorrect}
  const [attemptsByQuestion, setAttemptsByQuestion] = useState<Record<string, { selectedIndex: number; isCorrect: boolean }>>({});
  // 다시풀기(완료 세트) 로 열었는지 — true 면 이전 답 복원 없이 빈 상태로.
  const [solveReset, setSolveReset] = useState(false);
  const [resumeFromQuestionId, setResumeFromQuestionId] = useState<string | null>(null);

  // 학습 상태 필터 · 검색어 (우측 문제집 그리드용)
  const [statusFilter, setStatusFilter] = useState<SetStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deletingSet, setDeletingSet] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!deleteNotice) return;
    const timer = window.setTimeout(() => setDeleteNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [deleteNotice]);

  // ── 초기 로드 ──────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      api
        .get<Subject[]>('/api/subjects?with_sub_topics=true&active_only=true')
        .catch((): Subject[] => []),
      api.get<Upload[]>('/api/uploads').catch((): Upload[] => []),
    ])
      .then(([subs, ups]) => {
        setSubjects(subs);
        setUploads(ups);
      })
      .finally(() => setLoadingTree(false));
    // 세부주제별 문항 수 — 요청 1회로 전체 로드(펼칠 때마다 leaf당 count 요청을 발사하던 방식 대체)
    api
      .get<{ total: number; counts: Record<string, number> }>('/api/questions?count_by=sub_topic')
      .then((r) => setSubTopicCounts(r.counts))
      .catch(() => setSubTopicCounts({}));
  }, []);

  // private-questions 전역 캐시(서버 상한 100) — 목록 즉시 표시용. 세트를 열면 별도 효과가 그 세트 전 문항을 받는다.
  useEffect(() => {
    api
      .get<unknown>('/api/private-questions?limit=100')
      .then((res) => {
        const arr: PrivateQuestion[] = Array.isArray(res)
          ? (res as PrivateQuestion[])
          : ((res as { items?: PrivateQuestion[] }).items ?? []);
        setAllPrivateQuestions(arr);
      })
      .catch(() => {});
  }, []);

  // 세트별 진행도/정답률 로드 (마운트 + 풀이 후 갱신)
  // 이어풀기 링크(/library?set=업로드ID)로 들어오면 해당 문제집을 바로 연다.
  // 문항 목록이 나중에 도착하는 경우에도 다시 반영해 빈 화면으로 멈추지 않는다.
  // 같은 요청(세트+모드)이 이미 열려 있으면 openUpload 를 반복하지 않는다 — 채점 후 진행도
  // 재조회가 progressByUpload 를 갈아끼워 이 이펙트가 재발화하는데, 그때 openUpload 가
  // 문항을 비우고 setLoadingRight(true)로 되돌리면 문항 fetch 이펙트는 activeUploadId 가
  // 그대로라 다시 돌지 않아 "진행도를 불러오는 중" 화면에 영영 갇힌다.
  const openedSetRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedUploadId) {
      openedSetRequestRef.current = null;
      return;
    }
    const upload = uploads.find((item) => item.id === requestedUploadId);
    if (!upload) return;

    const requestSignature = `${upload.id}:${requestedReset ? 'reset' : requestedResume ? 'resume' : 'open'}`;
    if (openedSetRequestRef.current !== requestSignature) {
      openedSetRequestRef.current = requestSignature;
      openUpload(upload, requestedReset);
    }
    setResumeFromQuestionId(
      requestedResume ? progressByUpload[upload.id]?.lastAttemptedQuestionId ?? null : null,
    );
  }, [requestedUploadId, requestedReset, requestedResume, uploads, allPrivateQuestions, progressByUpload]);

  // 문제집을 연 뒤 실제 풀이 영역을 화면 상단에 보여준다.
  // 채점 때마다 진행도 재조회(loadProgress)가 위 ?set= 이펙트를 통해 active 를 새 객체로
  // 재설정해 이 이펙트가 재발화하므로, 같은 문제집이 열려 있는 동안에는 다시 스크롤하지 않는다.
  const scrolledUploadIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (active?.kind !== 'upload') {
      scrolledUploadIdRef.current = null;
      return;
    }
    if (scrolledUploadIdRef.current === active.uploadId) return;
    scrolledUploadIdRef.current = active.uploadId;
    const frame = window.requestAnimationFrame(() => {
      const resumeTarget = document.querySelector<HTMLElement>('[data-library-resume-target="true"]');
      (resumeTarget ?? document.getElementById('library-solve'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, privateQuestions, resumeFromQuestionId]);

  // 연 문제집의 문항 전체 로드 — 전역 캐시(100개 컷)에 안 담긴 세트도 전 문항이 보이도록 서버에서 다시 받는다.
  const activeUploadId = active?.kind === 'upload' ? active.uploadId : null;
  useEffect(() => {
    if (!activeUploadId) return;
    let cancelled = false;
    setLoadingRight(true);
    setPrivateQuestionsError(null);
    (async () => {
      try {
        const collected: PrivateQuestion[] = [];
        let offset = 0;
        for (;;) {
          const res = await api.get<{ items?: PrivateQuestion[]; total: number }>(
            `/api/private-questions?upload_id=${activeUploadId}&limit=100&offset=${offset}`,
          );
          const items = res.items ?? [];
          collected.push(...items);
          offset += items.length;
          if (items.length === 0 || offset >= res.total) break;
        }
        if (!cancelled) setPrivateQuestions(collected);
      } catch {
        if (!cancelled) {
          setPrivateQuestions([]);
          setPrivateQuestionsError('문항을 불러오지 못했어요. 다시 시도해주세요.');
        }
      } finally {
        if (!cancelled) setLoadingRight(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeUploadId, privateQuestionsReloadKey]);

  const loadProgress = useCallback((showLoading = false) => {
    if (showLoading) setProgressLoaded(false);
    setProgressError(null);
    api
      .get<{
        overall: { attempted: number; correct: number };
        byUpload: Record<string, UploadProgress>;
        byQuestion: Record<string, { selectedIndex: number; isCorrect: boolean }>;
      }>('/api/me/library-progress')
      .then((res) => {
        setProgressByUpload(res.byUpload ?? {});
        setOverallProgress(res.overall ?? null);
        setAttemptsByQuestion(res.byQuestion ?? {});
      })
      .catch(() => setProgressError('진행도를 불러오지 못했어요. 다시 시도해주세요.'))
      .finally(() => setProgressLoaded(true));
  }, []);

  useEffect(() => {
    loadProgress(true);
  }, [loadProgress]);

  // ── 토글 ──────────────────────────────────────────────────────────────────

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  const midsOf = (s: Subject) => s.sub_topics.filter((t) => t.level === 1);
  const leavesOf = (s: Subject, midId: string) =>
    s.sub_topics.filter((t) => t.level === 2 && t.parent_id === midId);

  function toggleSubject(subject: Subject) {
    toggle(`subject_${subject.id}`);
  }

  function toggleMid(mid: SubTopic) {
    toggle(`mid_${mid.id}`);
  }

  // ── 우측 콘텐츠 로드 ──────────────────────────────────────────────────────

  async function openSubTopic(st: SubTopic, subjectName: string) {
    setActive({ kind: 'subTopic', subTopicId: st.id, name: st.name, subjectName });
    setLoadingRight(true);
    setPublicQuestions([]);
    setPrivateQuestions([]);
    try {
      const qs = await api.get<PublicQuestion[]>(
        `/api/questions?sub_topic_id=${st.id}&limit=20`,
      );
      setPublicQuestions(qs);
    } catch (e) {
      if (e instanceof ApiError) {
        // silent — show empty state
      }
    } finally {
      setLoadingRight(false);
    }
  }

  function continueUpload(upload: Upload, reset = false) {
    const params = new URLSearchParams({ set: upload.id });
    if (reset) params.set('reset', '1');
    else params.set('resume', '1');
    router.push(`/library?${params.toString()}`);
  }

  function closeActive() {
    setActive(null);
    setResumeFromQuestionId(null);
    router.replace('/library', { scroll: false });
  }

  function openUpload(upload: Upload, reset = false) {
    setActive({ kind: 'upload', uploadId: upload.id, fileName: upload.file_name });
    setLoadingRight(true);
    setPrivateQuestionsError(null);
    setPublicQuestions([]);
    setSolveReset(reset); // 다시풀기 = 이전 답 복원 없이 빈 상태로 시작
    setPrivateQuestions([]);
  }

  function selectFilter(key: SetStatus | 'all') {
    setStatusFilter(key);
    closeActive();
  }

  function handleDeleteSet(uploadId: string, fileName: string) {
    setDeleteError(null);
    setDeleteNotice(null);
    setDeleteTarget({ id: uploadId, name: fileName });
  }

  async function confirmDeleteSet() {
    if (!deleteTarget || deletingSet) return;
    const { id: uploadId } = deleteTarget;
    setDeletingSet(true);
    setDeleteError(null);
    try {
      await api.delete(`/api/uploads/${uploadId}`);
      setUploads((prev) => prev.filter((u) => u.id !== uploadId));
      setAllPrivateQuestions((prev) => prev.filter((q) => q.upload_id !== uploadId));
      if (active?.kind === 'upload' && active.uploadId === uploadId) setActive(null);
      setDeleteTarget(null);
      setDeleteNotice('문제집을 삭제했어요.');
    } catch {
      setDeleteError('문제집을 삭제하지 못했어요. 다시 시도해주세요.');
    } finally {
      setDeletingSet(false);
    }
  }

  // ── 파생 데이터 (문제집 그리드 · 통계) ────────────────────────────────────

  // 내신대비, QR 형성평가, 오답노트·약점분석에서 자동 저장된 생성 문제집을 한곳에 표시한다.
  const nationalSimilarUploads = uploads.filter((upload) => isGeneratedSet(upload.file_type));
  const formativeUploads = uploads.filter((upload) => upload.file_type === 'formative/live');
  const schoolUploads = uploads.filter(
    (upload) => !isGeneratedSet(upload.file_type) && upload.file_type !== 'formative/live',
  );
  const libraryUploads = [...schoolUploads, ...formativeUploads, ...nationalSimilarUploads];
  const setItems: SetItem[] = libraryUploads.map((u) => {
    const qs = allPrivateQuestions.filter((q) => q.upload_id === u.id);
    const p = progressByUpload[u.id];
    const total = p?.total ?? qs.length;
    const attempted = p?.attempted ?? 0;
    const correct = p?.correct ?? 0;
    const status = attempted > 0 ? realStatus(total, attempted, correct) : deriveStatus(qs);
    return { upload: u, count: total, status, attempted, correct, progressTotal: total };
  });

  const overallAccuracy =
    overallProgress && overallProgress.attempted > 0
      ? Math.round((overallProgress.correct / overallProgress.attempted) * 100)
      : null;

  const statusCounts: Record<SetStatus | 'all', number> = {
    all: setItems.length,
    inprogress: setItems.filter((s) => s.status === 'inprogress').length,
    done: setItems.filter((s) => s.status === 'done').length,
  };

  const q = query.trim().toLowerCase();
  const visibleSets = setItems.filter(
    (s) =>
      (statusFilter === 'all' || s.status === statusFilter) &&
      (q === '' || s.upload.file_name.toLowerCase().includes(q)),
  );
  const nextSet = setItems.find((item) => item.status === 'inprogress') ?? setItems[0] ?? null;
  const nextSetDone = Boolean(nextSet && nextSet.progressTotal > 0 && nextSet.attempted >= nextSet.progressTotal);

  const currentFilterLabel =
    STATUS_FILTERS.find((f) => f.key === statusFilter)?.label ?? '전체 문제집';

  // ─── Render ───────────────────────────────────────────────────────────────

  const rootNationalOpen = expanded['root_national'] ?? false;
  const rootSchoolOpen = expanded['folder_school'] ?? false;
  const rootNationalSimilarOpen = expanded['folder_national'] ?? false;
  const rootFormativeOpen = expanded['folder_formative'] ?? false;
  const folderLabelStyle = {
    fontFamily: 'var(--font-body)',
    fontSize: '13.5px',
    fontWeight: 700,
    lineHeight: 1.35,
  };

  return (
    <div className="ll-library-page content">
      <section className="page-head"><div><span className="eyebrow">내 문제집</span><h1>만든 문제집을<br/><span className="headline-accent">한곳에서 모아보세요</span></h1><p className="lead">강의자료로 만든 문제집을 확인하고, 풀던 문제를 이어서 학습할 수 있어요.</p></div></section>
      <AiGeneratedNotice className="mb-5" />

      {nextSet && (
        <div className="focus-band"><section className="next-action" aria-label="이어풀기 추천">
          <div>
            <h2 className="next-title">{nextSet.upload.file_name}</h2>
            <p className="next-copy">{nextSetDone ? '완료한 문제집입니다. 처음부터 다시 풀며 복습할 수 있어요.' : '마지막으로 학습하던 문제집입니다. 다음 미풀이 문항부터 바로 이어갈 수 있어요.'}</p>
          </div>
          <div className="next-panel">
            <div className="next-panel-row"><span>진행도</span><strong>{nextSet.attempted}/{nextSet.progressTotal || nextSet.count}</strong></div>
            <div className="bar"><span style={{ width: `${Math.min(100, Math.round((nextSet.attempted / Math.max(1, nextSet.progressTotal || nextSet.count)) * 100))}%` }} /></div>
            <div className="next-panel-row"><span>최근 정답률</span><strong>{nextSet.attempted ? Math.round((nextSet.correct / nextSet.attempted) * 100) : 0}%</strong></div>
            <button className="hero-cta" type="button" onClick={() => continueUpload(nextSet.upload, nextSetDone)}>{nextSetDone ? '다시 풀기' : nextSet.attempted > 0 ? '이어풀기' : '문제 풀기'}</button>
          </div>
        </section></div>
      )}

      <div className="layout">
        {/* ─── 좌측: 학습 상태 + 폴더 패널 ─────────────────────────────────── */}
        <Card className="sidebar">
          {/* 학습 상태 필터 */}
          <div className="side-title">학습 상태</div>
          <div className="side-list">
            {STATUS_FILTERS.map((f) => {
              const isSel = active === null && statusFilter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => selectFilter(f.key)}
                  className={`side-btn ${
                    isSel
                      ? 'bg-sage-700 text-white font-semibold'
                      : 'text-sage-800 hover:bg-[var(--color-sage-100)]'
                  }`}
                >
                  <span className="label">{f.label}</span>
                  <span className={`side-count ${isSel ? 'text-white/80' : 'text-[var(--color-muted)]'}`}>
                    {statusCounts[f.key]}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-[var(--color-border)] my-2" />

          {/* 폴더 트리 */}
          <div className="side-section"><div className="side-title">폴더</div></div>
          {loadingTree ? (
            <div className="text-xs text-[var(--color-muted)] px-2 py-6">불러오는 중...</div>
          ) : (
            <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">

              {/* ── 최상위: 국시 문제 ── */}
              <div className="hidden">
                <button
                  onClick={() => toggle('root_national')}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[var(--color-sage-100)] text-left transition-colors"
                >
                  <span
                    className="ll-chip"
                    style={{ width: '2rem', height: '2rem', borderRadius: '10px' }}
                  >
                    <BookOpen className="w-4 h-4" strokeWidth={2} />
                  </span>
                  <span className="text-[13.5px] font-bold text-sage-800 flex-1">국시 문제</span>
                  {rootNationalOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--color-muted)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--color-muted)]" />
                  )}
                </button>

                {rootNationalOpen && (
                  <div className="ml-3 border-l border-[var(--color-border)] pl-2 my-1">
                    {subjects.length === 0 ? (
                      <div className="text-[11px] text-[var(--color-muted)] px-2 py-2">
                        등록된 과목이 없습니다.
                      </div>
                    ) : (
                      subjects.map((subject) => {
                        const Icon = pickIcon(subject.name);
                        const subjectKey = `subject_${subject.id}`;
                        const subjectOpen = expanded[subjectKey] ?? false;
                        return (
                          <div key={subject.id}>
                            {/* 과목 행 */}
                            <button
                              onClick={() => toggleSubject(subject)}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-sage-100)] text-left transition-colors"
                            >
                              <span
                                className="ll-chip"
                                style={{ width: '1.75rem', height: '1.75rem', borderRadius: '9px' }}
                              >
                                <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                              </span>
                              <span className="text-[13px] font-semibold text-sage-800 flex-1">
                                {subject.name}
                              </span>
                              {subjectOpen ? (
                                <ChevronDown className="w-3.5 h-3.5 text-[var(--color-muted)]" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-[var(--color-muted)]" />
                              )}
                            </button>

                            {/* 세부주제 목록 */}
                            {subjectOpen && (
                              <div className="ml-6 border-l border-[var(--color-border)] pl-2 my-0.5">
                                {midsOf(subject).length === 0 ? (
                                  <div className="text-[11px] text-[var(--color-muted)] px-2 py-1.5">
                                    세부주제 준비 중
                                  </div>
                                ) : (
                                  midsOf(subject).map((mid) => {
                                    const midKey = `mid_${mid.id}`;
                                    const midOpen = expanded[midKey] ?? false;
                                    const leaves = leavesOf(subject, mid.id);
                                    const midActive =
                                      active?.kind === 'subTopic' && active.subTopicId === mid.id;
                                    return (
                                      <div key={mid.id}>
                                        <button
                                          onClick={() =>
                                            leaves.length > 0
                                              ? toggleMid(mid)
                                              : openSubTopic(mid, subject.name)
                                          }
                                          className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                                            midActive
                                              ? 'bg-sage-700 text-white font-semibold shadow-[0_4px_12px_-4px_rgba(31,92,67,0.55)]'
                                              : 'text-sage-800 hover:bg-[var(--color-sage-100)]'
                                          }`}
                                        >
                                          {mid.is_risk_category && (
                                            <AlertTriangle className={`w-3 h-3 flex-shrink-0 ${midActive ? 'text-white opacity-80' : 'text-[var(--color-warn)]'}`} />
                                          )}
                                          <span className="flex-1 leading-snug">{mid.name}</span>
                                          {leaves.length > 0 &&
                                            (midOpen ? (
                                              <ChevronDown className={`w-3 h-3 flex-shrink-0 ${midActive ? 'text-white opacity-80' : 'text-[var(--color-muted)]'}`} />
                                            ) : (
                                              <ChevronRight className={`w-3 h-3 flex-shrink-0 ${midActive ? 'text-white opacity-80' : 'text-[var(--color-muted)]'}`} />
                                            ))}
                                        </button>
                                        {midOpen && leaves.length > 0 && (
                                          <div className="ml-4 border-l border-[var(--color-border)] pl-2 my-0.5">
                                            {leaves.map((leaf) => {
                                              const isActive =
                                                active?.kind === 'subTopic' &&
                                                active.subTopicId === leaf.id;
                                              const count = subTopicCounts ? (subTopicCounts[leaf.id] ?? 0) : undefined;
                                              const counting = subTopicCounts === null;
                                              return (
                                                <button
                                                  key={leaf.id}
                                                  onClick={() => openSubTopic(leaf, subject.name)}
                                                  className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-left text-[11.5px] transition-colors ${
                                                    isActive
                                                      ? 'bg-sage-700 text-white font-semibold shadow-[0_4px_12px_-4px_rgba(31,92,67,0.55)]'
                                                      : 'text-[var(--color-muted)] hover:bg-[var(--color-sage-100)] hover:text-sage-800'
                                                  }`}
                                                >
                                                  {leaf.is_risk_category && (
                                                    <AlertTriangle
                                                      className={`w-3 h-3 flex-shrink-0 ${
                                                        isActive ? 'text-white opacity-80' : 'text-[var(--color-warn)]'
                                                      }`}
                                                    />
                                                  )}
                                                  <span className="flex-1 leading-snug">{leaf.name}</span>
                                                  {counting ? (
                                                    <span className="text-[10px] opacity-60">…</span>
                                                  ) : count !== undefined ? (
                                                    <span
                                                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0 ${
                                                        isActive ? 'bg-white/20 text-white' : 'bg-[var(--color-sage-100)] text-sage-700'
                                                      }`}
                                                    >
                                                      {count}
                                                    </span>
                                                  ) : null}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {/* 구분선 */}
              <div className="hidden border-t border-[var(--color-border)] my-1.5" />

              {/* ── 최상위: 내 문제집 ── */}
              <div>
                <button
                  onClick={() => toggle('folder_school')}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[var(--color-sage-100)] text-left transition-colors"
                >
                  <span
                    className="ll-chip"
                    style={{
                      width: '2rem',
                      height: '2rem',
                      borderRadius: '10px',
                      background: 'var(--color-sage-100)',
                      color: 'var(--color-sage-700)',
                    }}
                  >
                    {rootSchoolOpen ? (
                      <FolderOpen className="w-4 h-4" strokeWidth={2} />
                    ) : (
                      <Folder className="w-4 h-4" strokeWidth={2} />
                    )}
                  </span>
                  <span className="flex-1" style={{ ...folderLabelStyle, color: 'var(--color-sage-800)' }}>
                    내신대비
                  </span>
                  {rootSchoolOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--color-muted)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--color-muted)]" />
                  )}
                </button>

                {rootSchoolOpen && (
                  <div className="ml-3 border-l border-[var(--color-border)] pl-2 my-1">
                    {schoolUploads.length === 0 ? (
                      /* 빈 상태 */
                      <div className="px-2 py-3">
                        <p className="text-[11px] text-[var(--color-muted)] leading-relaxed mb-2">
                          내신대비에서 생성한 문제집이 없습니다.
                          <br />
                          내신대비에서 학습자료로 문제를 만들어 보세요.
                        </p>
                        <Link
                          href="/upload"
                          className="text-[11px] font-semibold underline"
                          style={{ color: 'var(--color-sage-700)' }}
                        >
                          내신대비 바로가기 →
                        </Link>
                      </div>
                    ) : (
                      schoolUploads.map((upload) => {
                        const isActive =
                          active?.kind === 'upload' && active.uploadId === upload.id;
                        return (
                          <button
                            key={upload.id}
                            onClick={() => continueUpload(upload)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors"
                            style={
                              isActive
                                ? {
                                    background: 'var(--color-sage-700)',
                                    color: 'white',
                                    boxShadow: '0 4px 12px -4px rgba(31,92,67,0.55)',
                                  }
                                : {}
                            }
                            onMouseEnter={(e) => {
                              if (!isActive) {
                                (e.currentTarget as HTMLButtonElement).style.background =
                                  'var(--color-sage-100)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) {
                                (e.currentTarget as HTMLButtonElement).style.background = '';
                              }
                            }}
                          >
                            <FileText
                              className="w-3.5 h-3.5 flex-shrink-0"
                              style={{
                                color: isActive
                                  ? 'rgba(255,255,255,0.8)'
                                  : 'var(--color-sage-700)',
                              }}
                              strokeWidth={2}
                            />
                            <span
                              className="flex-1 truncate"
                              style={
                                isActive
                                  ? folderLabelStyle
                                  : { ...folderLabelStyle, color: 'var(--color-sage-800)' }
                              }
                            >
                              {upload.file_name}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--color-border)] my-1.5" />

              {/* QR 평가 종료 화면에서 저장한 형성평가 */}
              <div>
                <button
                  onClick={() => toggle('folder_formative')}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[var(--color-sage-100)] text-left transition-colors"
                >
                  <span className="ll-chip" style={{ width: '2rem', height: '2rem', borderRadius: '10px', background: 'var(--color-sage-100)', color: 'var(--color-sage-700)' }}>
                    {rootFormativeOpen ? <FolderOpen className="w-4 h-4" strokeWidth={2} /> : <Folder className="w-4 h-4" strokeWidth={2} />}
                  </span>
                  <span className="text-sage-800 flex-1" style={folderLabelStyle}>형성평가</span>
                  {rootFormativeOpen ? <ChevronDown className="w-4 h-4 text-[var(--color-muted)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-muted)]" />}
                </button>
                {rootFormativeOpen && (
                  <div className="ml-3 border-l border-[var(--color-border)] pl-2 my-1">
                    {formativeUploads.length === 0 ? (
                      <div className="px-2 py-3 text-[11px] text-[var(--color-muted)] leading-relaxed">QR 형성평가를 푼 뒤<br />결과 화면에서 문항을 저장해 보세요.</div>
                    ) : formativeUploads.map((upload) => {
                      const isActive = active?.kind === 'upload' && active.uploadId === upload.id;
                      return <button key={upload.id} onClick={() => continueUpload(upload)} className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${isActive ? 'bg-sage-700 text-white shadow-[0_4px_12px_-4px_rgba(31,92,67,0.55)]' : 'text-sage-800 hover:bg-[var(--color-sage-100)]'}`}><FileText className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} /><span className="flex-1 truncate" style={folderLabelStyle}>{upload.file_name}</span></button>;
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--color-border)] my-1.5" />

              {/* 국시 오답 기반 유사문항은 데이터만 유지하고 사용자 화면에서는 숨긴다. */}
              <div className="hidden">
                <button
                  onClick={() => toggle('folder_national')}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[var(--color-sage-100)] text-left transition-colors"
                >
                  <span
                    className="ll-chip"
                    style={{
                      width: '2rem',
                      height: '2rem',
                      borderRadius: '10px',
                      background: 'var(--color-sage-100)',
                      color: 'var(--color-sage-700)',
                    }}
                  >
                    {rootNationalSimilarOpen ? (
                      <FolderOpen className="w-4 h-4" strokeWidth={2} />
                    ) : (
                      <Folder className="w-4 h-4" strokeWidth={2} />
                    )}
                  </span>
                  <span className="text-sage-800 flex-1" style={folderLabelStyle}>국시대비</span>
                  {rootNationalSimilarOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--color-muted)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--color-muted)]" />
                  )}
                </button>

                {rootNationalSimilarOpen && (
                  <div className="ml-3 border-l border-[var(--color-border)] pl-2 my-1">
                    {nationalSimilarUploads.length === 0 ? (
                      <div className="px-2 py-3">
                        <p className="text-[11px] text-[var(--color-muted)] leading-relaxed mb-2">
                          오답 기반 유사문항이 없습니다.
                          <br />
                          오답노트에서 유사문항을 만들어 보세요.
                        </p>
                        <Link href="/wrong-notes" className="text-[11px] font-semibold underline text-sage-700">
                          오답노트 바로가기 →
                        </Link>
                      </div>
                    ) : (
                      nationalSimilarUploads.map((upload) => {
                        const isActive = active?.kind === 'upload' && active.uploadId === upload.id;
                        return (
                          <button
                            key={upload.id}
                            onClick={() => continueUpload(upload)}
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                              isActive
                                ? 'bg-sage-700 text-white shadow-[0_4px_12px_-4px_rgba(31,92,67,0.55)]'
                                : 'text-sage-800 hover:bg-[var(--color-sage-100)]'
                            }`}
                          >
                            <FileText className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} />
                            <span className="flex-1 truncate" style={folderLabelStyle}>{upload.file_name}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>

        {/* ─── 우측: 콘텐츠 패널 ─────────────────────────────────────────── */}
        {/* min-w-0 — 이 섹션은 .layout 그리드의 아이템이라 기본 min-width:auto 를 가진다.
            그대로 두면 풀이 헤더의 최소폭이 그리드 트랙을 밀어 카드가 화면 밖(386px 기준 +35px)으로
            빠져나간다. 0 으로 낮춰야 폭 부족이 제목 truncate 로 흡수된다. */}
        {/* scroll-mt-20 — 셸 헤더가 position:fixed(60px)라 scrollToSolveArea 가 이 섹션을 y=0 에
            붙이면 목록 툴바가 헤더 뒤로 숨는다. 85px 로 내려 잡는다. */}
        <section id="library-solve" className="main-list min-w-0 scroll-mt-20">
          {active ? (
            <div>
              <button
                onClick={closeActive}
                className="inline-flex items-center gap-1 text-[13px] text-[var(--color-muted)] hover:text-sage-800 transition-colors mb-4"
              >
                <ArrowLeft className="w-4 h-4" /> 문제집 목록
              </button>
              {active.kind === 'subTopic' ? (
                <NationalContent
                  active={active}
                  questions={publicQuestions}
                  loading={loadingRight}
                />
              ) : (
                <PrivateExamSession
                  key={`${active.uploadId}-${solveReset ? 'reset' : 'resume'}`}
                  active={active}
                  questions={privateQuestions}
                  onAnswered={() => loadProgress(false)}
                  priorAttempts={solveReset ? undefined : attemptsByQuestion}
                  resumeFromQuestionId={solveReset ? undefined : resumeFromQuestionId}
                  progressLoaded={progressLoaded}
                  loading={loadingRight}
                  loadError={privateQuestionsError}
                  progressError={solveReset ? null : progressError}
                  onRetryQuestions={() => setPrivateQuestionsReloadKey((value) => value + 1)}
                  onRetryProgress={() => loadProgress(true)}
                />
              )}
            </div>
          ) : (
            <div>
              {/* 툴바 */}
              <div className="list-head">
                <h2 className="list-title">
                  {currentFilterLabel}
                  <span className="ml-2 text-[13px] font-semibold text-[var(--color-muted)] tabular-nums">
                    {visibleSets.length}
                  </span>
                </h2>
                <label className="search">
                  <Search className="icon" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="문제집 이름 검색"
                  />
                </label>
              </div>

              {loadingTree ? (
                <Card className="py-16 text-center text-[var(--color-muted)]">불러오는 중...</Card>
              ) : libraryUploads.length === 0 ? (
                <Card className="py-16 text-center flex flex-col items-center">
                  <span
                    className="ll-chip mb-4"
                    style={{
                      width: '3rem',
                      height: '3rem',
                      borderRadius: '15px',
                      background: 'var(--color-private-bg)',
                      color: 'var(--color-private)',
                    }}
                  >
                    <Upload className="w-6 h-6" strokeWidth={1.7} />
                  </span>
                  <div className="text-lg font-bold text-sage-800 mb-1">생성한 문제집이 없습니다</div>
                  <div className="text-sm text-[var(--color-muted)] max-w-sm mb-5">
                    강의자료를 올려 내 시험 범위에 맞는 문제집을 만들어 보세요.
                  </div>
                  <Link href="/notes">
                    <Button variant="accent" size="md">강의자료 올리기 →</Button>
                  </Link>
                </Card>
              ) : visibleSets.length === 0 ? (
                <Card className="py-16 text-center text-[var(--color-muted)]">
                  조건에 맞는 문제집이 없습니다.
                </Card>
              ) : (
                // 페이저는 CPX 세부 채점(#191)이 쓰는 공용 컴포넌트를 그대로 재사용한다.
                // key — 필터·검색이 바뀌면 목록 자체가 달라지므로 1쪽으로 되돌린다(쪽 상태는 컴포넌트가 들고 있다).
                <CpxPagedList
                  key={`${statusFilter}|${query}`}
                  items={visibleSets}
                  pageSize={SETS_PER_PAGE}
                  unitLabel="개 문제집"
                >
                  {(pageSets: typeof visibleSets) => (
                    <div className="books">
                      {pageSets.map((item) => (
                        <SetCard key={item.upload.id} item={item} onOpen={continueUpload} onDelete={handleDeleteSet} />
                      ))}
                    </div>
                  )}
                </CpxPagedList>
              )}

              <p className="mt-5 text-[12px] text-[var(--color-muted)] leading-relaxed">
                내신대비에서 만든 문제집, 저장한 형성평가, 오답노트에서 생성한 유사문제를 함께 표시해요.
              </p>
            </div>
          )}
        </section>
      </div>

      {deleteTarget && (
        <DeleteSetDialog
          fileName={deleteTarget.name}
          loading={deletingSet}
          error={deleteError}
          onCancel={() => {
            if (deletingSet) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={confirmDeleteSet}
        />
      )}

      {deleteNotice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 left-1/2 z-[130] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-3 text-sm font-semibold text-sage-900 shadow-[0_12px_32px_rgba(17,38,29,0.16)]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
          {deleteNotice}
        </div>
      )}
    </div>
  );
}

// ─── 상단 통계 타일 ──────────────────────────────────────────────────────────

function StatTile({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="ll-card p-4 sm:p-5">
      <div className="text-xs text-[var(--color-muted)] mb-2">{label}</div>
      <div className="ll-stat text-[1.5rem] font-bold leading-none">
        {value}
        {unit && <span className="text-sm font-semibold text-[var(--color-muted)] ml-1">{unit}</span>}
      </div>
    </div>
  );
}

function DeleteSetDialog({
  fileName,
  loading,
  error,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cancelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [loading, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[#17251f]/45 px-4 py-8"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !loading) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-set-title"
        aria-describedby="delete-set-description"
        className="w-full max-w-[400px] rounded-2xl bg-white p-5 shadow-[0_24px_64px_rgba(17,38,29,0.24)] sm:p-6"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          if (event.shiftKey && document.activeElement === cancelRef.current) {
            event.preventDefault();
            confirmRef.current?.focus();
          } else if (!event.shiftKey && document.activeElement === confirmRef.current) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }}
      >
        <h2 id="delete-set-title" className="text-lg font-bold text-sage-900">이 문제집을 삭제할까요?</h2>
        <p className="mt-3 break-words rounded-xl bg-[var(--color-surface-muted)] px-3.5 py-3 text-sm font-semibold leading-5 text-sage-800">
          {fileName}
        </p>
        <p id="delete-set-description" className="mt-3 text-sm leading-6 text-[var(--color-muted)]">
          삭제한 문제집은 다시 복구할 수 없어요.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm leading-5 text-red-700">
            {error}
          </p>
        )}

        <div className="mt-6 grid grid-cols-2 gap-2">
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={loading} fullWidth className="order-2 min-w-0 px-3">
            취소
          </Button>
          <Button ref={confirmRef} type="button" variant="danger" onClick={onConfirm} loading={loading} fullWidth className="library-delete-danger order-1 min-w-0 px-3">
            {loading ? '삭제 중...' : '삭제하기'}
          </Button>
        </div>
      </section>
    </div>
  );
}

// ─── 문제집(업로드) 카드 ─────────────────────────────────────────────────────

function SetCard({
  item,
  onOpen,
  onDelete,
}: {
  item: SetItem;
  onOpen: (u: Upload, reset?: boolean) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const { upload, count, status, attempted, correct } = item;
  const badge = STATUS_BADGE[status];
  const sourceLabel = generatedSetLabel(upload.file_type)
    ?? (upload.file_type === 'formative/live' ? '형성평가 저장' : '내신대비 생성');
  const total = item.progressTotal || count;
  const isDone = total > 0 && attempted >= total; // 다 풀었으면 '다시풀기'
  const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : null;
  const progressPct = total > 0 ? Math.min(100, Math.round((attempted / total) * 100)) : 0;
  return (
    <article className="card book-card">
      <div className="book-top">
        <div className="source-tag">
          <Folder className="icon"/><span>{sourceLabel}</span>
          <span className="text-[11px] text-[var(--color-muted)]">{fileTypeLabel(upload.file_type)}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[11px] text-[var(--color-muted)] tabular-nums">
            {formatDate(upload.created_at)}
          </span>
          <button
            type="button"
            onClick={() => onDelete(upload.id, upload.file_name)}
            aria-label="문제집 삭제"
            aria-haspopup="dialog"
            title="문제집 삭제"
            className="trash"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      <h3 className="book-title">
        {upload.file_name}
      </h3>
      <div className="book-meta">
        <span className="text-[12px] text-[var(--color-muted)] tabular-nums">{count}문항</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {/* 진행도 · 정답률 — 실제 풀이 기록 기반 */}
      <div className="progress">
        <div className="progress-row">
          <span className="text-[var(--color-muted)]">
            진행도 <span className="tabular-nums text-sage-800">{attempted}/{total}</span>
          </span>
          <span className={accuracy === null ? 'text-[var(--color-muted)]' : 'font-semibold text-sage-800'}>
            {accuracy === null ? '기록 없음' : `정답률 ${accuracy}%`}
          </span>
        </div>
        <div className="bar">
          <div
            style={{
              width: `${progressPct}%`,
              background:
                accuracy === null
                  ? 'var(--color-sage-300)'
                  : accuracy < 50
                    ? 'var(--color-warn)'
                    : accuracy < 75
                      ? 'var(--color-accent)'
                      : 'var(--color-sage-600)',
            }}
          />
        </div>
      </div>

      <div className="actions">
        <button
          type="button"
          onClick={() => onOpen(upload, isDone)}
          className="primary"
        >
          {isDone ? '다시 풀기' : attempted > 0 ? '이어풀기' : '문제 풀기'}
        </button>
        <Link
          href="/wrong-notes"
          className="secondary"
        >
          오답복습
        </Link>
      </div>
    </article>
  );
}

// ─── 국시 세부주제 우측 패널 ─────────────────────────────────────────────────

function NationalContent({
  active,
  questions,
  loading,
}: {
  active: { kind: 'subTopic'; subTopicId: string; name: string; subjectName: string };
  questions: PublicQuestion[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <Card className="py-20 text-center text-[var(--color-muted)]">
        문항 불러오는 중...
      </Card>
    );
  }

  return (
    <div>
      {/* 상단 메타 + 이어 풀기 버튼 */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <span className="ll-eyebrow mb-3">{active.subjectName}</span>
          <h2 className="text-[1.7rem] font-bold text-sage-800 tracking-tight leading-tight">
            {active.name}
          </h2>
        </div>
      </div>

      {questions.length === 0 ? (
        <Card className="py-16 text-center flex flex-col items-center">
          <span
            className="ll-chip mb-4"
            style={{ width: '3rem', height: '3rem', borderRadius: '15px' }}
          >
            <Stethoscope className="w-6 h-6" strokeWidth={1.7} />
          </span>
          <div className="text-lg text-sage-800 font-bold mb-1">아직 문항이 없습니다</div>
          <div className="text-sm text-[var(--color-muted)] max-w-sm">
            이 세부주제에는 아직 출제 가능한 문항이 없습니다.
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {questions.map((q, i) => (
            <PublicSolveCard key={q.id} q={q} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 내 문제집 자료 우측 패널 ─────────────────────────────────────────────────

/** 내문제집 풀이도 국시대비와 같은 한 문항씩 푸는 세션 화면으로 제공한다. */
function PrivateExamSession({
  active,
  questions,
  onAnswered,
  priorAttempts,
  resumeFromQuestionId,
  progressLoaded,
  loading,
  loadError,
  progressError,
  onRetryQuestions,
  onRetryProgress,
}: {
  active: { kind: 'upload'; uploadId: string; fileName: string };
  questions: PrivateQuestion[];
  onAnswered?: () => void;
  priorAttempts?: Record<string, { selectedIndex: number; isCorrect: boolean }>;
  resumeFromQuestionId?: string | null;
  progressLoaded: boolean;
  loading: boolean;
  loadError: string | null;
  progressError: string | null;
  onRetryQuestions: () => void;
  onRetryProgress: () => void;
}) {
  // 이전 풀이 복원은 반드시 "현재 세트 문항"으로 한정한다 — priorAttempts 는 전체 문제집에 걸친
  // 풀이 기록이라, 그대로 시드하면 다른 세트 기록이 섞여 완료 판정(allAnswered)이 영영 참이 되지 않는다.
  const [answers, setAnswers] = useState<Record<string, { selected: number; correct: boolean }>>(() => {
    const questionIds = new Set(questions.map((question) => question.id));
    return Object.fromEntries(
      Object.entries(priorAttempts ?? {})
        .filter(([questionId, answer]) => questionIds.has(questionId) && answer.selectedIndex >= 0)
        .map(([questionId, answer]) => [questionId, { selected: answer.selectedIndex, correct: answer.isCorrect }]),
    );
  });
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [index, setIndex] = useState(0);
  const [showQuestionGrid, setShowQuestionGrid] = useState(false);
  const [finished, setFinished] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 문항 목록이 뒤늦게 도착·보강되는 경우(세트 전체 fetch)에도 그 문항들의 이전 풀이를 복원한다.
  useEffect(() => {
    if (!priorAttempts) return;
    setAnswers((previous) => {
      let added = false;
      const next = { ...previous };
      for (const question of questions) {
        const prior = priorAttempts[question.id];
        if (!next[question.id] && prior && prior.selectedIndex >= 0) {
          next[question.id] = { selected: prior.selectedIndex, correct: prior.isCorrect };
          added = true;
        }
      }
      return added ? next : previous;
    });
  }, [questions, priorAttempts]);

  // 이어풀기 위치 복원은 세션을 여는 시점의 일 — 채점 후 진행도 재조회가 priorAttempts·
  // resumeFromQuestionId 를 갱신해도, 풀이를 시작한 사용자를 보던 문항(해설)에서 이탈시키지 않는다.
  const interactedRef = useRef(false);
  const didResolveInitialPosition = useRef(false);
  useEffect(() => {
    if (interactedRef.current || didResolveInitialPosition.current) return;
    if (!progressLoaded || questions.length === 0) return;
    const resumeQuestionId = findNextUnansweredQuestionId(
      questions.map((question) => question.id),
      Object.keys(priorAttempts ?? {}),
      resumeFromQuestionId,
    );
    const resumeIndex = questions.findIndex((question) => question.id === resumeQuestionId);
    setIndex(resumeIndex >= 0 ? resumeIndex : 0);
    didResolveInitialPosition.current = true;
  }, [priorAttempts, progressLoaded, questions, resumeFromQuestionId]);

  if (loading || !progressLoaded) {
    return <Card className="py-16 text-center text-[var(--color-muted)]">문제집 진행도를 불러오는 중입니다...</Card>;
  }

  if (loadError || progressError) {
    const message = loadError ?? progressError;
    return (
      <Card className="py-12 text-center flex flex-col items-center gap-4">
        <p role="alert" className="text-sm text-[var(--color-warn)]">{message}</p>
        <Button variant="secondary" onClick={loadError ? onRetryQuestions : onRetryProgress}>다시 시도</Button>
      </Card>
    );
  }

  if (questions.length === 0) {
    return (
      <Card className="py-16 text-center flex flex-col items-center">
        <FileText className="w-7 h-7 mb-3 text-sage-600" />
        <div className="text-lg font-bold text-sage-800 mb-1">문항이 없습니다</div>
        <div className="text-sm text-[var(--color-muted)]">이 문제집에서 생성된 문항이 아직 없습니다.</div>
      </Card>
    );
  }

  const current = questions[index];
  const submitted = answers[current.id];
  const selected = submitted?.selected ?? selections[current.id] ?? null;
  const completedQuestionIds = new Set(Object.keys(answers));
  const allAnswered = questions.every((question) => answers[question.id]);

  function goToQuestion(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= questions.length) return;
    interactedRef.current = true;
    setIndex(nextIndex);
    setShowQuestionGrid(false);
  }

  function scrollToSolveArea() {
    window.requestAnimationFrame(() => {
      document.getElementById('library-solve')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showResult() {
    setFinished(true);
    scrollToSolveArea();
  }

  function selectChoice(choiceIndex: number) {
    if (submitted) return;
    interactedRef.current = true;
    setSelections((previous) => ({ ...previous, [current.id]: choiceIndex }));
  }

  async function submitCurrent() {
    if (selected === null || submitted || submitting) return;
    interactedRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const correct = selected === current.answer_index;
    try {
      await api.post('/api/attempts', { question_id: current.id, selected_index: selected, track: 'lecture_note' });
      setAnswers((previous) => ({ ...previous, [current.id]: { selected, correct } }));
      onAnswered?.();
    } catch {
      setSubmitError('답안을 저장하지 못했어요. 다시 시도해주세요.');
    } finally {
      setSubmitting(false);
    }
  }

  if (finished) {
    return (
      <PrivateExamResult
        fileName={active.fileName}
        questions={questions}
        answers={answers}
        onBack={() => {
          setFinished(false);
          scrollToSolveArea();
        }}
      />
    );
  }

  return (
    <div>
      <div className="ll-card p-5 mb-4">
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="ll-chip shrink-0" style={{ width: '2.25rem', height: '2.25rem' }}>
              <BookOpen className="w-4 h-4" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-sage-600">내 문제집</div>
              <div className="text-[15px] font-bold text-sage-800 tracking-tight truncate">{active.fileName}</div>
            </div>
          </div>
          {/* shrink-0 — 좁은 폭(모바일)에서 이 조작부가 눌리면 "문항 10/10" 이 문/항 으로 쪼개진다.
              줄어드는 쪽은 왼쪽 제목(min-w-0 + truncate)이어야 한다. */}
          <div className="relative flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => goToQuestion(index - 1)} disabled={index === 0} aria-label="이전 문항" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-white text-sage-700 transition-colors hover:border-sage-400 disabled:cursor-not-allowed disabled:opacity-35">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="relative">
              <button type="button" onClick={() => setShowQuestionGrid((open) => !open)} aria-expanded={showQuestionGrid} className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-white px-2.5 text-sm font-semibold text-sage-800 transition-colors hover:border-sage-400">
                문항 <span className="tnum">{index + 1}/{questions.length}</span>
                <ChevronDown className={`h-3.5 w-3.5 text-[var(--color-muted)] transition-transform ${showQuestionGrid ? 'rotate-180' : ''}`} />
              </button>
              {showQuestionGrid && (
                <div className="absolute right-0 top-10 z-30 w-56 rounded-xl border border-[var(--color-border)] bg-white p-2.5 shadow-[0_16px_36px_rgba(31,46,40,0.16)]">
                  <div className="mb-2 flex items-center justify-between text-[11px]"><span className="font-bold text-sage-800">문항 선택</span><span className="inline-flex items-center gap-1.5 text-[var(--color-muted)]"><i className="h-2 w-2 rounded-full bg-sage-200" />풀이 완료</span></div>
                  <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
                    {questions.map((question, questionIndex) => {
                      const isCurrent = questionIndex === index;
                      const isCompleted = completedQuestionIds.has(question.id);
                      return <button key={question.id} type="button" onClick={() => goToQuestion(questionIndex)} className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold transition-colors ${isCurrent ? 'border-sage-700 bg-sage-700 text-white' : isCompleted ? 'border-sage-200 bg-[var(--color-sage-100)] text-sage-700 hover:border-sage-400' : 'border-[var(--color-border)] bg-white text-sage-700 hover:border-sage-400'}`}>
                        {questionIndex + 1}
                      </button>;
                    })}
                  </div>
                </div>
              )}
            </div>
            <button type="button" onClick={() => goToQuestion(index + 1)} disabled={index === questions.length - 1} aria-label="다음 문항" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-white text-sage-700 transition-colors hover:border-sage-400 disabled:cursor-not-allowed disabled:opacity-35">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="w-full h-2 bg-[var(--color-sage-200)] rounded-full overflow-hidden"><div className="h-full bg-sage-700 rounded-full transition-all" style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div>
      </div>

      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <div className="flex gap-2 flex-wrap"><Badge>문제집 문항</Badge><Badge variant="warn">난이도 {'★'.repeat(current.difficulty)}</Badge></div>
          <Badge variant="curated">내신 대비</Badge>
        </div>
        <div className="flex gap-1.5 text-[17px] leading-8 text-sage-800 mb-6">
          <strong className="text-sage-700 shrink-0">{index + 1}.</strong>
          <QuestionStem className="flex-1" text={withImageLabels(current.stem)} />
        </div>
        {current.images && current.images.length > 0 && <div className="mb-4 space-y-2">{current.images.map((image, imageIndex) => <img key={imageIndex} src={image.url} alt={image.caption ?? `문항 이미지 ${imageIndex + 1}`} className="w-full max-h-80 object-contain rounded-xl border border-[var(--color-border)] bg-white" />)}</div>}
        <div className="space-y-2">
          {current.choices.map((choice, choiceIndex) => {
            const isCorrect = submitted && choiceIndex === current.answer_index;
            const isWrong = submitted && choiceIndex === selected && !submitted.correct;
            const isSelected = !submitted && choiceIndex === selected;
            return <button key={choiceIndex} type="button" disabled={!!submitted || submitting} onClick={() => selectChoice(choiceIndex)} className={`w-full text-left p-3.5 px-4 rounded-xl border flex items-center gap-3 transition-all ${isCorrect ? 'bg-[var(--color-curated-bg)] border-sage-600' : isWrong ? 'bg-[var(--color-warn-bg)] border-[var(--color-warn)]' : isSelected ? 'bg-[var(--color-sage-100)] border-sage-600' : 'bg-white border-[var(--color-border)] hover:border-sage-400 hover:bg-[var(--color-sage-50)]'}`}>
              <span className={`w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold flex-shrink-0 ${isCorrect || isSelected ? 'bg-sage-700 text-white border-sage-700' : isWrong ? 'bg-[var(--color-warn)] text-white border-[var(--color-warn)]' : 'border-[var(--color-sage-400)] text-[var(--color-muted)]'}`}>{choiceIndex + 1}</span>
              <span className="text-[15px] text-sage-800 flex-1">{choice}</span>
              {isCorrect && <CheckCircle2 className="w-5 h-5 text-sage-700 flex-shrink-0" />}{isWrong && <XCircle className="w-5 h-5 text-[var(--color-warn)] flex-shrink-0" />}
            </button>;
          })}
        </div>
        {submitted && current.explanation && <div className="mt-5 ll-tint rounded-2xl p-5 border border-[var(--color-border)]"><span className="ll-eyebrow mb-3">해설</span><div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">{current.explanation}</div></div>}
      </Card>

      {submitError && <p role="alert" className="mb-3 text-right text-sm text-[var(--color-warn)]">{submitError}</p>}
      <div className="flex justify-end gap-2 mb-5">
        {!submitted ? (
          <Button variant="accent" onClick={submitCurrent} disabled={selected === null} loading={submitting}>제출하고 채점</Button>
        ) : (
          <>
            {index < questions.length - 1 && (
              <Button variant={allAnswered ? 'secondary' : 'primary'} onClick={() => goToQuestion(index + 1)}>다음 문항 <ChevronRight className="w-4 h-4" /></Button>
            )}
            {(allAnswered || index === questions.length - 1) && (
              <Button variant="accent" onClick={showResult}>결과 보기</Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 결과 화면 — 국시 대비 모의고사 결과(ExamResultView)와 같은 디자인: 오답을 카드(발문+보기+해설)로
 *  제시하고 카드 우상단의 체크 버튼으로 오답노트에 담는다(.ll-exam-result-page 스코프 CSS 재사용). */
function PrivateExamResult({
  fileName,
  questions,
  answers,
  onBack,
}: {
  fileName: string;
  questions: PrivateQuestion[];
  answers: Record<string, { selected: number; correct: boolean }>;
  onBack: () => void;
}) {
  const wrongList = questions.filter((q) => answers[q.id] && !answers[q.id].correct);
  const correctCount = questions.filter((q) => answers[q.id]?.correct).length;
  const unansweredCount = questions.filter((q) => !answers[q.id]).length;
  const pct = questions.length > 0 ? Math.round((correctCount / questions.length) * 100) : 0;
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  const unsavedWrong = wrongList.filter((q) => !saved.has(q.id));

  function postWrongAnswer(q: PrivateQuestion) {
    return api.post('/api/wrong-answers', {
      private_question_id: q.id,
      sub_topic_id: q.sub_topic_id ?? null,
      selected_index: answers[q.id]?.selected ?? null,
      source: 'lecture_note',
    });
  }

  async function saveOne(q: PrivateQuestion) {
    if (saved.has(q.id) || savingIds.has(q.id)) return;
    setSavingIds((previous) => new Set(previous).add(q.id));
    try {
      await postWrongAnswer(q);
      setSaved((previous) => new Set(previous).add(q.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : '오답노트 저장에 실패했습니다.');
    } finally {
      setSavingIds((previous) => {
        const next = new Set(previous);
        next.delete(q.id);
        return next;
      });
    }
  }

  async function saveAllUnsaved() {
    if (unsavedWrong.length === 0 || bulkSaving) return;
    setBulkSaving(true);
    try {
      const results = await Promise.allSettled(unsavedWrong.map((q) => postWrongAnswer(q)));
      const succeeded = unsavedWrong.filter((_, i) => results[i].status === 'fulfilled');
      if (succeeded.length > 0) {
        setSaved((previous) => {
          const next = new Set(previous);
          for (const q of succeeded) next.add(q.id);
          return next;
        });
      }
      if (succeeded.length < unsavedWrong.length) alert('일부 오답을 담지 못했습니다. 다시 시도해주세요.');
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <div className="ll-exam-result-page">
      <div className="ll-card p-5 mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem' }}>
            <BookOpen className="w-4 h-4" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-sage-600">내 문제집 · 결과</div>
            <div className="text-[15px] font-bold text-sage-800 tracking-tight truncate">{fileName}</div>
          </div>
        </div>
      </div>

      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-lg font-bold text-sage-800">전체 채점 결과</div>
          <Badge variant={pct >= 60 ? 'curated' : 'warn'}>정답률 {pct}%</Badge>
        </div>
        <p className="mt-3 text-sm text-sage-800">
          총 {questions.length}문항 중 <b>{correctCount}문항</b> 정답 · <b>{wrongList.length}문항</b> 오답
          {unansweredCount > 0 && <> · <b>{unansweredCount}문항</b> 미풀이</>}
        </p>
      </Card>

      <Card className="mb-4">
        <div className="panel-head mb-4">
          <h2 className="panel-title">
            <span className="title-line">
              오답 확인{' '}
              <span className="help-wrap">
                <button className="help-button" type="button" aria-label="오답노트 설명">?</button>
                <span className="help-pop">오답 문제 중 담은 문제는 오답노트 탭에서 다시 풀어볼 수 있습니다.</span>
              </span>
            </span>
          </h2>
        </div>

        {wrongList.length === 0 ? (
          <div className="explain">
            <strong>모든 문항을 맞혔습니다.</strong>
            <p>현재 학습 흐름을 이어가세요.</p>
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {wrongList.map((q, wrongIndex) => {
                const answer = answers[q.id];
                const isSaved = saved.has(q.id);
                return (
                  <div className="wrong-card" key={q.id}>
                    <div className="wrong-top">
                      <div className="wrong-index">오답 {wrongIndex + 1}</div>
                      <label className="save-check">
                        <input type="checkbox" checked={isSaved} readOnly />
                        <button
                          type="button"
                          className="save-surface"
                          disabled={isSaved || savingIds.has(q.id)}
                          onClick={() => saveOne(q)}
                        >
                          <span className="save-icon"><BookmarkPlus className="w-4 h-4" /></span>
                          <span className="save-text"><strong>{isSaved ? '오답노트 담음' : '오답노트 담기'}</strong></span>
                        </button>
                      </label>
                    </div>
                    <QuestionStem className="question" text={withImageLabels(q.stem)} />
                    {q.images && q.images.length > 0 && (
                      <div className="mt-4 space-y-2">
                        {q.images.map((image, imageIndex) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={imageIndex} src={image.url} alt={image.caption ?? `문항 이미지 ${imageIndex + 1}`} className="w-full max-h-80 object-contain rounded-xl border border-[var(--color-border)] bg-white" />
                        ))}
                      </div>
                    )}
                    <div className="answer-grid">
                      {q.choices.map((choice, choiceIndex) => {
                        const isCorrect = choiceIndex === q.answer_index;
                        const isMine = choiceIndex === answer.selected && !isCorrect;
                        return (
                          <div className={`answer ${isCorrect ? 'correct' : ''} ${isMine ? 'wrong' : ''}`} key={choiceIndex}>
                            <span className="num">{choiceIndex + 1}</span>
                            <span>{choice}</span>
                            <span className="answer-label">{isCorrect ? '정답' : isMine ? '내 선택' : ''}</span>
                          </div>
                        );
                      })}
                    </div>
                    {q.explanation && (
                      <div className="explain">
                        <strong>해설</strong>
                        <p>{q.explanation}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {unsavedWrong.length > 0 && (
              <div className="action-dock">
                <button className="primary-wide" type="button" disabled={bulkSaving} onClick={saveAllUnsaved}>
                  <BookmarkPlus className="w-4 h-4" />
                  {bulkSaving ? '담는 중...' : '선택한 오답 담기'}
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="flex justify-end">
        <Button variant="secondary" onClick={onBack}><ArrowLeft className="w-4 h-4" /> 문항 다시 보기</Button>
      </div>
    </div>
  );
}

/** 국시(공개) 문항 — 라이브러리에서 바로 풀이. 정답/해설은 서버(/api/attempts)가 채점해 반환. */
function PublicSolveCard({ q, index }: { q: PublicQuestion; index: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<{ correctIndex: number; isCorrect: boolean; explanation: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const answered = result !== null;

  async function handleSelect(ci: number) {
    if (answered || loading) return;
    setSelected(ci);
    setLoading(true);
    try {
      const res = await api.post<{ is_correct: boolean; correct_index: number; explanation: string | null }>(
        '/api/attempts',
        { question_id: q.id, selected_index: ci, track: 'smart_practice' },
      );
      setResult({ correctIndex: res.correct_index, isCorrect: res.is_correct, explanation: res.explanation });
    } catch (e) {
      setSelected(null);
      alert(e instanceof ApiError ? e.message : '채점에 실패했습니다. 다시 시도해주세요.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex gap-1.5 flex-wrap">
          <Badge>{q.subTopicName}</Badge>
          <Badge variant={q.badge.color}>{q.badge.label}</Badge>
          <Badge variant="warn">난이도 {'★'.repeat(q.difficulty)}</Badge>
        </div>
        <span className="text-xs font-semibold text-[var(--color-muted)] tabular-nums flex-shrink-0">#{index + 1}</span>
      </div>

      {q.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={q.imageUrl} alt="문항 이미지" className="w-full max-h-72 object-contain rounded-xl border border-[var(--color-border)] bg-white mb-4" />
      )}

      <QuestionStem className="text-[15px] leading-7 text-sage-800 font-medium mb-4" text={withImageLabels(q.stem)} />

      <div className="space-y-2">
        {q.choices.map((choice, ci) => {
          const isCorrect = answered && ci === result!.correctIndex;
          const isSel = ci === selected;
          let cls = 'border-[var(--color-border)] bg-white';
          if (!answered && !loading) cls += ' hover:border-sage-300 hover:bg-sage-50 cursor-pointer';
          else if (isCorrect) cls = 'border-[var(--color-curated)] bg-[var(--color-curated-bg)]';
          else if (isSel) cls = 'border-[var(--color-warn)] bg-[var(--color-warn-bg)]';
          return (
            <button
              key={ci}
              type="button"
              disabled={answered || loading}
              onClick={() => handleSelect(ci)}
              className={`w-full text-left flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors disabled:cursor-default ${cls}`}
            >
              <span className="w-6 h-6 rounded-lg border border-[var(--color-border)] bg-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5 text-sage-700">
                {ci + 1}
              </span>
              <span className="text-sm text-sage-800 leading-6 flex-1">{choice}</span>
              {isCorrect && <span className="text-[var(--color-curated)] font-bold flex-shrink-0" aria-label="정답">✓</span>}
              {answered && isSel && !isCorrect && <span className="text-[var(--color-warn)] font-bold flex-shrink-0" aria-label="오답">✗</span>}
            </button>
          );
        })}
      </div>

      {loading && !answered && (
        <div className="mt-3 text-[13px] text-[var(--color-muted)]">채점 중…</div>
      )}

      {answered && (
        <div className="mt-4 rounded-2xl bg-[var(--color-sage-100)] p-4">
          <div className="text-sm font-bold mb-1.5" style={{ color: result!.isCorrect ? 'var(--color-curated)' : 'var(--color-warn)' }}>
            {result!.isCorrect ? '✓ 정답입니다' : `✗ 오답 — 정답: ${result!.correctIndex + 1}번`}
          </div>
          {result!.explanation && (
            <div className="text-sm text-sage-800 leading-relaxed">{result!.explanation}</div>
          )}
        </div>
      )}
    </Card>
  );
}
