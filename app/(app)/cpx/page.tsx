import type { Metadata } from 'next';
import CpxPractice from '@/components/cpx/CpxPractice';

export const metadata: Metadata = { title: 'CPX 진료 연습' };

export default function CpxPage() {
  return <CpxPractice />;
}
