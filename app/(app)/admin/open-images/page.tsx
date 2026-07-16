import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { getDailyCostUsd } from '@/lib/ai/cost-cap';
import { Card } from '@/components/ui/Card';

export default async function AdminOpenImagesPage() {
  try {
    await requireAdmin();
  } catch {
    redirect('/dashboard');
  }

  const admin = createAdminClient();

  const [{ data: bySource }, { data: byLicense }, { data: byModality }, { data: recent }, costInfo] =
    await Promise.all([
      admin.from('open_images').select('source', { count: 'exact', head: false }),
      admin.from('open_images').select('license'),
      admin.from('open_images').select('modality'),
      admin
        .from('open_images')
        .select('id, source, modality, license, caption, original_url, ingested_at, is_active')
        .order('ingested_at', { ascending: false })
        .limit(20),
      getDailyCostUsd(),
    ]);

  function tally<T extends Record<string, unknown>>(rows: T[] | null, key: keyof T): Array<[string, number]> {
    const map = new Map<string, number>();
    for (const r of rows ?? []) {
      const k = String(r[key]);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  const sourceCounts = tally(bySource, 'source');
  const licenseCounts = tally(byLicense, 'license');
  const modalityCounts = tally(byModality, 'modality');
  const total = bySource?.length ?? 0;

  return (
    <div>
      <h1 className="text-2xl font-bold text-sage-800 mb-1">Admin · 오픈 이미지 풀</h1>
      <p className="text-sm text-[var(--color-muted)] mb-6">
        인제스트 통계, 라이선스 분포, 최근 추가 항목.
      </p>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="총 이미지" value={total.toLocaleString()} />
        <StatCard label="소스 수" value={sourceCounts.length.toString()} />
        <StatCard label="라이선스 종류" value={licenseCounts.length.toString()} />
        <StatCard
          label="오늘 AI 비용"
          value={`$${costInfo.currentUsd.toFixed(2)} / $${costInfo.capUsd}`}
        />
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card title="소스별">
          <TallyList rows={sourceCounts} />
        </Card>
        <Card title="라이선스별">
          <TallyList rows={licenseCounts} />
        </Card>
        <Card title="Modality 별">
          <TallyList rows={modalityCounts} />
        </Card>
      </div>

      <Card title="최근 인제스트 (20건)">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="text-left py-2 pr-2">소스</th>
                <th className="text-left py-2 pr-2">Modality</th>
                <th className="text-left py-2 pr-2">라이선스</th>
                <th className="text-left py-2 pr-2">캡션</th>
                <th className="text-right py-2">시점</th>
              </tr>
            </thead>
            <tbody>
              {(recent ?? []).map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-2">{r.source}</td>
                  <td className="py-2 pr-2">{r.modality}</td>
                  <td className="py-2 pr-2">{r.license}</td>
                  <td className="py-2 pr-2 truncate max-w-xs">{r.caption ?? '—'}</td>
                  <td className="py-2 text-right text-xs text-[var(--color-muted)]">
                    {new Date(r.ingested_at).toLocaleString('ko-KR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[var(--color-border)] rounded-xl p-5">
      <div className="text-[22px] font-bold text-sage-800">{value}</div>
      <div className="text-xs text-[var(--color-muted)] mt-1">{label}</div>
    </div>
  );
}

function TallyList({ rows }: { rows: Array<[string, number]> }) {
  if (rows.length === 0) {
    return <div className="text-sm text-[var(--color-muted)]">데이터 없음</div>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map(([k, v]) => (
        <li
          key={k}
          className="flex items-center justify-between text-sm"
        >
          <span className="text-sage-800">{k}</span>
          <span className="text-[var(--color-muted)]">{v.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
