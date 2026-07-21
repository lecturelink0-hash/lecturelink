import CpxResultDetail from '@/components/cpx/CpxResultDetail';

export default async function CpxHistoryDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <CpxResultDetail sessionId={sessionId} />;
}
