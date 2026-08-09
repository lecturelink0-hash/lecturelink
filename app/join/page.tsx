import { Suspense } from 'react';
import { LiveStudentRunner } from '@/components/student/LiveStudentRunner';
export default function Page(){return <Suspense fallback={<main className="student-live">참여 화면을 준비하고 있습니다.</main>}><LiveStudentRunner/></Suspense>}
