'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import clsx from 'clsx';
import { api, ApiError } from '@/lib/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SubjectIcon } from '@/components/SubjectIcon';
import {
  Timer, ChevronRight, FileCheck2, Play, BookOpen, SlidersHorizontal, ListChecks, Lock, GraduationCap,
} from 'lucide-react';

interface Subject {
  id: string;
  code: string;
  name: string;
}
interface MockSession {
  id: string;
  title: string;
  subject_ids: string[];
  total: number;
  score: number | null;
  status: 'in_progress' | 'submitted' | 'abandoned';
  started_at: string;
  submitted_at: string | null;
  duration_seconds: number | null;
  created_at: string;
}

const COUNT_OPTIONS = [10, 30, 50];
const COUNT_STEP = 5;
const COUNT_MIN = 10;
const COUNT_MAX = 50;
const TIME_LIMIT_STEP = 5;
const TIME_LIMIT_MIN = 5;
const TIME_LIMIT_MAX = 150;

export default function MockHomePage() {
  const router = useRouter();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(30);
  const [timeLimit, setTimeLimit] = useState(30);
  const [sessions, setSessions] = useState<MockSession[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planTier, setPlanTier] = useState<string | null>(null);
  const [mockUnlocked, setMockUnlocked] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<Subject[]>('/api/subjects?with_sub_topics=false&active_only=true').catch(() => []),
      api.get<MockSession[]>('/api/mock-exams').catch(() => []),
      api.get<{ plan_tier: string; mock_unlocked?: boolean }>('/api/me/quota').catch(() => null),
    ])
      .then(([subs, sess, quota]) => {
        setSubjects(subs);
        setSessions(sess);
        if (quota) {
          setPlanTier(quota.plan_tier);
          setMockUnlocked(!!quota.mock_unlocked);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  // 모의고사는 국가고시 대비(standard) 이상 전용. 단 개발단계 MOCK_UNLOCKED 면 전원 허용.
  // tier 미확정(null) 동안엔 잠그지 않음(깜빡임 방지).
  const locked = !mockUnlocked && planTier !== null && !['standard', 'pro', 'unlimited'].includes(planTier);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const allSelected = subjects.length > 0 && selected.size === subjects.length;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(subjects.map((s) => s.id)));
  }

  // 문항 수를 바꾸면 시간 제한도 문항당 1분 기준으로 따라간다(이후 수동 조절 가능).
  function pickCount(c: number) {
    setCount(c);
    setTimeLimit(c);
  }
  function nudgeCount(delta: number) {
    pickCount(Math.min(COUNT_MAX, Math.max(COUNT_MIN, count + delta)));
  }
  function nudgeTimeLimit(delta: number) {
    setTimeLimit((t) => Math.min(TIME_LIMIT_MAX, Math.max(TIME_LIMIT_MIN, t + delta)));
  }

  // subjectIds 를 주면 그 과목만 바로 시작(칸의 '바로 풀기'), 없으면 현재 선택된 과목으로 통합 시작.
  async function start(subjectIds?: string[]) {
    if (locked) {
      router.push('/plan');
      return;
    }
    const subs = subjectIds ?? [...selected];
    if (subs.length === 0) {
      alert('과목을 1개 이상 선택해주세요.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post<{ id: string }>('/api/mock-exams', {
        subject_ids: subs,
        count,
        duration_seconds: timeLimit * 60,
      });
      router.push(`/mock/${res.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'tier_required') {
        alert('모의고사는 국가고시 대비 이상 요금제에서 이용할 수 있어요. 요금제를 업그레이드해주세요.');
        router.push('/plan');
      } else if (e instanceof ApiError && e.code === 'quota_exceeded') {
        window.location.href = '/plan?limit=1';
      } else if (e instanceof ApiError && e.code === 'no_content') {
        alert('선택한 과목에 출제 가능한 문항이 아직 없습니다. 다른 과목을 선택해보세요.');
      } else {
        alert(e instanceof Error ? e.message : '모의고사 생성 실패');
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="ll-mock-page content">
      <section className="page-head">
        <div>
          <span className="eyebrow"><GraduationCap className="icon" />실전 CBT 환경</span>
          <h1><span className="headline-accent">모의고사</span>를<br/>시험처럼 시작합니다</h1>
          <p className="lead">여러 과목을 섞어 실제 국시 CBT와 유사한 흐름으로 풀 수 있어요. 문항 수와 시간 제한만 정하면 바로 응시를 시작합니다.</p>
        </div>
        <div className="exam-meta" aria-label="모의고사 요약">
          <span className="meta-pill"><ListChecks className="icon" />선택 <strong>{selected.size}</strong>과목</span>
          <span className="meta-pill"><Timer className="icon" /><strong>{count}</strong>문항</span>
        </div>
      </section>

      {locked && (
        <div className="mb-6 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-accent-bg)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-[var(--color-accent)]"><Lock className="w-5 h-5" strokeWidth={2} /></span>
            <div>
              <div className="text-sm font-semibold text-sage-800">모의고사는 국가고시 대비 이상 요금제 전용이에요</div>
              <div className="text-[13px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                현재 요금제로는 이용할 수 없어요. 업그레이드하면 실전 CBT 모의고사를 구성할 수 있어요.
              </div>
            </div>
          </div>
          <Link href="/plan" className="flex-shrink-0">
            <Button variant="accent" size="sm">요금제 보기</Button>
          </Link>
        </div>
      )}

      <div className="layout">
        {/* 과목 선택 */}
        <section className="card panel">
          <div className="panel-head"><div className="title-row"><span className="chip"><BookOpen className="icon" /></span><div><h2>과목 선택</h2><p className="section-copy">여러 과목을 선택하면 통합 모의고사가 구성됩니다.</p></div></div><div className="flex items-center gap-2.5"><span className="hint">복수 선택 가능</span><button type="button" className="select-all" onClick={toggleAll} disabled={subjects.length === 0}>{allSelected ? '전체 해제' : '전체 선택'}</button></div></div>
          {loading ? (
            <div className="text-sm text-[var(--color-muted)] py-10 text-center">불러오는 중...</div>
          ) : subjects.length === 0 ? (
            <div className="text-sm text-[var(--color-muted)] py-10 text-center">
              등록된 과목이 없습니다. 시드 문항을 추가하면 표시됩니다.
            </div>
          ) : (
            <div className="subject-grid">
              {subjects.map((s) => {
                const on = selected.has(s.id);
                return (
                  <button key={s.id} type="button" onClick={() => toggle(s.id)} onDoubleClick={() => start([s.id])} className={clsx('subject-btn', on && 'selected')} aria-pressed={on}>
                    <span className="subject-name"><span className="subject-mini"><SubjectIcon name={s.name} className="w-4 h-4" strokeWidth={1.9} /></span><span className="subject-text">{s.name}</span></span>
                    <span className="check">✓</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 설정 */}
        <aside className="card panel">
          <div className="panel-head"><div className="title-row"><span className="chip"><SlidersHorizontal className="icon" /></span><div><h2>시험 설정</h2><p className="section-copy">문항 수와 시간 제한을 정하세요.</p></div></div></div>
          <div className="settings">
            <div>
              <div className="field-label">
                <ListChecks className="icon" />
                문항 수
              </div>
              <div className="segmented">
                {COUNT_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => pickCount(c)}
                    className={clsx(count === c && 'active')}
                    aria-pressed={count === c}
                  >
                    {c}문항
                  </button>
                ))}
              </div>
              <div className="question-count-range">
                <button
                  type="button"
                  aria-label="문항 수 5개 줄이기"
                  onClick={() => nudgeCount(-COUNT_STEP)}
                  disabled={count <= COUNT_MIN}
                >
                  −
                </button>
                <div className="range-track">
                  <div className="range-value"><span>직접 조절</span><output>{count}문항</output></div>
                  <input
                    type="range"
                    aria-label="문항 수 직접 조절"
                    min={COUNT_MIN}
                    max={COUNT_MAX}
                    step={COUNT_STEP}
                    value={count}
                    onChange={(event) => pickCount(Number(event.target.value))}
                  />
                </div>
                <button
                  type="button"
                  aria-label="문항 수 5개 늘리기"
                  onClick={() => nudgeCount(COUNT_STEP)}
                  disabled={count >= COUNT_MAX}
                >
                  +
                </button>
              </div>
              <p className="question-count-note">10~50문항 범위에서 5문항 단위로 조절할 수 있어요.</p>
            </div>

            <div>
              <div className="field-label">
                <Timer className="icon" />
                시간 제한
              </div>
              <div className="stepper">
                <button type="button" aria-label="시간 제한 5분 줄이기" onClick={() => nudgeTimeLimit(-TIME_LIMIT_STEP)} disabled={timeLimit <= TIME_LIMIT_MIN}>−</button>
                <span className="stepper-value">{timeLimit}분</span>
                <button type="button" aria-label="시간 제한 5분 늘리기" onClick={() => nudgeTimeLimit(TIME_LIMIT_STEP)} disabled={timeLimit >= TIME_LIMIT_MAX}>+</button>
              </div>
              <p className="stepper-note">문항 수에 맞춰 자동 설정되며, 5분 단위로 조절할 수 있어요. 시간이 다 지나면 자동으로 채점됩니다.</p>
            </div>

            <div className="summary-box"><dl><div><dt>시험 범위</dt><dd>{selected.size ? `${selected.size}과목` : '과목 미선택'}</dd></div><div><dt>문항 구성</dt><dd>{count}문항</dd></div><div><dt>시간 제한</dt><dd>{timeLimit}분</dd></div><div><dt>응시 방식</dt><dd>CBT형</dd></div></dl></div>
            <div>
              {locked ? (
                <Link href="/plan" className="block">
                  <Button variant="accent" size="lg" fullWidth>
                    <Lock className="w-4 h-4" />
                    요금제 업그레이드
                  </Button>
                </Link>
              ) : (
                  <Button className="start-btn" variant="accent" size="lg" fullWidth onClick={() => start()} loading={creating} disabled={selected.size === 0}>
                  <Play className="w-4 h-4" />
                  모의고사 시작
                </Button>
              )}
              <p className="helper">
                {locked ? '국가고시 대비 이상 요금제에서 이용 가능' : `선택 ${selected.size}과목 · ${count}문항`}
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* 이전 세션 */}
      {sessions.length > 0 && (
        <section className="recent">
          <div className="recent-head"><h2>최근 모의고사</h2><span className="eyebrow">응시 기록</span></div>
          <div className="record-list">
            {sessions.map((s) => (
              <Link
                key={s.id}
                href={`/mock/${s.id}`}
                className="record"
              >
                <span className="chip">
                  <FileCheck2 className="icon" />
                </span>
                <div className="record-main">
                  <div className="record-title">{s.title}</div>
                  <div className="record-sub">
                    {s.total}문항 · {new Date(s.created_at).toLocaleDateString('ko-KR')}
                  </div>
                </div>
                {s.status === 'submitted' ? (
                  <Badge variant="curated">
                    {s.score}/{s.total}점
                  </Badge>
                ) : (
                  <Badge variant="beta">진행 중</Badge>
                )}
                <ChevronRight className="w-4 h-4 text-[var(--color-muted)] flex-shrink-0 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
