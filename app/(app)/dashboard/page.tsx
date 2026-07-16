import Link from 'next/link';
import clsx from 'clsx';
import { DashboardView } from './DashboardView';
import { getCurrentSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { Upload, BookOpen, Check, ArrowRight, Flame } from 'lucide-react';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pickOne(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
function kstKey(iso: string): string {
  return new Date(new Date(iso).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
function startOfKstWeekUtc(): Date {
  const nowKst = new Date(Date.now() + KST_OFFSET_MS);
  const dow = nowKst.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  const monKst = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate()));
  monKst.setUTCDate(monKst.getUTCDate() - daysFromMonday);
  return new Date(monKst.getTime() - KST_OFFSET_MS);
}
function kstWeekDateKeys(startUtc: Date): string[] {
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) keys.push(kstKey(new Date(startUtc.getTime() + i * 86400000).toISOString()));
  return keys;
}
function computeStreak(dates: Set<string>): number {
  const nowKst = new Date(Date.now() + KST_OFFSET_MS);
  const cur = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate()));
  if (!dates.has(cur.toISOString().slice(0, 10))) cur.setUTCDate(cur.getUTCDate() - 1);
  let streak = 0;
  while (dates.has(cur.toISOString().slice(0, 10))) { streak += 1; cur.setUTCDate(cur.getUTCDate() - 1); }
  return streak;
}
function formatStudyTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}시간 ${mm}분` : `${mm}분`;
}
function lastStudyLabel(iso: string): string {
  const then = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const now = new Date(Date.now() + KST_OFFSET_MS);
  const thenDay = then.toISOString().slice(0, 10);
  const hhmm = then.toISOString().slice(11, 16);
  if (thenDay === now.toISOString().slice(0, 10)) return `오늘 ${hhmm}`;
  const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  if (thenDay === y) return `어제 ${hhmm}`;
  return `${then.toISOString().slice(5, 10).replace('-', '.')} ${hhmm}`;
}

const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

interface AttemptRow { is_correct: boolean; created_at: string; time_spent_seconds: number | null; }
interface RecentItem { isCorrect: boolean; createdAt: string; subTopicName: string; subjectName: string; }
interface RecoCard { tag: string; count: number; title: string; subtitle: string; }

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  const supabase = await createServerClient();
  const weekStart = startOfKstWeekUtc();
  const weekStartIso = weekStart.toISOString();
  const prevWeekStartIso = new Date(weekStart.getTime() - 7 * 86400000).toISOString();

  const [weekAttemptsRes, prevWeekRes, allDatesRes, recentRes, subTopicsRes, analysisRes] = await Promise.all([
    supabase.from('user_attempts').select('is_correct, created_at, time_spent_seconds')
      .eq('user_id', session.userId).gte('created_at', weekStartIso),
    supabase.from('user_attempts').select('time_spent_seconds')
      .eq('user_id', session.userId).gte('created_at', prevWeekStartIso).lt('created_at', weekStartIso),
    supabase.from('user_attempts').select('created_at').eq('user_id', session.userId)
      .order('created_at', { ascending: false }).limit(400),
    supabase.from('user_attempts')
      .select('is_correct, created_at, question:questions(sub_topic:sub_topics(name, subject:subjects(name)))')
      .eq('user_id', session.userId).order('created_at', { ascending: false }).limit(1),
    supabase.from('sub_topics').select('name, exam_relevance, subject:subjects(name, is_active)')
      .order('exam_relevance', { ascending: false }).limit(12),
    // 약점 분석용 — 세부주제별 정답률 집계 (최근 400문항)
    supabase.from('user_attempts')
      .select('is_correct, question:questions(sub_topic:sub_topics(name, subject:subjects(name)))')
      .eq('user_id', session.userId).order('created_at', { ascending: false }).limit(400),
  ]);

  const weekAttempts = (weekAttemptsRes.data ?? []) as AttemptRow[];
  const weekSeconds = weekAttempts.reduce((s, a) => s + (a.time_spent_seconds ?? 0), 0);
  const weekCount = weekAttempts.length;
  const weekCorrect = weekAttempts.filter((a) => a.is_correct).length;
  const weekAccuracy = weekCount > 0 ? Math.round((weekCorrect / weekCount) * 100) : 0;

  const prevRows = (prevWeekRes.data ?? []) as { time_spent_seconds: number | null }[];
  const prevSeconds = prevRows.reduce((s, a) => s + (a.time_spent_seconds ?? 0), 0);
  const prevCount = prevRows.length;
  const hasCompare = weekCount > 0 || prevCount > 0;
  const timeDelta = weekSeconds - prevSeconds;
  const countDelta = weekCount - prevCount;

  const weekDateKeys = kstWeekDateKeys(weekStart);
  const weekStudiedKeys = new Set(weekAttempts.map((a) => kstKey(a.created_at)));
  const todayKey = kstKey(new Date().toISOString());
  const weekDays = weekDateKeys.map((key, i) => ({
    label: WEEKDAY_LABELS[i], studied: weekStudiedKeys.has(key), isToday: key === todayKey,
  }));

  const allDates = new Set((allDatesRes.data ?? []).map((a) => kstKey(a.created_at as string)));
  const streak = computeStreak(allDates);

  // ───── 나의 학습 분석 (세부주제별 정답률 → 취약 개념) ─────
  const analysisRows = (analysisRes.data ?? []) as Record<string, unknown>[];
  const totalSolvedAll = analysisRows.length;
  const totalCorrectAll = analysisRows.filter((r) => r.is_correct).length;
  const overallAccuracy = totalSolvedAll > 0 ? Math.round((totalCorrectAll / totalSolvedAll) * 100) : 0;

  const byTopic = new Map<string, { name: string; subjectName: string; count: number; correct: number }>();
  for (const r of analysisRows) {
    const q = pickOne(r.question) as Record<string, unknown> | null;
    const st = pickOne(q?.sub_topic) as Record<string, unknown> | null;
    const subj = pickOne(st?.subject) as Record<string, unknown> | null;
    const name = (st?.name as string) ?? null;
    if (!name) continue;
    const cur = byTopic.get(name) ?? { name, subjectName: (subj?.name as string) ?? '', count: 0, correct: 0 };
    cur.count += 1;
    if (r.is_correct) cur.correct += 1;
    byTopic.set(name, cur);
  }
  const weakConcepts = [...byTopic.values()]
    .filter((t) => t.count >= 2)
    .map((t) => ({ ...t, accuracy: Math.round((t.correct / t.count) * 100) }))
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 3);

  const recentRow = (recentRes.data ?? [])[0] as Record<string, unknown> | undefined;
  let recent: RecentItem | null = null;
  if (recentRow) {
    const q = pickOne(recentRow.question) as Record<string, unknown> | null;
    const st = pickOne(q?.sub_topic) as Record<string, unknown> | null;
    const subj = pickOne(st?.subject) as Record<string, unknown> | null;
    recent = {
      isCorrect: recentRow.is_correct as boolean,
      createdAt: recentRow.created_at as string,
      subTopicName: (st?.name as string) ?? '문항',
      subjectName: (subj?.name as string) ?? '학습',
    };
  }

  const recommendations = buildRecommendations((subTopicsRes.data ?? []) as unknown[], recent);
  const displayName = session.profile.displayName ?? '학생';

  return (
    <DashboardView
      displayName={displayName}
      recent={recent ? { ...recent, label: lastStudyLabel(recent.createdAt) } : null}
      weekSeconds={weekSeconds}
      weekCount={weekCount}
      weekAccuracy={weekAccuracy}
      streak={streak}
      weekDays={weekDays}
      overallAccuracy={overallAccuracy}
      totalSolved={totalSolvedAll}
      weakCount={weakConcepts.length}
    />
  );

  /* Legacy dashboard markup retained temporarily while the remaining routes are migrated. */
  const legacyRecent = recent!;
  if (Date.now() < 0) return (
    <div className="space-y-12 max-w-[1140px] mx-auto">
      {/* 인사 */}
      <div>
        <h1 className="text-[clamp(1.9rem,4vw,2.45rem)] font-bold text-[var(--color-text)] tracking-[-0.035em] leading-tight">
          안녕하세요, <span className="text-[var(--color-primary)]">{displayName}</span>님
        </h1>
        <p className="mt-1.5 text-[13px] font-medium text-[#8c9893]">
          {legacyRecent ? `마지막 학습 ${lastStudyLabel(legacyRecent.createdAt)}` : '오늘도 학습을 시작해보세요'}
        </p>
      </div>

      {/* 시안의 우선순위 구조: 이어서 할 학습이 가장 크고, 주간 기록이 보조한다. */}
      <div className="grid md:grid-cols-[minmax(0,1.5fr)_minmax(340px,.82fr)] gap-[18px] items-stretch">
          {/* 좌 */}
          <div className="ll-card p-6 order-2 md:order-2 bg-white/80 shadow-none">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-[13px] font-semibold text-[#36504a]">이번 주 학습</h2>
              {streak > 0 ? (
                <span className="inline-flex items-center gap-1.5 border-l-2 border-[var(--color-accent)] pl-2 font-bold text-[var(--color-accent-dark)]">
                  <Flame className="w-4 h-4" aria-hidden="true" />
                  <span className="text-[15px] leading-none tabular-nums">{streak}</span>
                  <span className="text-[12px] leading-none">일 연속</span>
                </span>
              ) : (
                <span className="text-[13px] font-medium text-[var(--color-muted)]">오늘 시작하면 연속 1일</span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-7">
              <div>
                <div className="text-[13px] font-medium text-[#8c9893] mb-1.5">이번 주 공부시간</div>
                <div className="ll-num text-[22px] leading-none">{formatStudyTime(weekSeconds)}</div>
                {hasCompare && (
                  <div className="text-[11px] text-[var(--color-muted)] mt-1.5">
                    지난주 대비 {timeDelta >= 0 ? '+' : '−'}{formatStudyTime(Math.abs(timeDelta))}
                  </div>
                )}
              </div>
              <div>
                <div className="text-[13px] font-medium text-[#8c9893] mb-1.5">이번 주 정답률</div>
                <div className="ll-num text-[22px] leading-none">{weekAccuracy}%</div>
              </div>
              <div>
                <div className="text-[13px] font-medium text-[#8c9893] mb-1.5">이번 주 푼 문항</div>
                <div className="ll-num text-[22px] leading-none">{weekCount}문항</div>
                {hasCompare && (
                  <div className="text-[11px] text-[var(--color-muted)] mt-1.5">
                    지난주 대비 {countDelta >= 0 ? '+' : '−'}{Math.abs(countDelta)}문항
                  </div>
                )}
              </div>
            </div>

            {/* 시안(렉처링크 앱.html) computed style 그대로: 컨테이너 max-w 335px · flex justify-between · 원 22px · 라벨 11px */}
            <div className="text-[13px] font-medium text-[#8c9893] mb-3">주간 학습 기록</div>
            <div className="flex justify-between gap-1.5 px-4">
              {weekDays.map((d, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <span className="text-[11px] font-normal text-[#36504a]">{d.label}</span>
                  <span className={clsx(
                    'w-[22px] h-[22px] rounded-full flex items-center justify-center',
                    d.studied
                      ? 'bg-sage-700 text-white'
                      : d.isToday
                        ? 'border-2 border-sage-400'
                        : 'border border-[var(--color-border)]',
                  )}>
                    {d.studied && <Check className="w-3 h-3" strokeWidth={3} />}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 우 — 이어서 학습 */}
          <div className="ll-card p-6 md:p-7 order-1 md:order-1 text-[var(--color-text)] border-[#c9debe] flex flex-col min-h-[300px] overflow-hidden bg-[radial-gradient(circle_at_92%_0%,rgba(166,199,176,.35),transparent_32%),linear-gradient(135deg,#fff_0%,#f1f8f2_46%,#ddefe2_100%)] shadow-[0_10px_30px_-20px_rgba(31,92,67,.36)]">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[15px] font-extrabold text-[var(--color-text)]">지금 이어서 할 학습</h2>
              {recent && (
                <span className="text-[13px] font-semibold text-[var(--color-muted)]">{legacyRecent.subjectName} · {lastStudyLabel(legacyRecent.createdAt)}</span>
              )}
            </div>

            {recent ? (
              <>
                <div className="text-[clamp(25px,3.4vw,36px)] leading-tight font-extrabold text-[var(--color-text)] mt-5 mb-3.5 tracking-[-0.01em]">{legacyRecent.subTopicName}</div>
                <div className="text-[15px] text-[var(--color-ink-soft)] mb-5">
                  이번 주 정답률 {weekAccuracy}% · {weekCount}문항 · 마지막 {legacyRecent.isCorrect ? '정답' : '오답'}
                </div>
                <div className="h-2 rounded-full bg-[rgba(31,92,67,.14)] overflow-hidden mb-auto">
                  <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--color-primary),var(--color-gold))]" style={{ width: `${weekAccuracy}%` }} />
                </div>
                <div className="flex items-center gap-2 mt-6">
                  <Link href="/wrong-notes">
                    <button className="h-[50px] px-[18px] rounded-xl border border-[#c9debe] bg-white text-[14.5px] font-bold text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] transition-colors inline-flex items-center justify-center">오답노트 보기</button>
                  </Link>
                  <Link href="/exam">
                    <button className="h-[50px] min-w-[148px] px-[18px] rounded-xl bg-[var(--color-primary)] text-white text-[14.5px] font-extrabold hover:bg-[var(--color-primary-strong)] transition-colors inline-flex items-center gap-2 shadow-[0_12px_26px_-14px_rgba(31,92,67,.62),0_0_0_4px_rgba(243,198,78,.22)]">
                      이어풀기 <ArrowRight className="w-4 h-4" />
                    </button>
                  </Link>
                </div>
              </>
            ) : (
              <>
                <div className="text-[clamp(1.55rem,3vw,2.15rem)] font-bold text-white mt-3 mb-2">학습을 시작해보세요</div>
                <div className="text-[13px] text-white/70 mb-auto leading-relaxed">
                  국가고시 대비 문제로 첫 학습을 시작할 수 있어요.
                </div>
                <div className="mt-6">
                  <Link href="/exam">
                    <button className="h-10 px-4 rounded-[var(--radius-md)] bg-[var(--color-gold)] text-[var(--color-text)] text-sm font-bold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5">
                      국시 대비 시작 <ArrowRight className="w-4 h-4" />
                    </button>
                  </Link>
                </div>
              </>
            )}
          </div>
      </div>

      {/* 나의 학습 분석 */}
      {totalSolvedAll > 0 && (
        <section>
          <h2 className="text-[15px] font-semibold text-[#1f302d] mb-4">나의 학습 분석</h2>
          <div className="ll-card p-6">
            <div className="grid grid-cols-3 gap-4 mb-6 pb-6 border-b border-[var(--color-border)]">
              <div>
                <div className="ll-num text-[22px] leading-none">{overallAccuracy}%</div>
                <div className="text-[13px] font-medium text-[#8c9893] mt-1.5">평균 정답률</div>
              </div>
              <div>
                <div className="ll-num text-[22px] leading-none">
                  {totalSolvedAll}<span className="text-sm font-semibold text-[var(--color-muted)] ml-0.5">문항</span>
                </div>
                <div className="text-[13px] font-medium text-[#8c9893] mt-1.5">누적 학습</div>
              </div>
              <div>
                <div className="ll-num text-[22px] leading-none">
                  {weakConcepts.length}<span className="text-sm font-semibold text-[var(--color-muted)] ml-0.5">개</span>
                </div>
                <div className="text-[13px] font-medium text-[#8c9893] mt-1.5">취약 개념</div>
              </div>
            </div>

            {weakConcepts.length > 0 ? (
              <>
                <div className="text-xs text-[var(--color-muted)] mb-3">취약 개념 · 정답률이 낮은 순</div>
                <div className="space-y-3.5">
                  {weakConcepts.map((w) => (
                    <div key={w.name}>
                      <div className="flex items-center justify-between mb-1.5 text-sm">
                        <span className="text-sage-800">
                          {w.subjectName && <span className="text-[var(--color-muted)]">{w.subjectName} · </span>}
                          {w.name}
                        </span>
                        <span className="ll-stat font-semibold text-sage-800">{w.accuracy}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-[var(--color-sage-100)] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(w.accuracy, 4)}%`,
                            background:
                              w.accuracy < 50 ? 'var(--color-warn)' : w.accuracy < 75 ? 'var(--color-accent)' : 'var(--color-sage-600)',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <Link
                  href="/wrong-notes"
                  className="mt-5 inline-flex items-center gap-1 text-[13px] font-semibold text-sage-700 hover:text-sage-800 transition-colors"
                >
                  추천 복습: {weakConcepts[0].name} <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </>
            ) : (
              <div className="text-sm text-[var(--color-muted)]">
                아직 취약 개념을 분석할 만큼 데이터가 충분하지 않아요. 조금 더 풀어보세요.
              </div>
            )}
          </div>
        </section>
      )}

      {/* 학습 모드 */}
      <section>
        <h2 className="text-[15px] font-semibold text-[#1f302d] mb-4">학습 모드</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <ModeCard href="/notes" tag="자료 기반" icon={Upload}
            title="자료 기반 문제 만들기"
            description="강의자료를 업로드하고 시험 범위에 맞는 문제집을 생성하세요."
            cta="문제집 만들기" />
          <ModeCard href="/exam" tag="국가고시형" icon={BookOpen}
            title="국시 문제"
            description="과목별 임상형 문제를 바로 풀어보세요."
            cta="국시 문제 풀기" />
        </div>
      </section>

      {/* 오늘의 추천 */}
      {recommendations.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[15px] font-semibold text-[#1f302d]">오늘의 추천</h2>
            <Link href="/exam" className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-muted)] hover:text-sage-800 transition-colors">
              전체 보기 <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="grid md:grid-cols-[minmax(0,1.4fr)_minmax(16rem,.6fr)] gap-4">
            {recommendations.map((r, i) => <RecoCardView key={i} reco={r} featured={i === 0} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function buildRecommendations(subTopicRows: unknown[], recent: RecentItem | null): RecoCard[] {
  const active = subTopicRows.map((row) => {
    const r = row as Record<string, unknown>;
    const subj = pickOne(r.subject) as Record<string, unknown> | null;
    return {
      name: (r.name as string) ?? '',
      relevance: (r.exam_relevance as number) ?? 2,
      subjectName: (subj?.name as string) ?? '기타',
      isActive: subj ? (subj.is_active as boolean) !== false : true,
    };
  }).filter((s) => s.isActive && s.name.length > 0);

  const cards: RecoCard[] = [];
  const seen = new Set<string>();
  if (recent) {
    cards.push({ tag: '복습', count: 6, title: `${recent.subjectName} 복습`, subtitle: recent.subTopicName });
    seen.add(recent.subTopicName);
  }
  for (const s of active) {
    if (cards.length >= 3) break;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    cards.push({ tag: s.relevance >= 3 ? '국가고시형' : '자료 기반', count: 5, title: `${s.subjectName} ${s.name}`, subtitle: `${s.subjectName} 핵심 문제` });
  }
  return cards.slice(0, 3);
}

function ModeCard({ href, tag, icon: Icon, title, description, cta }: {
  href: string; tag: string; icon: typeof Upload; title: string; description: string; cta: string;
}) {
  return (
    <Link href={href} className="ll-card ll-card-hover p-6 flex flex-col group">
      <div className="flex items-start justify-between mb-4">
        <span className="text-xs font-medium text-[var(--color-muted)]">{tag}</span>
        <Icon className="w-5 h-5 text-[var(--color-sage-500)]" strokeWidth={1.8} />
      </div>
      <h3 className="text-[16px] font-semibold text-sage-800 mb-1.5">{title}</h3>
      <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-5">{description}</p>
      <span className="inline-flex items-center gap-1 text-sm font-semibold text-sage-700 mt-auto">
        {cta} <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function RecoCardView({ reco, featured = false }: { reco: RecoCard; featured?: boolean }) {
  return (
    <Link href="/exam" className={clsx('ll-card ll-card-hover p-5 flex flex-col group', featured && 'md:row-span-2 md:p-7')}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-xs font-medium text-[var(--color-muted)]">{reco.tag}</span>
        <span className="text-xs text-[var(--color-muted)] tabular-nums">{reco.count}문항</span>
      </div>
      <h3 className="text-[16px] font-semibold text-sage-800 mb-1 leading-snug">{reco.title}</h3>
      <p className="text-[13px] text-[var(--color-muted)] mb-4">{reco.subtitle}</p>
      <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-sage-700 mt-auto">
        복습하기 <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
