import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { Card } from '@/components/ui/Card';

// 지표는 항상 지금 값을 보여야 한다 — 캐시된 성공률은 장애 중에 초록불을 띄운다.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WINDOW_CHOICES = [1, 7, 30] as const;

type LatencyStats = {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  max: number | null;
};

type FeatureStats = {
  feature: string;
  total: number;
  success: number;
  successRate: number | null;
  byStatus: Record<string, number>;
  errorCodes: Record<string, number>;
  latencyMs: LatencyStats;
  successLatencyMs: LatencyStats;
  stageMs: Record<string, LatencyStats>;
  schemaChecked: number;
  schemaValidRate: number | null;
  versions: string[];
  models: string[];
};

type TurnStats = {
  turns: number;
  sessions: number;
  turnsPerSession: number | null;
  firstResponseMs: LatencyStats;
  firstAudioMs: LatencyStats;
  turnCompleteMs: LatencyStats;
  interruptedRate: number | null;
  byNetwork: Record<string, { turns: number; firstResponseMs: LatencyStats }>;
  byInputMode: Record<string, { turns: number; firstResponseMs: LatencyStats }>;
};

type MetricsSummary = {
  schemaVersion: string;
  windowDays: number;
  generatedAt: number;
  requests: {
    total: number;
    success: number;
    successRate: number | null;
    failureRate: number | null;
    latencyMs: LatencyStats;
    errorCodes: Record<string, number>;
    features: FeatureStats[];
  };
  turns: TurnStats;
  sessions: {
    total: number;
    eligible: number;
    completed: number;
    completionRate: number | null;
    scoredRate: number | null;
    active: number;
    startFailures: number;
    startFailureRate: number | null;
    byEndReason: Record<string, number>;
  };
  cost: {
    sessions: number;
    liveSessions: number;
    meanSessionUsd: number;
    meanSessionKrw: number;
    p50SessionUsd: number | null;
    p95SessionUsd: number | null;
    meanLiveUsd: number;
    meanEvalUsd: number;
    usdKrwRate: number;
  };
};

// 종료 사유 → 화면 표기. 서버의 metrics.py END_REASON_* 와 짝을 이룬다.
const END_REASON_LABELS: Record<string, string> = {
  completed: '정상 종료 (완주)',
  time_limit: '제한시간 종료 (완주)',
  aborted: '중도 이탈',
  abandoned: '무응답 이탈 (추정)',
  start_failed: '시작 실패',
  superseded: '이전 연습 정리',
  error: '오류 종료',
  active: '진행 중',
  unknown: '사유 미기록',
};

async function loadSummary(days: number, userId: string): Promise<
  { ok: true; data: MetricsSummary } | { ok: false; message: string }
