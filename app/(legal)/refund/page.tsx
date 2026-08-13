import type { Metadata } from 'next';
import Link from 'next/link';
import { legalOperator, REFUND_POLICY_VERSION } from '@/lib/legal/config';

export const metadata: Metadata = { title: '환불·해지 정책 — LectureLink' };

export default function RefundPolicyPage() {
  const operator = legalOperator();
  return (
    <article className="legal-document">
      <header className="legal-page-head">
        <h1>환불·해지 <span>정책</span></h1>
        <p>유료 콘텐츠, 월 구독 및 추가 크레딧의 청약철회와 환급 기준입니다.</p>
        <time dateTime={REFUND_POLICY_VERSION}>시행일: 2026년 8월 13일 · 버전 {REFUND_POLICY_VERSION}</time>
      </header>

      <Section title="1. 현재 무료 베타">
        현재 “무료 베타”로 표시된 이용권은 결제수단을 등록하지 않고 제공되며 자동으로 유료 전환되지 않습니다. 회사는 실제
        결제·해지·환불 기능과 사업자 고지정보가 준비되기 전에는 유료 판매를 개시하지 않습니다.
      </Section>

      <Section title="2. 유료 판매 개시 후 청약철회">
        이용자는 계약내용을 받은 날 또는 콘텐츠 공급이 시작된 날 중 늦은 날부터 7일 이내에 청약철회를 요청할 수 있습니다.
        다만 이용자의 사용으로 가치가 현저히 감소했거나 디지털 콘텐츠 제공이 시작된 경우에는 법령상 철회가 제한될 수
        있습니다. 회사는 제한 사실을 결제 전에 별도로 표시하고 미리보기·체험 또는 충분한 정보를 제공합니다. 이를 제공하지
        않은 경우 법령에 따른 청약철회권을 제한하지 않습니다.
      </Section>

      <Section title="3. 월 구독 해지">
        계정의 요금제 화면에서 언제든 자동갱신을 해지할 수 있습니다. 해지해도 이미 결제한 이용기간 만료일까지 이용할 수 있고
        다음 결제일부터 청구되지 않습니다. 회사가 서비스를 중단하거나 계약내용과 다르게 제공한 경우에는 남은 기간을 기준으로
        환급합니다.
      </Section>

      <Section title="4. 환급 기준">
        <ul>
          <li><strong>제공 전·미사용:</strong> 결제금액 전액</li>
          <li><strong>법정 청약철회 제한이 적법하게 고지된 뒤 사용:</strong> 제공된 기간·사용량에 해당하는 금액과 결제취소에 실제로 든 비용을 법령이 허용하는 범위에서 공제</li>
          <li><strong>회사 귀책의 장애·중단·중대한 결함:</strong> 미이용분 환급 및 관련 소비자분쟁해결기준에 따른 보상</li>
          <li><strong>추가 크레딧:</strong> 미사용분 전액 환급. 일부 사용 시 사용분을 정상 판매단가로 산정해 공제하되 공제액이 결제액을 넘지 않음</li>
          <li><strong>과오납:</strong> 확인 즉시 전액 환급</li>
        </ul>
      </Section>

      <Section title="5. 환급 절차와 기한">
        계정 화면 또는 <Link href="/contact">문의하기</Link>에서 주문번호와 사유를 제출할 수 있습니다. 회사는 요청을 확인한 뒤
        원칙적으로 3영업일 이내에 기존 결제수단으로 환급하고, 지연 시 관련 법령에 따른 지연배상금을 지급합니다. 결제업체의
        처리기간은 별도로 소요될 수 있습니다.
      </Section>

      <Section title="6. 결제기록">
        계약·청약철회 및 결제·공급 기록은 전자상거래법에 따라 5년, 소비자 불만·분쟁처리 기록은 3년 동안 다른 계정정보와
        분리하여 보관한 뒤 삭제합니다.
      </Section>

      <Section title="7. 문의">
        {operator.businessName} · {operator.supportEmail} · {operator.phone}
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="legal-section"><h2>{title}</h2><div>{children}</div></section>;
}
