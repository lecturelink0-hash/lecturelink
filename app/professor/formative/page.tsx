import { Suspense } from 'react';
import { FormativeAssessmentStudio } from '@/components/faculty/FormativeAssessmentStudio';
export default function ProfessorFormativePage() { return <Suspense fallback={<div className="professor-empty">형성평가 도구를 불러오는 중입니다.</div>}><FormativeAssessmentStudio /></Suspense>; }
