import Link from 'next/link';
import { createServerClient } from '@/lib/db/server';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Plus } from 'lucide-react';

interface SubjectRow {
  id: string;
  code: string;
  name: string;
}

interface SubjectStat {
  id: string;
  name: string;
  code: string;
  curated: number;
  community: number;
  beta: number;
  total: number;
}

const IMAGE_HEAVY_SUBJECTS = new Set(['cardiology', 'pulmonology', 'pathology', 'radiology']);

export default async function BankPage() {
  // (auth) layout already enforces session
  const supabase = await createServerClient();

  const { data: subjectsRaw } = await supabase
    .from('subjects')
    .select('id, code, name')
    .eq('is_active', true)
    .order('sort_order');

  const subjects: SubjectRow[] = subjectsRaw ?? [];

  const stats: SubjectStat[] = await Promise.all(
    subjects.map(async (subject) => {
      const { data: subTopicRows } = await supabase
        .from('sub_topics')
        .select('id')
        .eq('subject_id', subject.id);
      const subTopicIds = ((subTopicRows ?? []) as { id: string }[]).map(
        (r) => r.id,
      );

      if (subTopicIds.length === 0) {
        return {
          id: subject.id,
          name: subject.name,
          code: subject.code,
          curated: 0,
          community: 0,
          beta: 0,
          total: 0,
        };
      }

      const [curatedRes, communityRes, betaRes] = await Promise.all([
        supabase
          .from('questions')
          .select('id', { count: 'exact', head: true })
          .in('sub_topic_id', subTopicIds)
          .eq('tier', 'curated')
          .eq('status', 'active'),
        supabase
          .from('questions')
          .select('id', { count: 'exact', head: true })
          .in('sub_topic_id', subTopicIds)
          .eq('tier', 'community')
          .eq('status', 'active'),
        supabase
          .from('questions')
          .select('id', { count: 'exact', head: true })
          .in('sub_topic_id', subTopicIds)
          .eq('tier', 'beta')
          .eq('status', 'active'),
      ]);

      const curated = curatedRes.count ?? 0;
      const community = communityRes.count ?? 0;
      const beta = betaRes.count ?? 0;

      return {
        id: subject.id,
        name: subject.name,
        code: subject.code,
        curated,
        community,
        beta,
        total: curated + community + beta,
      };
    }),
  );

  const totalCurated = stats.reduce((sum, s) => sum + s.curated, 0);
  const totalCommunity = stats.reduce((sum, s) => sum + s.community, 0);
  const totalBeta = stats.reduce((sum, s) => sum + s.beta, 0);

  return (
    <div className="ll-system-page">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-sage-800 mb-2">과목별 문제은행</h1>
        <p className="text-sm text-[var(--color-muted)]">
          AI 사전 생성 풀 · 학교 코호트 필터 적용 · 신뢰 등급별 분리 제공
        </p>
      </div>

      <div className="flex flex-wrap gap-2.5 mb-8">
        <PoolStat label="Curated 풀 (의사 검수)" value={totalCurated.toLocaleString()} />
        <PoolStat label="Community 풀 (AI 검증)" value={totalCommunity.toLocaleString()} />
        <PoolStat label="베타 (생성 중)" value={totalBeta.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {stats.map((stat) => (
          <BankCard key={stat.id} stat={stat} />
        ))}
        <AddPlaceholder />
      </div>
    </div>
  );
}

function BankCard({ stat }: { stat: SubjectStat }) {
  const imageFocus = IMAGE_HEAVY_SUBJECTS.has(stat.code);
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <Badge>{stat.name}</Badge>
        <span className="text-[11px] text-[var(--color-muted)]">코호트 필터 적용</span>
      </div>
      <div className="text-lg font-bold text-sage-800 mb-1.5 flex items-center gap-2">
        {stat.name}
        {imageFocus && (
          <span className="text-[11px] text-sage-700">★ 이미지 기반</span>
        )}
      </div>
      <div className="text-sm text-[var(--color-muted)] mb-4">
        {stat.code === 'cardiology'
          ? '12-Lead ECG · 부정맥 · 심혈관 영상'
          : stat.code === 'pulmonology'
            ? '흉부 X-ray · COPD · 폐암'
            : stat.code === 'pathology'
              ? 'H&E 염색 현미경 슬라이드'
              : '개념·경로 기반 문항'}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        <Badge variant="curated">✓ 검수 {stat.curated}</Badge>
        <Badge variant="community">AI {stat.community}</Badge>
        {stat.beta > 0 && <Badge variant="beta">β {stat.beta}</Badge>}
      </div>

      <div className="text-sm text-[var(--color-muted)] mb-5">
        활성 문항 <strong className="text-sage-800">{stat.total.toLocaleString()}</strong>
        개 · 코호트 빈출도 기반 자동 추출
      </div>

      {stat.total > 0 ? (
        <Link
          href={`/practice?subject_id=${stat.id}`}
          className="mt-auto inline-flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white text-[15px] font-semibold px-5 h-11 rounded-lg hover:bg-[var(--color-accent-dark)] transition-colors"
        >
          풀이 시작 →
        </Link>
      ) : (
        <span className="mt-auto inline-flex items-center justify-center bg-[var(--color-sage-100)] text-[var(--color-muted)] text-[15px] font-semibold px-5 h-11 rounded-lg">
          문항 준비 중
        </span>
      )}
    </Card>
  );
}

function AddPlaceholder() {
  return (
    <div className="bg-[var(--color-sage-100)] border-2 border-dashed border-[var(--color-sage-400)] rounded-xl p-6 flex items-center justify-center text-center min-h-[220px]">
      <div>
        <Plus className="w-7 h-7 mx-auto text-[var(--color-sage-400)] mb-2" strokeWidth={1.6} />
        <div className="text-sm font-semibold text-sage-800">곧 추가됩니다</div>
        <div className="text-xs text-[var(--color-muted)] mt-1">
          신장·해부학·약리학 등
        </div>
      </div>
    </div>
  );
}

function PoolStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--color-sage-100)] rounded-lg text-sm text-sage-800">
      <strong className="text-base text-sage-700">{value}</strong>
      <span className="text-[var(--color-muted)]">{label}</span>
    </span>
  );
}
