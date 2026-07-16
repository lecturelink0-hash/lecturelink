import type { Metadata } from 'next';

export const metadata: Metadata = { title: '이용약관 — 렉처링크' };

export default function TermsPage() {
  return (
    <article className="text-sage-800">
      <h1 className="text-2xl font-bold mb-1">이용약관</h1>
      <p className="text-xs text-[var(--color-muted)] mb-8">시행일: 2026년 6월 26일</p>

      <Section title="제1조 (목적)">
        본 약관은 렉처링크(이하 &ldquo;회사&rdquo;)가 제공하는 의료 교육 특화 AI 학습 서비스(이하
        &ldquo;서비스&rdquo;)의 이용과 관련하여 회사와 이용자 간의 권리·의무 및 책임사항을 규정함을 목적으로 합니다.
      </Section>

      <Section title="제2조 (정의)">
        <ul className="list-disc pl-5 space-y-1">
          <li>&ldquo;서비스&rdquo;란 국가고시(KMLE) 대비 문항 학습, 강의자료 기반 AI 문항 생성, 오답·모의고사 기능 등을 말합니다.</li>
          <li>&ldquo;이용자&rdquo;란 본 약관에 동의하고 서비스를 이용하는 회원을 말합니다.</li>
          <li>&ldquo;콘텐츠&rdquo;란 서비스가 제공하거나 이용자가 업로드한 문항·강의자료·이미지 등을 말합니다.</li>
        </ul>
      </Section>

      <Section title="제3조 (회원가입 및 계정)">
        이용자는 이메일을 통해 회원으로 가입할 수 있으며, 계정 정보를 정확히 유지할 책임이 있습니다.
        타인의 계정을 무단으로 사용하거나 계정을 양도·대여할 수 없습니다.
      </Section>

      <Section title="제4조 (서비스의 제공 및 변경)">
        회사는 안정적인 서비스 제공을 위해 노력하며, 운영상·기술상 필요에 따라 서비스의 전부 또는 일부를
        변경하거나 중단할 수 있습니다. 이 경우 회사는 사전에 공지합니다.
      </Section>

      <Section title="제5조 (콘텐츠 및 지식재산권)">
        서비스가 제공하는 문항·해설 등의 지식재산권은 회사에 귀속됩니다. 이용자가 업로드한 강의자료는
        해당 이용자 본인의 학습 목적(Private)으로만 처리되며, 다른 이용자에게 공유되지 않습니다.
        이용자는 본인이 적법한 권리를 가진 자료만 업로드해야 합니다.
      </Section>

      <Section title="제6조 (AI 생성 콘텐츠의 한계)">
        서비스의 일부 문항·해설은 AI로 생성되며, 의학적 정확성을 보장하지 않습니다. 이용자는 학습 보조 수단으로만
        활용해야 하며, 실제 임상 판단이나 시험 정답의 근거로 단독 사용해서는 안 됩니다.
      </Section>

      <Section title="제7조 (유료 서비스 및 결제)">
        유료 요금제의 가격·제공 내용은 서비스 내에 표시되며, 결제는 회사가 지정한 결제대행사를 통해 처리됩니다.
        환불은 관련 법령 및 회사의 환불 정책에 따릅니다.
      </Section>

      <Section title="제8조 (이용자의 의무)">
        이용자는 관련 법령과 본 약관을 준수해야 하며, 서비스의 정상적 운영을 방해하는 행위, 타인의 권리를 침해하는
        행위, 콘텐츠의 무단 복제·배포 등을 해서는 안 됩니다.
      </Section>

      <Section title="제9조 (책임의 제한)">
        회사는 천재지변, 이용자의 귀책, 제3자 서비스 장애 등 회사의 합리적 통제를 벗어난 사유로 인한 손해에 대해
        책임을 지지 않습니다.
      </Section>

      <Section title="제10조 (약관의 변경)">
        회사는 필요 시 약관을 변경할 수 있으며, 변경 시 시행일과 변경 사유를 명시하여 공지합니다.
      </Section>

      <Section title="문의">
        본 약관에 대한 문의는 서비스 내 고객센터를 통해 접수해 주세요.
      </Section>

      <p className="text-[11px] text-[var(--color-muted)] mt-10 border-t border-[var(--color-border)] pt-4">
        본 약관은 표준 양식을 기반으로 작성된 초안이며, 정식 서비스 운영 전 법률 검토가 필요합니다.
      </p>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-base font-bold text-sage-800 mb-2">{title}</h2>
      <div className="text-sm text-[var(--color-muted)] leading-relaxed">{children}</div>
    </section>
  );
}
