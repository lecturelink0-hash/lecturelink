import Link from 'next/link';
import { getCurrentSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Target, Brain, FileText } from 'lucide-react';

interface WeakAreaRow {
  sub_topic_id: string;
  error_count: number;
  attempt_count: number;
  error_rate: number;
  severity: number;
  sub_topic:
    | { id: string; name: string; subject: { id: string; name: string } | { id: string; name: string }[] | null }
    | { id: string; name: string; subject: { id: string; name: string } | { id: string; name: string }[] | null }[]
    | null;
}

interface NormalizedWeakArea {
  subTopicId: string;
  subTopicName: string;
  subjectId: string | null;
  subjectName: string;
  errorCount: number;
  attemptCount: number;
  accuracy: number;
  severity: number;
}

export default async function AnalysisPage() {
  const session = await getCurrentSession();
  if (!session) return null;

  const supabase = await createServerClient();

  const { data: weakRaw } = await supabase
    .from('user_weak_areas')
    .select(
      `
      sub_topic_id, error_count, attempt_count, error_rate, severity,
      sub_topic:sub_topics ( id, name, subject:subjects ( id, name ) )
    `,
    )
    .eq('user_id', session.userId)
    .order('severity', { ascending: false })
    .order('error_rate', { ascending: false })
    .limit(10);

  const weakAreas: NormalizedWeakArea[] = ((weakRaw ?? []) as WeakAreaRow[]).map((row) => {
    const st = Array.isArray(row.sub_topic) ? row.sub_topic[0] : row.sub_topic;
    const subjectRaw: { id: string; name: string } | { id: string; name: string }[] | null =
      st?.subject ?? null;
    const subj = Array.isArray(subjectRaw) ? subjectRaw[0] : subjectRaw;
    return {
      subTopicId: row.sub_topic_id,
      subTopicName: st?.name ?? '(미지정 sub-topic)',
      subjectId: subj?.id ?? null,
      subjectName: subj?.name ?? '미분류',
      errorCount: row.error_count,
      attemptCount: row.attempt_count,
      accuracy: row.attempt_count === 0 ? 0 : Math.round((1 - row.error_rate) * 100),
      severity: row.severity,
    };
  });

  const totalAttempts = weakAreas.reduce((sum, w) => sum + w.attemptCount, 0);
  const totalErrors = weakAreas.reduce((sum, w) => sum + w.errorCount, 0);
  const minAccuracy =
    weakAreas.length > 0 ? Math.min(...weakAreas.map((w) => w.accuracy)) : 0;
  const topWeak = weakAreas[0];

  return (
    <div className="ll-system-page">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-sage-800 mb-1">약점·오답 분석</h1>
        <p className="text-sm text-[var(--color-muted)]">
          맞춤 풀이와 내 강의 노트의 통합 오답 데이터를 기반으로 약점 클러스터를 자동 분류합니다.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard
          label={topWeak ? `최약점 정답률 (${topWeak.subjectName})` : '최약점 정답률'}
          value={weakAreas.length > 0 ? `${minAccuracy}%` : '—'}
        />
        <StatCard
          label="분류된 약점 유형"
          value={weakAreas.length.toString()}
        />
        <StatCard
          label="누적 오답 / 풀이"
          value={totalAttempts > 0 ? `${totalErrors} / ${totalAttempts}` : '0'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card
          title="약점 유형 분류"
          description="맞춤 풀이 + 내 강의 노트 통합 오답 데이터 기반 자동 클러스터링"
        >
          {weakAreas.length === 0 ? (
            <EmptyHint />
          ) : (
            <div className="space-y-3 mt-3">
              {weakAreas.slice(0, 5).map((w, i) => (
                <WeakRow key={w.subTopicId} index={i + 1} area={w} />
              ))}
            </div>
          )}
        </Card>

        <Card
          title="AI 추천 학습 플랜"
          description="약점 영역을 집중 보완하는 맞춤 코스"
        >
          {weakAreas.length === 0 ? (
            <div className="text-sm text-[var(--color-muted)] py-4">
              먼저 맞춤 풀이로 30문항 이상을 풀어보세요. 오답 패턴이 충분히 쌓이면 자동으로 약점 영역이 분류됩니다.
            </div>
          ) : (
            <div className="space-y-3 mt-2">
              <PlanRecommendation
                rank={1}
                track="맞춤 풀이"
                title={`${topWeak!.subTopicName} 집중 코스`}
                description={`최약점 영역 ① 보완. ${topWeak!.subjectName} 내 유사 문항이 풀에서 자동 추출됩니다.`}
                href={topWeak!.subjectId ? `/practice?subject_id=${topWeak!.subjectId}` : '/practice'}
                icon={<Brain className="w-4 h-4" />}
                featured
              />
              {weakAreas[1] && (
                <PlanRecommendation
                  rank={2}
                  track="맞춤 풀이"
                  title={`${weakAreas[1].subTopicName} 보강`}
                  description={`${weakAreas[1].subjectName} · 정답률 ${weakAreas[1].accuracy}% 영역`}
                  href={
                    weakAreas[1].subjectId
                      ? `/practice?subject_id=${weakAreas[1].subjectId}`
                      : '/practice'
                  }
                  icon={<Target className="w-4 h-4" />}
                />
              )}
              <PlanRecommendation
                rank={weakAreas[1] ? 3 : 2}
                track="내 강의 노트"
                title="해당 단원 강의자료 업로드 추천"
                description="교수님 슬라이드를 업로드하면 본인 학교 스타일의 맞춤 문제가 생성됩니다."
                href="/notes"
                icon={<FileText className="w-4 h-4" />}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function WeakRow({ index, area }: { index: number; area: NormalizedWeakArea }) {
  const color =
    area.accuracy < 30
      ? '#B85C4A'
      : area.accuracy < 50
        ? '#C77A4F'
        : area.accuracy < 70
          ? '#C89A52'
          : '#A89B5C';

  return (
    <div className="flex items-center gap-3 py-2 border-b border-[var(--color-border)] last:border-b-0">
      <div className="min-w-[180px]">
        <div className="text-sm font-medium text-sage-800">
          {circled(index)} {area.subTopicName}
        </div>
        <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
          {area.subjectName} · 오답 {area.errorCount}건 / {area.attemptCount}회 풀이
        </div>
      </div>
      <div className="flex-1">
        <div className="w-full h-1.5 bg-[var(--color-sage-200)] rounded-full overflow-hidden">
          <div
            className="h-full"
            style={{ width: `${Math.max(2, area.accuracy)}%`, background: color }}
          />
        </div>
      </div>
      <div className="text-sm font-semibold min-w-[48px] text-right" style={{ color }}>
        {area.accuracy}%
      </div>
    </div>
  );
}

function PlanRecommendation({
  rank,
  track,
  title,
  description,
  href,
  icon,
  featured,
}: {
  rank: number;
  track: string;
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  featured?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`block p-4 rounded-lg border transition-colors ${
        featured
          ? 'bg-[var(--color-sage-200)] border-[var(--color-border)] hover:bg-[var(--color-sage-200)]'
          : 'bg-[var(--color-sage-100)] border-[var(--color-border)] hover:bg-[var(--color-sage-200)]'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <Badge variant={featured ? 'curated' : 'default'}>
          추천 {rank}순위
        </Badge>
        <span className="text-[11px] text-sage-700 inline-flex items-center gap-1">
          {icon}
          {track}
        </span>
      </div>
      <div className="text-sm font-semibold text-sage-800 mt-1.5">{title}</div>
      <div className="text-xs text-[var(--color-muted)] mt-1 leading-relaxed">
        {description}
      </div>
    </Link>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[var(--color-border)] rounded-xl p-5">
      <div className="text-[26px] font-bold text-sage-800">{value}</div>
      <div className="text-xs text-[var(--color-muted)] mt-1">{label}</div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="text-center py-8 text-sm text-[var(--color-muted)]">
      아직 분류된 약점이 없습니다.
      <br />
      <Link href="/practice" className="text-sage-700 underline mt-2 inline-block">
        맞춤 풀이로 시작하기 →
      </Link>
    </div>
  );
}

function circled(n: number): string {
  const map = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  return map[n - 1] ?? `${n}.`;
}
