'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  Heart, Wind, Utensils, Droplet, Droplets, Bug, Activity, Flower2,
  Ribbon, Bone, Scissors, Baby, Brain, Ear, Eye, Fingerprint, Shield, Scale,
  Stethoscope, ChevronDown, ChevronRight, AlertTriangle, FileText,
  FolderOpen, Folder, Upload, BookOpen, Search, ArrowLeft, Trash2, type LucideIcon,
} from 'lucide-react';

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
type SetStatus = 'inprogress' | 'review' | 'done';

interface UploadProgress {
  total: number;
  attempted: number;
  correct: number;
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
  { key: 'review', label: '오답 복습 필요' },
  { key: 'done', label: '완료' },
];

const STATUS_BADGE: Record<SetStatus, { label: string; variant: 'default' | 'warn' | 'curated' }> = {
  inprogress: { label: '풀이 중', variant: 'default' },
  review: { label: '오답 복습 필요', variant: 'warn' },
  done: { label: '완료', variant: 'curated' },
};

/** 문항 난이도 구성으로 문제집 상태를 파생(풀이 기록이 아직 없을 때의 근사치). */
function deriveStatus(qs: PrivateQuestion[]): SetStatus {
  if (qs.some((q) => q.difficulty === 3)) return 'review';
  if (qs.length > 0 && qs.every((q) => q.difficulty === 1)) return 'done';
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
  if (correct < attempted) return 'review';
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
  // 폴더 트리 데이터
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);

  // 각 노드별 독립 expand 상태
  // 최상위 키: 'root_national' | 'root_private'
  // 과목 키: 'subject_<id>'
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 과목별 세부주제 count 캐시 { subTopicId -> count }
  const [subTopicCounts, setSubTopicCounts] = useState<Record<string, number>>({});
  const [loadingCounts, setLoadingCounts] = useState<Record<string, boolean>>({});

  // 선택된 항목 및 우측 콘텐츠
  const [active, setActive] = useState<ActiveItem | null>(null);
  const [publicQuestions, setPublicQuestions] = useState<PublicQuestion[]>([]);
  const [privateQuestions, setPrivateQuestions] = useState<PrivateQuestion[]>([]);
  const [allPrivateQuestions, setAllPrivateQuestions] = useState<PrivateQuestion[]>([]);
  const [loadingRight, setLoadingRight] = useState(false);

  // 세트별 진행도/정답률 (업로드 id → {total, attempted, correct})
  const [progressByUpload, setProgressByUpload] = useState<Record<string, UploadProgress>>({});
  const [overallProgress, setOverallProgress] = useState<{ attempted: number; correct: number } | null>(null);
  // 문항별 최신 풀이(이어풀기 시 이전 답 복원용) — private_question_id → {selectedIndex, isCorrect}
  const [attemptsByQuestion, setAttemptsByQuestion] = useState<Record<string, { selectedIndex: number; isCorrect: boolean }>>({});
  // 다시풀기(완료 세트) 로 열었는지 — true 면 이전 답 복원 없이 빈 상태로.
  const [solveReset, setSolveReset] = useState(false);

  // 학습 상태 필터 · 검색어 (우측 문제집 그리드용)
  const [statusFilter, setStatusFilter] = useState<SetStatus | 'all'>('all');
  const [query, setQuery] = useState('');

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
  }, []);

  // private-questions 를 한 번만 전체 로드해 upload_id 기준으로 필터링
  useEffect(() => {
    api
      .get<unknown>('/api/private-questions?limit=50')
      .then((res) => {
        const arr: PrivateQuestion[] = Array.isArray(res)
          ? (res as PrivateQuestion[])
          : ((res as { items?: PrivateQuestion[] }).items ?? []);
        setAllPrivateQuestions(arr);
      })
      .catch(() => {});
  }, []);

  // 세트별 진행도/정답률 로드 (마운트 + 풀이 후 갱신)
  const loadProgress = useCallback(() => {
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
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadProgress();
  }, [loadProgress]);

  // ── 토글 ──────────────────────────────────────────────────────────────────

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  // ── 과목 펼칠 때 count lazy 로드 ──────────────────────────────────────────

  const loadCountsForLeaves = useCallback(
    (leaves: SubTopic[]) => {
      const needsFetch = leaves.filter(
        (st) => subTopicCounts[st.id] === undefined && !loadingCounts[st.id],
      );
      if (needsFetch.length === 0) return;

      setLoadingCounts((prev) => {
        const next = { ...prev };
        needsFetch.forEach((st) => { next[st.id] = true; });
        return next;
      });

      Promise.all(
        needsFetch.map(async (st) => {
          try {
            const res = await api.get<{ count: number }>(
              `/api/questions?sub_topic_id=${st.id}&count_only=true`,
            );
            return { id: st.id, count: res.count };
          } catch {
            return { id: st.id, count: 0 };
          }
        }),
      ).then((results) => {
        setSubTopicCounts((prev) => {
          const next = { ...prev };
          results.forEach(({ id, count }) => { next[id] = count; });
          return next;
        });
        setLoadingCounts((prev) => {
          const next = { ...prev };
          needsFetch.forEach((st) => { next[st.id] = false; });
          return next;
        });
      });
    },
    [subTopicCounts, loadingCounts],
  );

  const midsOf = (s: Subject) => s.sub_topics.filter((t) => t.level === 1);
  const leavesOf = (s: Subject, midId: string) =>
    s.sub_topics.filter((t) => t.level === 2 && t.parent_id === midId);

  function toggleSubject(subject: Subject) {
    toggle(`subject_${subject.id}`);
  }

  function toggleMid(mid: SubTopic, subject: Subject) {
    const key = `mid_${mid.id}`;
    const willOpen = !expanded[key];
    toggle(key);
    if (willOpen) loadCountsForLeaves(leavesOf(subject, mid.id));
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

  function openUpload(upload: Upload, reset = false) {
    setActive({ kind: 'upload', uploadId: upload.id, fileName: upload.file_name });
    setLoadingRight(false);
    setPublicQuestions([]);
    setSolveReset(reset); // 다시풀기 = 이전 답 복원 없이 빈 상태로 시작
    const filtered = allPrivateQuestions.filter((q) => q.upload_id === upload.id);
    setPrivateQuestions(filtered);
  }

  function selectFilter(key: SetStatus | 'all') {
    setStatusFilter(key);
    setActive(null);
  }

  async function handleDeleteSet(uploadId: string, fileName: string) {
    if (!confirm(`"${fileName}" 문제집을 삭제할까요?\n이 자료로 생성된 문항이 모두 함께 삭제됩니다.`)) return;
    try {
      await api.delete(`/api/uploads/${uploadId}`);
      setUploads((prev) => prev.filter((u) => u.id !== uploadId));
      setAllPrivateQuestions((prev) => prev.filter((q) => q.upload_id !== uploadId));
      if (active?.kind === 'upload' && active.uploadId === uploadId) setActive(null);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '삭제에 실패했습니다.');
    }
  }

  // ── 파생 데이터 (문제집 그리드 · 통계) ────────────────────────────────────

  const setItems: SetItem[] = uploads.map((u) => {
    const qs = allPrivateQuestions.filter((q) => q.upload_id === u.id);
    const p = progressByUpload[u.id];
    const total = p?.total ?? qs.length;
    const attempted = p?.attempted ?? 0;
    const correct = p?.correct ?? 0;
    const status = attempted > 0 ? realStatus(total, attempted, correct) : deriveStatus(qs);
    return { upload: u, count: qs.length, status, attempted, correct, progressTotal: total };
  });

  const overallAccuracy =
    overallProgress && overallProgress.attempted > 0
      ? Math.round((overallProgress.correct / overallProgress.attempted) * 100)
      : null;

  const statusCounts: Record<SetStatus | 'all', number> = {
    all: setItems.length,
    inprogress: setItems.filter((s) => s.status === 'inprogress').length,
    review: setItems.filter((s) => s.status === 'review').length,
    done: setItems.filter((s) => s.status === 'done').length,
  };

  const q = query.trim().toLowerCase();
  const visibleSets = setItems.filter(
    (s) =>
      (statusFilter === 'all' || s.status === statusFilter) &&
      (q === '' || s.upload.file_name.toLowerCase().includes(q)),
  );
  const nextSet = setItems.find((item) => item.status === 'inprogress') ?? setItems[0] ?? null;

  const currentFilterLabel =
    STATUS_FILTERS.find((f) => f.key === statusFilter)?.label ?? '전체 문제집';

  // ─── Render ───────────────────────────────────────────────────────────────

  const rootNationalOpen = expanded['root_national'] ?? false;
  const rootPrivateOpen = expanded['root_private'] ?? false;

  return (
    <div className="ll-library-page content">
      <section className="page-head"><div><span className="eyebrow">문제집 보관함</span><h1><span className="headline-accent">내 문제집</span>을<br/>한곳에서 이어갑니다</h1><p className="lead">가장 최근에 풀던 문제집을 먼저 이어가고, 필요할 때 폴더와 검색으로 원하는 문제집을 찾으세요.</p></div></section>

      {nextSet && (
        <div className="focus-band"><section className="next-action" aria-label="이어풀기 추천">
          <div>
            <h2 className="next-title">{nextSet.upload.file_name}</h2>
            <p className="next-copy">마지막으로 학습하던 문제집입니다. 여기서 바로 이어가면 가장 빠르게 학습을 재개할 수 있어요.</p>
          </div>
          <div className="next-panel">
            <div className="next-panel-row"><span>진행도</span><strong>{nextSet.attempted}/{nextSet.progressTotal || nextSet.count}</strong></div>
            <div className="bar"><span style={{ width: `${Math.min(100, Math.round((nextSet.attempted / Math.max(1, nextSet.progressTotal || nextSet.count)) * 100))}%` }} /></div>
            <div className="next-panel-row"><span>최근 정답률</span><strong>{nextSet.attempted ? Math.round((nextSet.correct / nextSet.attempted) * 100) : 0}%</strong></div>
            <button className="hero-cta" type="button" onClick={() => openUpload(nextSet.upload)}>이어풀기</button>
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
              <div>
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
                                              ? toggleMid(mid, subject)
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
                                              const count = subTopicCounts[leaf.id];
                                              const counting = loadingCounts[leaf.id];
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
              <div className="border-t border-[var(--color-border)] my-1.5" />

              {/* ── 최상위: 내 문제집 ── */}
              <div>
                <button
                  onClick={() => toggle('root_private')}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[var(--color-private-bg)] text-left transition-colors"
                >
                  <span
                    className="ll-chip"
                    style={{
                      width: '2rem',
                      height: '2rem',
                      borderRadius: '10px',
                      background: 'var(--color-private-bg)',
                      color: 'var(--color-private)',
                    }}
                  >
                    {rootPrivateOpen ? (
                      <FolderOpen className="w-4 h-4" strokeWidth={2} />
                    ) : (
                      <Folder className="w-4 h-4" strokeWidth={2} />
                    )}
                  </span>
                  <span
                    className="text-[13.5px] font-bold flex-1"
                    style={{ color: 'var(--color-private)' }}
                  >
                    내 문제집
                  </span>
                  {rootPrivateOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--color-muted)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--color-muted)]" />
                  )}
                </button>

                {rootPrivateOpen && (
                  <div className="ml-3 border-l border-[var(--color-border)] pl-2 my-1">
                    {uploads.length === 0 ? (
                      /* 빈 상태 */
                      <div className="px-2 py-3">
                        <p className="text-[11px] text-[var(--color-muted)] leading-relaxed mb-2">
                          업로드한 자료가 없습니다.
                          <br />
                          내신 대비에서 강의자료를 업로드하세요.
                        </p>
                        <Link
                          href="/notes"
                          className="text-[11px] font-semibold underline"
                          style={{ color: 'var(--color-private)' }}
                        >
                          내신 대비 바로가기 →
                        </Link>
                      </div>
                    ) : (
                      uploads.map((upload) => {
                        const isActive =
                          active?.kind === 'upload' && active.uploadId === upload.id;
                        return (
                          <button
                            key={upload.id}
                            onClick={() => openUpload(upload)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors"
                            style={
                              isActive
                                ? {
                                    background: 'var(--color-private)',
                                    color: 'white',
                                    boxShadow: '0 4px 12px -4px rgba(194,94,42,0.55)',
                                  }
                                : {}
                            }
                            onMouseEnter={(e) => {
                              if (!isActive) {
                                (e.currentTarget as HTMLButtonElement).style.background =
                                  'var(--color-private-bg)';
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
                                  : 'var(--color-private)',
                              }}
                              strokeWidth={2}
                            />
                            <span
                              className="flex-1 truncate leading-snug font-medium"
                              style={
                                isActive ? {} : { color: 'var(--color-private)' }
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
            </div>
          )}
        </Card>

        {/* ─── 우측: 콘텐츠 패널 ─────────────────────────────────────────── */}
        <section className="main-list">
          {active ? (
            <div>
              <button
                onClick={() => setActive(null)}
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
                <PrivateContent
                  key={`${active.uploadId}-${solveReset ? 'reset' : 'resume'}`}
                  active={active}
                  questions={privateQuestions}
                  onAnswered={loadProgress}
                  priorAttempts={solveReset ? undefined : attemptsByQuestion}
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
              ) : uploads.length === 0 ? (
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
                  <div className="text-lg font-bold text-sage-800 mb-1">아직 문제집이 없습니다</div>
                  <div className="text-sm text-[var(--color-muted)] max-w-sm mb-5">
                    강의자료를 업로드하면 문제집이 자동으로 생성됩니다.
                  </div>
                  <Link href="/notes">
                    <Button variant="accent" size="md">자료 업로드하고 문제집 만들기 →</Button>
                  </Link>
                </Card>
              ) : visibleSets.length === 0 ? (
                <Card className="py-16 text-center text-[var(--color-muted)]">
                  조건에 맞는 문제집이 없습니다.
                </Card>
              ) : (
                <div className="books">
                  {visibleSets.map((item) => (
                    <SetCard key={item.upload.id} item={item} onOpen={openUpload} onDelete={handleDeleteSet} />
                  ))}
                </div>
              )}

              <p className="mt-5 text-[12px] text-[var(--color-muted)] leading-relaxed">
                국시 문제는 왼쪽 <span className="font-semibold text-sage-700">폴더 → 국시 문제</span>에서
                과목·세부주제를 선택해 풀 수 있어요.
              </p>
            </div>
          )}
        </section>
      </div>
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
  const total = item.progressTotal || count;
  const isDone = total > 0 && attempted >= total; // 다 풀었으면 '다시풀기'
  const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : null;
  const progressPct = total > 0 ? Math.min(100, Math.round((attempted / total) * 100)) : 0;
  return (
    <article className="card book-card">
      <div className="book-top">
        <div className="source-tag">
          <Folder className="icon"/><span>내 자료</span>
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
          {isDone ? '다시풀기' : '이어풀기'}
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
        <Link href="/exam">
          <Button variant="accent" size="md">
            국시 대비에서 이어 풀기 →
          </Button>
        </Link>
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

function PrivateContent({
  active,
  questions,
  onAnswered,
  priorAttempts,
}: {
  active: { kind: 'upload'; uploadId: string; fileName: string };
  questions: PrivateQuestion[];
  onAnswered?: () => void;
  priorAttempts?: Record<string, { selectedIndex: number; isCorrect: boolean }>;
}) {
  // 세트 전체 채점 집계 — 각 문항 카드의 채점 결과를 모은다(이어풀기 시 이전 답도 시드).
  const [answers, setAnswers] = useState<Record<string, { selected: number; correct: boolean }>>(() => {
    const init: Record<string, { selected: number; correct: boolean }> = {};
    if (priorAttempts) {
      for (const [qid, a] of Object.entries(priorAttempts)) {
        if (a.selectedIndex >= 0) init[qid] = { selected: a.selectedIndex, correct: a.isCorrect };
      }
    }
    return init;
  });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [savedNote, setSavedNote] = useState(false);
  const [savingNote, setSavingNote] = useState(false);

  function handleGraded(qid: string, selected: number, correct: boolean) {
    setAnswers((prev) => (prev[qid] ? prev : { ...prev, [qid]: { selected, correct } }));
  }

  const answeredList = questions.filter((q) => answers[q.id]);
  const allAnswered = questions.length > 0 && answeredList.length === questions.length;
  const correctCount = answeredList.filter((q) => answers[q.id].correct).length;
  const wrongList = questions.filter((q) => answers[q.id] && !answers[q.id].correct);
  const pct = questions.length > 0 ? Math.round((correctCount / questions.length) * 100) : 0;

  // 다 풀면 오답을 기본 선택 상태로.
  useEffect(() => {
    if (allAnswered) setChecked(new Set(wrongList.map((q) => q.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAnswered]);

  function toggleCheck(qid: string) {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(qid)) n.delete(qid); else n.add(qid);
      return n;
    });
  }

  async function saveToNotes() {
    const targets = wrongList.filter((q) => checked.has(q.id));
    if (targets.length === 0) { alert('오답노트에 담을 문제를 선택해주세요.'); return; }
    setSavingNote(true);
    try {
      await Promise.all(
        targets.map((q) =>
          api.post('/api/wrong-answers', {
            private_question_id: q.id,
            sub_topic_id: q.sub_topic_id ?? null,
            selected_index: answers[q.id]?.selected ?? null,
            source: 'lecture_note',
          }),
        ),
      );
      setSavedNote(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : '오답노트 저장에 실패했습니다.');
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <div>
      {/* 상단 메타 + 내신 대비 풀기 링크 */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="ll-chip"
            style={{
              width: '3rem',
              height: '3rem',
              borderRadius: '15px',
              background: 'var(--color-private-bg)',
              color: 'var(--color-private)',
            }}
          >
            <Upload className="w-5 h-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <span className="ll-eyebrow mb-2">내 업로드 자료</span>
            <div
              className="text-2xl font-bold tracking-tight leading-tight truncate"
              style={{ color: 'var(--color-private)' }}
            >
              {active.fileName}
            </div>
          </div>
        </div>
        <Link href="/notes">
          <Button variant="secondary" size="md">
            새 문제 만들기 →
          </Button>
        </Link>
      </div>

      <p className="text-sm text-[var(--color-muted)] mb-5 leading-relaxed">
        보기를 눌러 바로 풀어보세요. 선택하면 정답과 해설이 표시됩니다.
      </p>

      {questions.length === 0 ? (
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
            <FileText className="w-6 h-6" strokeWidth={1.7} />
          </span>
          <div className="text-lg font-bold mb-1" style={{ color: 'var(--color-private)' }}>
            문항이 없습니다
          </div>
          <div className="text-sm text-[var(--color-muted)] max-w-sm">
            이 자료에서 생성된 문항이 아직 없습니다.
          </div>
        </Card>
      ) : (
        <>
          <div className="space-y-4">
            {questions.map((q, i) => (
              <PrivateSolveCard
                key={q.id}
                q={q}
                index={i}
                onAnswered={onAnswered}
                prior={priorAttempts?.[q.id]}
                onGraded={(sel, correct) => handleGraded(q.id, sel, correct)}
              />
            ))}
          </div>

          {allAnswered && (
            <Card className="mt-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div className="text-lg font-bold text-sage-800">전체 채점 결과</div>
                <Badge variant={pct >= 60 ? 'curated' : 'warn'}>정답률 {pct}%</Badge>
              </div>
              <p className="text-sm text-sage-800 mb-1">
                총 {questions.length}문항 중 <b>{correctCount}문항</b> 정답 · <b>{wrongList.length}문항</b> 오답
              </p>

              {wrongList.length === 0 ? (
                <p className="mt-3 text-sm font-semibold text-[var(--color-curated)]">모두 맞혔어요! 🎉</p>
              ) : savedNote ? (
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-sage-700 bg-[var(--color-curated-bg)] border border-[var(--color-sage-500)] rounded-xl p-3.5 text-center font-semibold">
                  ✓ 선택한 오답을 오답노트에 담았어요.{' '}
                  <Link href="/wrong-notes" className="underline">오답노트로 이동</Link>
                </div>
              ) : (
                <>
                  <p className="text-[13px] text-[var(--color-muted)] mt-4 mb-2">오답노트에 담을 문제를 선택하세요.</p>
                  <div className="space-y-2 mb-4">
                    {wrongList.map((q) => (
                      <label
                        key={q.id}
                        className="flex items-start gap-3 p-3.5 rounded-xl border border-[var(--color-border)] cursor-pointer hover:border-sage-400 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(q.id)}
                          onChange={() => toggleCheck(q.id)}
                          className="mt-1 accent-[var(--color-private)]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-sage-800 line-clamp-2">{withImageLabels(q.stem)}</div>
                          <div className="text-xs text-[var(--color-warn)] mt-1">
                            내 답 {(answers[q.id]?.selected ?? 0) + 1}번 · 정답 {q.answer_index + 1}번
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <Button onClick={saveToNotes} loading={savingNote} fullWidth>
                    선택한 오답 노트에 담기
                  </Button>
                </>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/** 내 문제집 안에서 바로 풀어보는 문항 카드 — 보기 전부 표시, 선택 시 정답·해설 공개. */
function PrivateSolveCard({ q, index, onAnswered, prior, onGraded }: { q: PrivateQuestion; index: number; onAnswered?: () => void; prior?: { selectedIndex: number; isCorrect: boolean }; onGraded?: (selected: number, correct: boolean) => void }) {
  // 이전에 푼 문항이면 그 선택을 복원(이어풀기).
  const [selected, setSelected] = useState<number | null>(
    prior && prior.selectedIndex >= 0 ? prior.selectedIndex : null,
  );
  const answered = selected !== null;

  function handleSelect(ci: number) {
    if (answered) return;
    setSelected(ci);
    onGraded?.(ci, ci === q.answer_index); // 상위(세트) 전체 채점 집계용
    // 풀이 기록을 서버에 남겨야 진행도/정답률이 집계된다(track: lecture_note, quota 무료).
    api
      .post('/api/attempts', { question_id: q.id, selected_index: ci, track: 'lecture_note' })
      .then(() => onAnswered?.())
      .catch(() => {
        // 기록 실패해도 로컬 채점/해설은 그대로 보여준다.
      });
  }
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex gap-1.5 flex-wrap">
          <Badge variant="private">내 자료</Badge>
          <Badge variant="warn">난이도 {'★'.repeat(q.difficulty)}</Badge>
        </div>
        <span className="text-xs font-semibold text-[var(--color-muted)] tabular-nums">#{index + 1}</span>
      </div>

      {/* 문제 발문을 이미지보다 먼저(위에) 배치한다. */}
      <div className="text-[15px] leading-7 text-sage-800 font-medium mb-4">{withImageLabels(q.stem)}</div>

      {q.images && q.images.length > 0 && (
        <div className="mb-4 space-y-2">
          {q.images.map((img, ii) => (
            <figure key={ii}>
              <figcaption className="text-[12px] font-semibold text-sage-700 mb-1">이미지 {ii + 1}</figcaption>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={`이미지 ${ii + 1}`} className="w-full max-h-80 object-contain rounded-xl border border-[var(--color-border)] bg-white" />
            </figure>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {q.choices.map((choice, ci) => {
          const isCorrect = ci === q.answer_index;
          const isSel = ci === selected;
          let cls = 'border-[var(--color-border)] bg-white';
          if (!answered) cls += ' hover:border-sage-300 hover:bg-sage-50 cursor-pointer';
          else if (isCorrect) cls = 'border-[var(--color-curated)] bg-[var(--color-curated-bg)]';
          else if (isSel) cls = 'border-[var(--color-warn)] bg-[var(--color-warn-bg)]';
          return (
            <button
              key={ci}
              type="button"
              disabled={answered}
              onClick={() => handleSelect(ci)}
              className={`w-full text-left flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors disabled:cursor-default ${cls}`}
            >
              <span className="w-6 h-6 rounded-lg border border-[var(--color-border)] bg-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5 text-sage-700">
                {ci + 1}
              </span>
              <span className="text-sm text-sage-800 leading-6 flex-1">{choice}</span>
              {answered && isCorrect && (
                <span className="text-[var(--color-curated)] font-bold flex-shrink-0" aria-label="정답">✓</span>
              )}
              {answered && isSel && !isCorrect && (
                <span className="text-[var(--color-warn)] font-bold flex-shrink-0" aria-label="오답">✗</span>
              )}
            </button>
          );
        })}
      </div>

      {answered && (
        <div className="mt-4 rounded-2xl bg-[var(--color-sage-100)] p-4">
          <div className="text-sm font-bold mb-1.5" style={{ color: selected === q.answer_index ? 'var(--color-curated)' : 'var(--color-warn)' }}>
            {selected === q.answer_index ? '✓ 정답입니다' : `✗ 오답 — 정답: ${q.answer_index + 1}번`}
          </div>
          {q.explanation && (
            <div className="text-sm text-sage-800 leading-relaxed">{q.explanation}</div>
          )}
        </div>
      )}
    </Card>
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

      <div className="text-[15px] leading-7 text-sage-800 font-medium mb-4">{withImageLabels(q.stem)}</div>

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
