'use client';

import { ErrorScreen } from '@/components/error/ErrorScreen';

// 루트 레이아웃 자체가 깨졌을 때의 최후 방어선. 루트 레이아웃을 대체하므로
// html/body 를 직접 렌더해야 하고, globals.css 없이도 보이도록 inline style 만 쓴다.
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0 }}>
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
