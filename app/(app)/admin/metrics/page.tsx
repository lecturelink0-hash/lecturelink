import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { getDailyCostUsd } from '@/lib/ai/cost-cap';
import { Card } from '@/components/ui/Card';
import {
  summarizeRequests,
  summarizeQuality,
  costPerQuestion,
  type LatencyStats,
} from '@/lib/metrics/summary';
import { configSnapshot } from '@/lib/ai/versions';
import type { RequestMetricRow } from '@/lib/types/database';

// 지표는 항상 지금 값을 보여야 한다 — 캐시된 성공률은 장애 중에 초록불을 띄운다.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WINDOW_CHOICES = [1, 7, 30] as const;
const RETENTION_DAYS = 90;
// 한 화면에 올릴 상한. 넘어가면 표본이 잘렸다고 화면에 밝힌다 —
// 조용히 자르면 "이 기간 성공률"이 사실은 최근 일부의 성공률이 된다.
const ROW_LIMIT = 20000;

export default async function AdminMetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  try {
    await requireAdmin();
  } catch {
    redirect('/dashboard');
  }

  const { days: rawDays } = await searchParams;
  const parsed = Number(rawDays);
  const days = WINDOW_CHOICES.includes(parsed as (typeof WINDOW_CHOICES)[number]) ? parsed : 7;

  const admin = createAdminClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // 보존 기간 정리. 대시보드가 열릴 때만 돈다 — 요청 경로에 붙이면 계측이 서비스보다 비싸진다.
  await admin.rpc('purge_request_metrics', { retain_days: RETENTION_DAYS }).then(
    () => {},
    (error: unknown) => console.error('[metrics] purge 실패:', error),
  );

  const [{ data, error }, costInfo] = await Promise.all([
    admin
      .from('request_metrics')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT),
    getDailyCostUsd(),
  ]);

  if (error) {
    return (
      <Shell days={days}>
        <Card title="지표를 불러오지 못했습니다">
          <p className="text-sm text-sage-800">{error.message}</p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            00042_request_metrics.sql 마이그레이션이 적용됐는지 확인해주세요.
          </p>
        </Card>
      </Shell>
    );
  }

  const rows = (data ?? []) as RequestMetricRow[];
  const summary = summarizeRequests(rows);
  const quality = summarizeQuality(rows);
  const perQuestion = costPerQuestion(rows);
  const snapshot = configSnapshot();
  const truncated = rows.length >= ROW_LIMIT;

  return (
    <Shell days={days}>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label={`요청 성공률 (${summary.total.toLocaleString()}건)`} value={percent(summary.successRate)} />
        <StatCard
          label={`문항 1개당 원가 (${perQuestion.questions.toLocaleString()}문항)`}
          value={perQuestion.perQuestionUsd === null ? '—' : `$${perQuestion.perQuestionUsd.toFixed(4)}`}
        />
        <StatCard
          label={`스키마 준수율 (${quality.questions.toLocaleString()}문항)`}
          value={percent(quality.schemaValidRate)}
        />
        <StatCard
          label="오늘 AI 비용"
          value={`$${costInfo.currentUsd.toFixed(2)} / $${costInfo.capUsd}`}
        />
      </div>

      {summary.total === 0 && (
        <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-white p-4 text-sm text-[var(--color-muted)]">
          이 기간에 기록된 요청이 없습니다. 마이그레이션 적용 후 실제 트래픽이 돌아야 값이 쌓입니다.
        </div>
      )}
      {truncated && (
        <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-white p-4 text-sm text-sage-800">
          표본이 상한({ROW_LIMIT.toLocaleString()}건)에서 잘렸습니다. 아래 수치는 이 기간
          <b> 최근 {ROW_LIMIT.toLocaleString()}건</b>의 값입니다.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card title="오류 코드 분포">
          <TallyList rows={Object.entries(summary.errorCodes)} />
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] space-y-1 text-xs text-[var(--color-muted)]">
            <div>
              실패 {summary.retry.failures.toLocaleString()}건 중 재시도 {summary.retry.retried.toLocaleString()}건 ·
              회복 {summary.retry.recovered.toLocaleString()}건
            </div>
            <div>
              재시도 성공률 <b>{percent(summary.retry.recoveryRate)}</b> · 재시도 없이 이탈{' '}
              <b>{percent(summary.retry.abandonRate)}</b>
            </div>
            <div>실패 후 10분 안의 같은 사용자·같은 기능 요청을 재시도로 셉니다.</div>
          </div>
        </Card>

        <Card title="품질 게이트 (저장 직전 검사)">
          <ul className="space-y-1.5 text-sm">
            <Row label="검사한 요청" value={`${quality.checkedRequests.toLocaleString()}건`} />
            <Row label="검사한 문항" value={`${quality.questions.toLocaleString()}개`} />
            <Row
              label="스키마 위반"
              value={`${quality.schemaViolations.toLocaleString()}개 (${percent(quality.violationRate)})`}
            />
            <Row
              label="중복 의심"
              value={`${quality.duplicates.toLocaleString()}개 (${percent(quality.duplicateRate)})`}
            />
          </ul>
          <p className="mt-3 pt-3 border-t border-[var(--color-border)] text-xs text-[var(--color-muted)]">
            위반·중복은 저장을 막지 않고 표시만 합니다. 임계를 넘은 표본만 사람이 다시 봅니다.
            분모는 요청이 아니라 문항입니다.
          </p>
        </Card>
      </div>

      <Card title="기능별 성공률·지연시간·원가">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="text-left py-2 pr-2">기능</th>
                <th className="text-right py-2 pr-2">요청</th>
                <th className="text-right py-2 pr-2">성공률</th>
                <th className="text-right py-2 pr-2">p50</th>
                <th className="text-right py-2 pr-2">p95</th>
                <th className="text-right py-2 pr-2">p99</th>
                <th className="text-right py-2 pr-2">평균 원가</th>
                <th className="text-left py-2">주요 오류</th>
              </tr>
            </thead>
            <tbody>
              {summary.features.map((feature) => (
                <tr key={feature.feature} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-2 font-medium text-sage-800">{feature.feature}</td>
                  <td className="py-2 pr-2 text-right">{feature.total.toLocaleString()}</td>
                  <td className="py-2 pr-2 text-right">{percent(feature.successRate)}</td>
                  <td className="py-2 pr-2 text-right">{ms(feature.successLatencyMs.p50)}</td>
                  <td className="py-2 pr-2 text-right">{ms(feature.successLatencyMs.p95)}</td>
                  <td className="py-2 pr-2 text-right">{ms(feature.successLatencyMs.p99)}</td>
                  <td className="py-2 pr-2 text-right">
                    {feature.meanCostUsd === null ? '—' : `$${feature.meanCostUsd.toFixed(4)}`}
                  </td>
                  <td className="py-2 text-xs text-[var(--color-muted)]">
                    {Object.entries(feature.errorCodes).slice(0, 3).map(([c, n]) => `${c}×${n}`).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          지연시간은 성공 요청만의 분포입니다. 표본이 적은 p95는 사실상 최댓값이므로 요청 수와 함께 읽습니다.
        </p>
      </Card>

      <div className="mt-6">
        <Card title="단계별 병목 (생성 파이프라인)">
          {(() => {
            const staged = summary.features.filter((f) => Object.keys(f.stageMs).length > 0);
            if (staged.length === 0) {
              return <div className="text-sm text-[var(--color-muted)]">단계 기록이 있는 요청이 아직 없습니다.</div>;
            }
            return staged.map((feature) => (
              <div key={feature.feature} className="mb-4 last:mb-0">
                <div className="text-xs text-[var(--color-muted)] mb-1.5">{feature.feature}</div>
                {Object.entries(feature.stageMs)
                  .sort(([, a], [, b]) => (b.p95 ?? 0) - (a.p95 ?? 0))
                  .slice(0, 8)
                  .map(([name, stats]) => (
                    <LatencyRow key={name} label={name} stats={stats} />
                  ))}
              </div>
            ));
          })()}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="재현 조건 (가이드 10.2)">
          <pre className="text-xs overflow-x-auto text-[var(--color-muted)] whitespace-pre-wrap">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            지표를 보고할 때 이 스냅샷을 함께 싣습니다. 프롬프트를 고치면 lib/ai/versions.ts 의 버전을 올려야
            그 전후 수치가 한 축으로 뭉치지 않습니다.
          </p>
        </Card>
      </div>

      <p className="mt-6 text-xs text-[var(--color-muted)]">
        보존 기간 {RETENTION_DAYS}일 · 창 {days}일 · 기준 시각 {new Date().toLocaleString('ko-KR')}
      </p>
    </Shell>
  );
}

function Shell({ days, children }: { days: number; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-sage-800 mb-1">Admin · 운영 지표</h1>
      <p className="text-sm text-[var(--color-muted)] mb-4">
        성능지표 검증 가이드 1단계(자체 측정) 실측값. 기능별 성공률·지연시간·오류 분포·재시도 성공률·문항당 원가.
      </p>
      <div className="flex items-center gap-2 mb-6">
        {WINDOW_CHOICES.map((choice) => (
          <Link
            key={choice}
            href={`/admin/metrics?days=${choice}`}
            className={`px-3 py-1.5 rounded-lg text-sm border ${
              choice === days
                ? 'bg-sage-800 text-white border-sage-800'
                : 'bg-white text-sage-800 border-[var(--color-border)]'
            }`}
          >
            최근 {choice}일
          </Link>
        ))}
        <Link
          href="/admin/cpx-metrics"
          className="ml-auto px-3 py-1.5 rounded-lg text-sm border bg-white text-sage-800 border-[var(--color-border)]"
        >
          CPX 운영 지표 →
        </Link>
      </div>
      {children}
    </div>
  );
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[var(--color-border)] rounded-xl p-5">
      <div className="text-[22px] font-bold text-sage-800">{value}</div>
      <div className="text-xs text-[var(--color-muted)] mt-1">{label}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-sage-800">{label}</span>
      <span className="text-[var(--color-muted)]">{value}</span>
    </li>
  );
}

function LatencyRow({ label, stats }: { label: string; stats: LatencyStats }) {
  return (
    <div className="flex items-center justify-between text-sm py-0.5">
      <span className="text-sage-800">{label}</span>
      <span className="text-[var(--color-muted)] text-xs">
        p50 {ms(stats.p50)} · p95 {ms(stats.p95)} · n={stats.count.toLocaleString()}
      </span>
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
        <li key={k} className="flex items-center justify-between text-sm">
          <span className="text-sage-800">{k}</span>
          <span className="text-[var(--color-muted)]">{v.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
