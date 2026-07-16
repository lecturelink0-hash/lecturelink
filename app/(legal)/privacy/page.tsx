import type { Metadata } from 'next';

export const metadata: Metadata = { title: '개인정보처리방침 — 렉처링크' };

export default function PrivacyPage() {
  return (
    <article className="text-sage-800">
      <h1 className="text-2xl font-bold mb-1">개인정보처리방침</h1>
      <p className="text-xs text-[var(--color-muted)] mb-8">시행일: 2026년 6월 26일</p>

      <Section title="1. 수집하는 개인정보 항목">
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>계정 정보</strong>: 이메일 주소, 비밀번호(암호화 저장)</li>
          <li><strong>프로필 정보</strong>: 학교, 학년, 학기, 수강 과목, 이용 목적, 추천 코드(선택)</li>
          <li><strong>학습 데이터</strong>: 문제 풀이 기록·정답 여부·소요 시간, 오답노트, 모의고사 결과, 시험 일정</li>
          <li><strong>업로드 자료</strong>: 이용자가 업로드한 강의자료·이미지(Private, 본인 전용)</li>
          <li><strong>자동 수집</strong>: 서비스 이용 과정에서 생성되는 로그·사용량 정보</li>
        </ul>
      </Section>

      <Section title="2. 개인정보의 이용 목적">
        <ul className="list-disc pl-5 space-y-1">
          <li>회원 식별 및 인증, 서비스 제공</li>
          <li>맞춤형 학습 추천 및 약점 분석</li>
          <li>업로드 자료 기반 AI 문항 생성</li>
          <li>유료 서비스 결제 및 정산</li>
          <li>서비스 개선 및 사용량 관리</li>
        </ul>
      </Section>

      <Section title="3. 처리 위탁 (제3자 처리)">
        회사는 서비스 제공을 위해 아래 업체에 일부 처리를 위탁합니다. 위탁 시 개인정보가 안전하게 관리되도록 합니다.
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li><strong>Supabase</strong> — 데이터베이스 및 인증(계정·학습 데이터 저장)</li>
          <li><strong>Anthropic</strong> — AI 문항·해설 생성(업로드 자료/문항 텍스트 처리)</li>
          <li><strong>Voyage AI</strong> — 문항 임베딩(유사도·중복 검사)</li>
          <li><strong>토스페이먼츠</strong> — 결제 처리(유료 이용 시)</li>
        </ul>
      </Section>

      <Section title="4. 보유 및 이용 기간">
        회원 탈퇴 시 또는 수집·이용 목적 달성 시 지체 없이 파기합니다. 단, 관련 법령에 따라 보존이 필요한 경우
        해당 기간 동안 보관합니다.
      </Section>

      <Section title="5. 이용자의 권리">
        이용자는 언제든지 본인의 개인정보를 조회·수정할 수 있으며, 회원 탈퇴를 통해 수집된 정보의 삭제를 요청할 수
        있습니다. 탈퇴 시 학습 데이터 및 업로드 자료는 함께 삭제됩니다.
      </Section>

      <Section title="6. 개인정보의 안전성 확보">
        비밀번호는 암호화하여 저장하며, 접근 권한 통제와 행 단위 보안(RLS)을 통해 이용자 본인만 자신의 데이터에
        접근하도록 관리합니다. 업로드 자료는 본인 외 다른 이용자에게 공유되지 않습니다.
      </Section>

      <Section title="7. 문의">
        개인정보 관련 문의는 서비스 내 고객센터를 통해 접수해 주세요.
      </Section>

      <p className="text-[11px] text-[var(--color-muted)] mt-10 border-t border-[var(--color-border)] pt-4">
        본 방침은 현재 서비스가 처리하는 데이터를 기준으로 작성된 초안이며, 정식 운영 전 개인정보보호법 등
        관련 법령에 따른 법률 검토 및 개인정보 보호책임자 지정이 필요합니다.
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
