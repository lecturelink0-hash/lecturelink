import type { Metadata } from 'next';

export const metadata: Metadata = { title: '자주 묻는 질문 — 렉처링크' };

const FAQS: { q: string; a: string }[] = [
  {
    q: '렉처링크는 어떤 서비스인가요?',
    a: '의대생을 위한 의료 교육 특화 AI 학습 플랫폼입니다. KMLE(국가고시) 가이드라인 기반 문항 풀이, 학교별 시험 범위 필터, 강의자료 업로드 기반 AI 문항 생성, 오답노트·모의고사 기능을 제공합니다.',
  },
  {
    q: '어떻게 가입하나요?',
    a: '이메일과 비밀번호로 가입할 수 있습니다. 학교 이메일로 가입하면 학생 인증이 자동 적용될 예정입니다.',
  },
  {
    q: '강의자료를 올리면 어떻게 되나요?',
    a: 'PDF·PPT·DOCX·이미지를 업로드하면 AI가 자료를 분석해 예상 문항을 생성합니다. 업로드한 자료는 본인 계정에서만(Private) 사용되며 다른 사용자에게 공유되지 않습니다.',
  },
  {
    q: 'AI가 만든 문제는 믿을 수 있나요?',
    a: 'AI 생성 문항은 2단계 검증을 거치지만 의학적 정확성을 100% 보장하지는 않습니다. 학습 보조 수단으로 활용하시고, 중요한 내용은 교과서·강의자료로 교차 확인하시기를 권장합니다.',
  },
  {
    q: '모의고사는 실제 시험과 비슷한가요?',
    a: '실제 CBT 환경과 유사하게 문항 네비게이션, 표시·메모, 계산기, 시간 제한(만료 시 자동 제출)을 제공합니다.',
  },
  {
    q: '요금제는 어떻게 되나요?',
    a: '내신 대비·국가고시 대비·통합형 요금제가 있으며, 학습 시점에 맞춰 선택할 수 있습니다. 자세한 내용은 로그인 후 요금제 페이지에서 확인하세요.',
  },
  {
    q: '오답은 어떻게 복습하나요?',
    a: '틀린 문제는 오답노트에 담아 다시 풀 수 있고, 같은 개념의 유사 문제를 AI로 생성해 반복 학습할 수 있습니다.',
  },
];

export default function FaqPage() {
  return (
    <article className="text-sage-800">
      <h1 className="text-2xl font-bold mb-8">자주 묻는 질문</h1>
      <div className="space-y-5">
        {FAQS.map((f) => (
          <div key={f.q} className="border border-[var(--color-border)] rounded-xl p-5 bg-white">
            <h2 className="text-base font-bold text-sage-800 mb-2">Q. {f.q}</h2>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed">{f.a}</p>
          </div>
        ))}
      </div>
      <p className="text-sm text-[var(--color-muted)] mt-8">
        더 궁금한 점이 있으면 서비스 내 고객센터로 문의해 주세요.
      </p>
    </article>
  );
}
