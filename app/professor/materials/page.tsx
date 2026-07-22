import { Suspense } from 'react';
import { MaterialImprovementStudio } from '@/components/professor/MaterialImprovementStudio';
export default function ProfessorMaterialsPage(){return <Suspense fallback={<div className="professor-empty">강의자료 도구를 불러오는 중입니다.</div>}><MaterialImprovementStudio/></Suspense>}
