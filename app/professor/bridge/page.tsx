import { Suspense } from 'react';
import { PrerequisiteBridgeStudio } from '@/components/professor/PrerequisiteBridgeStudio';

export default function ProfessorBridgePage() {
  return <Suspense fallback={<div className="professor-empty">예습 인포그래픽 도구를 불러오는 중입니다.</div>}><PrerequisiteBridgeStudio /></Suspense>;
}
