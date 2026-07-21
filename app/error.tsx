'use client';

import { ErrorScreen } from '@/components/error/ErrorScreen';

// 페이지/세그먼트 렌더 중 발생한 클라이언트 예외를 잡는 전역 error boundary.
// 배포 스큐(청크 404)는 ErrorScreen 이 1회 자동 새로고침으로 복구한다.
export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen {...props} />;
}
