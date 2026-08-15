import Link from 'next/link';
import { createServerClient } from '@/lib/db/server';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { resolveQuestionBadgeShort } from '@/lib/content/tier-badge';
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

  // 예전에는 과목마다 sub_topics 1회 + tier 별 count 3회를 돌려 과목 수에 비례해
  // 왕복이 늘었다(과목 20개면 80회 이상). sub_topic 목록을 한 번에 받고, 문항은
  // (sub_topic_id, tier) 두 열만 한 번에 읽어 애플리케이션에서 집계한다.
  const subjectIds = subjects.map((s) => s.id);

  const { data: subTopicRows } = subjectIds.length
    ? await supabase
        .from('sub_topics')
        .select('id, subject_id')
        .in('subject_id', subjectIds)
    : { data: [] as { id: string; subject_id: string }[] };

  const subjectIdBySubTopic = new Map<string, string>();
  for (const row of (subTopicRows ?? []) as { id: string; subject_id: string }[]) {
    subjectIdBySubTopic.set(row.id, row.subject_id);
  }

  // sub_topic id 를 URL 로 나열하면(수백 개) 쿼리 문자열 길이 제한에 걸리므로 필터 없이
  // 활성 문항의 두 열만 읽고, 위 map 에 없는 행(비활성 과목)은 건너뛴다.
  // PostgREST 는 응답 행 수 상한이 있어 페이지 단위로 끝까지 읽는다.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50;
  const counts = new Map<string, { curated: number; community: number; beta: number }>();

  if (subjectIdBySubTopic.size > 0) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * PAGE_SIZE;
      const { data: rows, error } = await supabase
        .from('questions')
        .select('sub_topic_id, tier, reviewed_by')
        .eq('status', 'active')
        .range(from, from + PAGE_SIZE - 1);

      if (error) break;
      const batch = (rows ?? []) as {
        sub_topic_id: string | null;
        tier: string | null;
        reviewed_by: string | null;
      }[];

      for (const row of batch) {
        const subjectId = row.sub_topic_id
          ? subjectIdBySubTopic.get(row.sub_topic_id)
          : undefined;
        if (!subjectId) continue;
        const bucket =
          counts.get(subjectId) ?? { curated: 0, community: 0, beta: 0 };
        // 집계도 배지와 같은 근거를 쓴다 — 검수자가 기록된 문항만 '의사 검수'로 센다.
        // tier='curated' 라벨만 보고 세면 화면의 숫자가 배지와 어긋나 또 다른 거짓이 된다.
        const badge = resolveQuestionBadgeShort({ tier: row.tier, reviewedBy: row.reviewed_by });
        if (badge.color === 'curated') bucket.curated += 1;
        else if (badge.color === 'beta') bucket.beta += 1;
        else bucket.community += 1;
        counts.set(subjectId, bucket);
      }

      if (batch.length < PAGE_SIZE) break;
    }
  }

  const stats: SubjectStat[] = subjects.map((subject) => {
    const bucket = counts.get(subject.id) ?? { curated: 0, community: 0, beta: 0 };
    return {
      id: subject.id,
      name: subject.name,
      code: subject.code,
      curated: bucket.curated,
      community: bucket.community,
      beta: bucket.beta,
      total: bucket.curated + bucket.community + bucket.beta,
    };
  });

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
        <PoolStat label="의사 검수 완료" value={totalCurated.toLocaleString()} />
        <PoolStat label="AI 생성 · 검수 전" value={totalCommunity.toLocaleString()} />
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
