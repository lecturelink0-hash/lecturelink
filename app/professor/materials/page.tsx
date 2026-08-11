import Link from 'next/link';
import { Lock } from 'lucide-react';

export default function ProfessorMaterialsPage() {
  return (
    <div className="professor-beta-locked">
      <section aria-labelledby="materials-coming-soon-title">
        <Lock size={32} aria-hidden="true" />
        <h1 id="materials-coming-soon-title">자료 개선 기능은 준비 중입니다</h1>
        <p>더 안정적인 결과를 제공하기 위해 기능을 다듬고 있습니다.<br />베타테스트 이후 공개됩니다.</p>
        <Link href="/professor">교수 홈으로 돌아가기</Link>
      </section>
    </div>
  );
}
