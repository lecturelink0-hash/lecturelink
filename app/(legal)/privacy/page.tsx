import type { Metadata } from 'next';
import Link from 'next/link';
import { legalOperator, overseasRegions, PRIVACY_VERSION } from '@/lib/legal/config';

export const metadata: Metadata = { title: '개인정보처리방침 — LectureLink' };

export default function PrivacyPage() {
  const operator = legalOperator();
  const regions = overseasRegions();
  return (
    <article className="legal-document">
      <header className="legal-page-head">
        <h1>개인정보 <span>처리방침</span></h1>
        <p>{operator.businessName}가 LectureLink 이용자의 개인정보를 처리하고 보호하는 기준입니다.</p>
        <time dateTime={PRIVACY_VERSION}>시행일: 2026년 8월 13일 · 버전 {PRIVACY_VERSION}</time>
      </header>

      <Section title="1. 개인정보처리자">
        <ul>
          <li>개인정보처리자: {operator.businessName} · 대표자 {operator.representative}</li>
          <li>주소: {operator.address}</li>
          <li>개인정보 보호책임자: {operator.privacyOfficer}</li>
          <li>문의: {operator.supportEmail} · {operator.phone}</li>
        </ul>
      </Section>

      <Section title="2. 처리 목적·항목·보유기간">
        <div className="legal-table-wrap"><table className="legal-table"><thead><tr><th>목적</th><th>처리 항목</th><th>보유기간</th></tr></thead><tbody>
          <tr><td>회원가입·인증</td><td>이메일, 암호화된 인증정보, 카카오 식별자·닉네임, 계정유형, 가입·동의 이력</td><td>회원 탈퇴 시까지</td></tr>
          <tr><td>맞춤형 학습</td><td>이름, 학교, 학년, 학기, 과목, 문제풀이·정답·소요시간, 오답·모의고사·약점 기록</td><td>회원 탈퇴 또는 이용자가 삭제할 때까지</td></tr>
          <tr><td>자료 분석·AI 생성</td><td>업로드 파일, 파일명, 추출 텍스트·이미지, 생성 문항·해설·임베딩, 처리상태</td><td>회원 탈퇴 또는 자료 삭제 시까지</td></tr>
          <tr><td>CPX 실습</td><td>음성 입력, 음성 전사문, 텍스트 대화, 선택 시나리오, 신체진찰, 채점·피드백</td><td>회원 탈퇴 또는 기록 삭제 요청 시까지</td></tr>
          <tr><td>실시간 형성평가</td><td>참여 이름, 참여코드, 답안, 정답 여부, 점수, 참여·제출 시각</td><td>평가 종료 후 1년 또는 교수자가 먼저 삭제할 때까지</td></tr>
          <tr><td>결제·환불</td><td>주문번호, 상품·금액, 결제키, 결제·환불 상태와 시각, 필요한 거래응답</td><td>계약·결제 기록 5년</td></tr>
          <tr><td>문의·분쟁처리</td><td>이메일, 문의내용, 처리내역</td><td>처리 종료 후 3년</td></tr>
          <tr><td>보안·장애대응</td><td>IP 주소, 접속시각, 기기·브라우저 정보, 쿠키, 사용량·오류·보안기록</td><td>목적 달성 후 최대 1년(법령·보안상 별도 보존 필요 시 해당 기간)</td></tr>
        </tbody></table></div>
        비밀번호 원문은 회사가 저장하지 않으며 인증 제공자가 일방향 보호 방식으로 처리합니다. 서비스 제공에 필수적이지 않은
        정보는 선택사항으로 표시하고, 동의하지 않아도 해당 맞춤 기능 외의 서비스는 이용할 수 있습니다.
      </Section>

      <Section title="3. 만 14세 미만 아동">
        현재 서비스는 의과대학 학생과 교수를 대상으로 하며 만 14세 미만의 가입을 허용하지 않습니다. 향후 아동 대상 서비스를
        제공할 경우 법정대리인 동의와 확인 절차를 먼저 마련합니다.
      </Section>

      <Section title="4. 민감정보 및 제3자 자료">
        이용자 자신의 건강정보나 실제 환자·제3자의 진료기록, 성명, 얼굴, 음성 등은 입력하거나 업로드하지 마십시오. 회사는
        실제 진료정보 처리를 목적으로 서비스를 제공하지 않습니다. 불가피하게 민감정보를 처리하는 새 기능을 제공할 때에는
        별도의 법적 근거를 확인하고 필요한 동의를 받습니다.
      </Section>

      <Section title="5. 제3자 제공">
        실시간 평가를 개설한 교수와 그 소속 교육기관에는 평가 운영과 학습 결과 확인을 위해 참여자의 이름·답안·점수·제출시각이
        제공됩니다. 참여 화면에서 해당 교수, 제공 항목, 목적, 보유기간과 거부 시 참여 제한을 미리 알리고 동의를 받습니다.
        그 밖에는 이용자의 동의 또는 법령상 근거 없이 개인정보를 제3자에게 제공하지 않습니다.
      </Section>

      <Section title="6. 처리업무 위탁">
        <div className="legal-table-wrap"><table className="legal-table"><thead><tr><th>수탁자</th><th>위탁업무</th></tr></thead><tbody>
          <tr><td>Supabase, Inc.</td><td>회원 인증, 데이터베이스, 파일 저장</td></tr>
          <tr><td>Vercel, Inc.</td><td>웹서비스 호스팅, 요청 처리 및 운영 로그</td></tr>
          <tr><td>Google LLC</td><td>Gemini 문항·이미지 생성 및 Gemini Live 음성·전사 처리</td></tr>
          <tr><td>Anthropic, PBC</td><td>AI 문항·해설·OCR·이미지 분석의 주 또는 대체 처리</td></tr>
          <tr><td>Voyage AI, Inc.</td><td>문항 임베딩과 유사도 처리</td></tr>
          <tr><td>Upstash, Inc.</td><td>자료 분석 작업의 비동기 전달</td></tr>
          <tr><td>CPX 서버 호스팅 사업자</td><td>CPX 시뮬레이션, 전사·채점 처리</td></tr>
          <tr><td>토스페이먼츠 주식회사</td><td>결제 승인·취소·환불</td></tr>
          <tr><td>주식회사 카카오</td><td>카카오 계정 로그인</td></tr>
        </tbody></table></div>
        회사는 위탁계약에서 목적 외 처리금지, 안전조치, 재위탁, 사고통지, 반환·파기 및 감독에 관한 사항을 정하고 이행을
        확인합니다.
      </Section>

      <Section title="7. 개인정보 국외이전">
        서비스 이용 과정에서 아래와 같이 개인정보가 네트워크를 통해 국외로 이전·조회·보관될 수 있습니다.
        <div className="legal-table-wrap"><table className="legal-table"><thead><tr><th>이전받는 자·국가</th><th>항목·목적</th><th>시기·보유기간</th></tr></thead><tbody>
          <tr><td>Supabase · {regions.supabase}</td><td>계정·학습·업로드·평가 데이터의 인증·저장</td><td>서비스 이용 시 전송, 계정 또는 자료 삭제 시까지</td></tr>
          <tr><td>Vercel · {regions.vercel}</td><td>요청 정보와 운영 로그의 서비스 제공·보안</td><td>접속 시 전송, 운영 설정 기간</td></tr>
          <tr><td>Google · {regions.google}</td><td>업로드·프롬프트·음성·전사문의 AI 처리</td><td>AI 기능 이용 시 전송, 공급자 계약·설정 기간</td></tr>
          <tr><td>Anthropic · {regions.anthropic}</td><td>업로드·프롬프트·이미지의 AI 처리</td><td>AI 기능 이용 시 전송, 공급자 계약·설정 기간</td></tr>
          <tr><td>Voyage AI · {regions.voyage}</td><td>문항 텍스트의 임베딩 생성</td><td>임베딩 생성 시 전송, 공급자 계약·설정 기간</td></tr>
          <tr><td>Upstash · {regions.upstash}</td><td>이용자·업로드 식별자의 작업 전달</td><td>작업 등록 시 전송, 작업·로그 보존기간</td></tr>
          <tr><td>CPX 서버 · {regions.cpx}</td><td>사용자 식별자, 시나리오, 대화·진찰·평가 처리</td><td>CPX 이용 시 전송, 계정 또는 기록 삭제 시까지</td></tr>
        </tbody></table></div>
        계약 이행에 필요한 국외 처리위탁·보관은 본 방침 공개 또는 별도 고지에 근거합니다. 별도 동의를 근거로 하는 이전은
        동의 화면에서 거부방법과 거부 효과를 안내합니다. 국외이전을 원하지 않으면 해당 AI 기능을 이용하지 않거나
        {` ${operator.supportEmail}`}로 중지를 요청할 수 있으나 핵심 AI 기능 이용이 제한될 수 있습니다.
      </Section>

      <Section title="8. 파기 절차와 방법">
        보유기간이 끝나거나 목적이 달성되면 복구하기 어려운 방법으로 전자파일을 삭제합니다. 법령상 보존할 거래·분쟁 기록은
        일반 계정 데이터와 분리하고 접근을 제한한 뒤 보존기간 종료 후 삭제합니다. 외부 수탁자에도 삭제를 지시하고 처리결과를
        확인합니다.
      </Section>

      <Section title="9. 정보주체의 권리">
        이용자는 계정 화면 또는 <Link href="/contact">문의하기</Link>를 통해 열람, 정정·삭제, 처리정지, 동의철회, 회원탈퇴를
        요청할 수 있습니다. 회사는 본인 확인 후 법정 기간 내 처리하고 제한 사유가 있으면 근거와 이의제기 방법을 알립니다.
        비회원 평가 참여자는 평가명, 참여 이름과 참여 시각을 알려 권리를 행사할 수 있습니다.
      </Section>

      <Section title="10. 쿠키와 기기 저장정보">
        로그인 세션 유지, 카카오 로그인 보안, 실시간 평가 재접속을 위해 필수 쿠키·로컬 저장정보를 사용합니다. 현재 별도의
        맞춤광고 쿠키는 사용하지 않습니다. 브라우저 설정에서 저장을 차단하거나 삭제할 수 있으나 로그인과 평가 재접속 기능이
        제한될 수 있습니다. 분석·광고 도구를 새로 도입할 경우 목적과 거부방법을 이 방침에 추가합니다.
      </Section>

      <Section title="11. 자동화된 처리와 AI 평가">
        서비스는 학습 추천, 약점 분류 및 CPX 피드백에 AI를 이용하지만, 현재 이를 근거로 회원의 법적 권리, 대학 성적, 진급
        또는 자격을 자동 결정하지 않습니다. 결과에 이의가 있으면 문의를 통해 설명과 사람에 의한 재검토를 요청할 수 있습니다.
      </Section>

      <Section title="12. 안전성 확보조치">
        최소권한 접근통제, 행 단위 접근제어(RLS), 전송구간 암호화, 인증정보 보호, 접속기록, 비밀키 분리, 입력검증, 위탁업체
        관리, 침해사고 대응 및 정기 점검을 시행합니다. 개인정보 침해가 발생하면 관련 법령에 따라 조사·차단·통지·신고합니다.
      </Section>

      <Section title="13. 침해구제">
        회사의 개인정보 담당자에게 먼저 문의할 수 있으며, 개인정보침해 신고센터(국번 없이 118), 개인정보분쟁조정위원회,
        경찰청 또는 대검찰청의 상담·구제 절차를 이용할 수 있습니다.
      </Section>

      <Section title="14. 변경 및 이전 방침">
        방침이 변경되면 시행일 7일 전, 중요한 변경은 원칙적으로 30일 전에 공지합니다. 이전 버전은 이 페이지에서 열람할 수
        있도록 보관합니다.
      </Section>

      <p className="legal-note">운영자는 배포 전 환경설정에 실제 사업자 정보와 각 서비스의 데이터 처리 국가를 입력하고, 공급자 계약·콘솔 설정과 이 방침이 일치하는지 확인합니다.</p>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="legal-section"><h2>{title}</h2><div>{children}</div></section>;
}