> {
  const base = process.env.CPX_BACKEND_URL;
  const secret = process.env.CPX_PROXY_SHARED_SECRET;
  if (!base || !secret) {
    return { ok: false, message: 'CPX_BACKEND_URL 또는 CPX_PROXY_SHARED_SECRET이 설정되지 않았습니다.' };
  }
  const endpoint = new URL('/api/metrics/summary', base);
  endpoint.searchParams.set('days', String(days));
  try {
    const response = await fetch(endpoint, {
      headers: {
        'x-lecturelink-user-id': userId,
        'x-cpx-proxy-secret': secret,
        // 백엔드는 이 헤더가 없으면 거절한다. requireAdmin()을 통과한 뒤에만 붙인다.
        'x-cpx-admin': '1',
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ok: false, message: `CPX 백엔드 응답 ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }
    return { ok: true, data: (await response.json()) as MetricsSummary };
  } catch {
    return { ok: false, message: 'CPX 서비스에 연결할 수 없습니다.' };
  }
}

export default async function AdminCpxMetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  let userId: string;
  try {
    userId = (await requireAdmin()).userId;
  } catch {
    redirect('/dashboard');
  }

  const { days: rawDays } = await searchParams;
  const parsed = Number(rawDays);
  const days = WINDOW_CHOICES.includes(parsed as (typeof WINDOW_CHOICES)[number]) ? parsed : 7;
  const loaded = await loadSummary(days, userId);

  return (
    <div>
      <h1 className="text-2xl font-bold text-sage-800 mb-1">Admin · CPX 운영 지표</h1>
      <p className="text-sm text-[var(--color-muted)] mb-4">
        성능지표 검증 가이드 1단계(자체 측정) 실측값. 성공률·지연시간·완주율·턴 응답시간·세션당 원가.
      </p>

      <div className="flex items-center gap-2 mb-6">
        {WINDOW_CHOICES.map((choice) => (
          <Link
            key={choice}
            href={`/admin/cpx-metrics?days=${choice}`}
            className={`px-3 py-1.5 rounded-lg text-sm border ${
              choice === days
                ? 'bg-sage-800 text-white border-sage-800'
                : 'bg-white text-sage-800 border-[var(--color-border)]'
            }`}
          >
            최근 {choice}일
          </Link>
        ))}
      </div>

      {!loaded.ok ? (
        <Card title="지표를 불러오지 못했습니다">
          <p className="text-sm text-sage-800">{loaded.message}</p>
        </Card>
      ) : (
        <MetricsBody summary={loaded.data} />
      )}
    </div>
  );
}

function MetricsBody({ summary }: { summary: MetricsSummary }) {
  const { requests, turns, sessions, cost } = summary;
  const evaluateFeature = requests.features.find((f) => f.feature === 'cpx_evaluate');

  return (
    <>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label={`요청 성공률 (${requests.total.toLocaleString()}건)`}
          value={percent(requests.successRate)}
        />
        <StatCard
          label={`세션 완주율 (분모 ${sessions.eligible}건)`}
          value={percent(sessions.completionRate)}
        />
        <StatCard
          label={`턴 응답시간 p95 (${turns.turns.toLocaleString()}턴)`}
          value={ms(turns.firstResponseMs.p95)}
        />
        <StatCard
          label={`세션당 평균 원가 (${cost.liveSessions}세션)`}
          value={cost.liveSessions ? `₩${Math.round(cost.meanSessionKrw).toLocaleString()}` : '—'}
        />
      </div>

      {requests.total === 0 && (
        <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-white p-4 text-sm text-[var(--color-muted)]">
          이 기간에 기록된 요청이 없습니다. 배포 후 실제 연습이 돌아야 값이 쌓입니다.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card title="세션 완주 (중단·타임아웃·재시작 분리)">
          <TallyList
            rows={Object.entries(sessions.byEndReason).map(([k, v]) => [END_REASON_LABELS[k] ?? k, v])}
          />
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] space-y-1 text-xs text-[var(--color-muted)]">
            <div>채점 도달률 {percent(sessions.scoredRate)} · 시작 실패율 {percent(sessions.startFailureRate)}</div>
            <div>
              분모에서 제외: 시작 실패·이전 연습 정리·진행 중 (진료할 기회가 없었거나 아직 끝나지 않은 세션)
            </div>
          </div>
        </Card>

        <Card title="턴 응답시간 (발화 종료 → 응답 시작)">
          <LatencyRow label="첫 응답" stats={turns.firstResponseMs} />
          <LatencyRow label="첫 오디오" stats={turns.firstAudioMs} />
          <LatencyRow label="턴 완료" stats={turns.turnCompleteMs} />
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] text-xs text-[var(--color-muted)]">
            세션당 평균 {turns.turnsPerSession ?? '—'}턴 · 끼어들기 {percent(turns.interruptedRate)}
          </div>
          {Object.keys(turns.byNetwork).length > 0 && (
            <div className="mt-2 text-xs text-[var(--color-muted)]">
              네트워크별 첫 응답 p95:{' '}
              {Object.entries(turns.byNetwork)
                .map(([net, stat]) => `${net} ${ms(stat.firstResponseMs.p95)}(${stat.turns}턴)`)
                .join(' · ')}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card title="세션당 원가 (토큰 실측)">
          <ul className="space-y-1.5 text-sm">
            <Row label="평균" value={`$${cost.meanSessionUsd.toFixed(4)} · ₩${Math.round(cost.meanSessionKrw).toLocaleString()}`} />
            <Row label="p50 / p95" value={`$${fixed(cost.p50SessionUsd)} / $${fixed(cost.p95SessionUsd)}`} />
            <Row label="Live 대화" value={`$${cost.meanLiveUsd.toFixed(4)}`} />
            <Row label="채점 호출" value={`$${cost.meanEvalUsd.toFixed(4)}`} />
            <Row label="환율" value={`₩${cost.usdKrwRate.toLocaleString()} / $1`} />
          </ul>
          <p className="mt-3 pt-3 border-t border-[var(--color-border)] text-xs text-[var(--color-muted)]">
            턴이 하나도 없던 세션은 평균에서 제외 (전체 {cost.sessions}세션 중 {cost.liveSessions}세션)
          </p>
        </Card>

        <Card title="오류 코드 분포">
          <TallyList rows={Object.entries(requests.errorCodes)} />
          {evaluateFeature && Object.keys(evaluateFeature.stageMs).length > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
              <div className="text-xs text-[var(--color-muted)] mb-1.5">채점 단계별 p95 (병목 식별)</div>
              {Object.entries(evaluateFeature.stageMs).map(([stageName, stats]) => (
                <LatencyRow key={stageName} label={stageName} stats={stats} />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="기능별 성공률·지연시간">
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
                <th className="text-right py-2 pr-2">스키마</th>
                <th className="text-left py-2">주요 오류</th>
              </tr>
            </thead>
            <tbody>
              {requests.features.map((feature) => (
                <tr key={feature.feature} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-2 font-medium text-sage-800">{feature.feature}</td>
                  <td className="py-2 pr-2 text-right">{feature.total.toLocaleString()}</td>
                  <td className="py-2 pr-2 text-right">{percent(feature.successRate)}</td>
                  <td className="py-2 pr-2 text-right">{ms(feature.successLatencyMs.p50)}</td>
                  <td className="py-2 pr-2 text-right">{ms(feature.successLatencyMs.p95)}</td>
                  <td className="py-2 pr-2 text-right">{ms(feature.successLatencyMs.p99)}</td>
                  <td className="py-2 pr-2 text-right">
                    {feature.schemaChecked ? percent(feature.schemaValidRate) : '—'}
                  </td>
                  <td className="py-2 text-xs text-[var(--color-muted)]">
                    {Object.entries(feature.errorCodes)
                      .slice(0, 3)
                      .map(([code, count]) => `${code}×${count}`)
                      .join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          지연시간은 성공 요청만의 분포다 — 실패는 즉시 끊기거나(4xx) 타임아웃 상한에 붙어(504) 분포를 양쪽으로
          왜곡한다. 표본이 적은 p95는 사실상 최댓값이므로 요청 수와 함께 읽는다.
        </p>
      </Card>

      <p className="mt-6 text-xs text-[var(--color-muted)]">
        계측 스키마 v{summary.schemaVersion} · 기준 시각{' '}
        {new Date(summary.generatedAt * 1000).toLocaleString('ko-KR')} · 창 {summary.windowDays}일
      </p>
    </>
  );
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function fixed(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : value.toFixed(4);
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
