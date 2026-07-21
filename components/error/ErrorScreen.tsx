'use client';

import { useEffect, useState } from 'react';

/**
 * 전역 오류 화면 (app/error.tsx · app/global-error.tsx 공용)
 *
 * 새 배포 직후 이전 빌드를 물고 있던 탭이 사라진 청크를 로드하다 실패하면
 * (deployment skew) "Application error" 죽은 화면이 뜬다. 이 경우 새 HTML 을
 * 받아오면 해결되므로 1회 자동 새로고침으로 복구한다.
 *
 * global-error 는 루트 레이아웃(globals.css) 밖에서 렌더되므로 inline style 만 쓴다.
 */

// Safari 는 "Importing a module script failed.", Chrome 은 ChunkLoadError /
// "Failed to fetch dynamically imported module" 형태로 스큐 실패를 보고한다.
const STALE_BUILD_PATTERN =
  /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

const RELOAD_GUARD_KEY = 'll-stale-build-reload-at';
const RELOAD_GUARD_MS = 30_000;

function isStaleBuildError(error: Error): boolean {
  return STALE_BUILD_PATTERN.test(`${error.name}: ${error.message}`);
}

interface ErrorScreenProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function ErrorScreen({ error, reset }: ErrorScreenProps) {
  const [autoReloading, setAutoReloading] = useState(false);

  useEffect(() => {
    if (!isStaleBuildError(error)) return;
    // 프라이빗 모드 등 sessionStorage 접근 불가 환경에서도 화면 자체는 떠야 한다.
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    } catch {
      return;
    }
    if (Date.now() - lastReloadAt < RELOAD_GUARD_MS) return; // 새로고침 루프 방지
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      return;
    }
    setAutoReloading(true);
    window.location.reload();
  }, [error]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: '#f7f6ef',
        fontFamily:
          "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          background: '#ffffff',
          border: '1px solid #e3e0d3',
          borderRadius: '16px',
          padding: '36px 32px',
          textAlign: 'center',
        }}
      >
        {autoReloading ? (
          <>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#1f2e28' }}>
              새 버전을 불러오는 중입니다...
            </h1>
            <p style={{ margin: '10px 0 0', fontSize: '14px', lineHeight: 1.6, color: '#6b7a72' }}>
              업데이트가 배포되어 화면을 새로고침하고 있어요.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#1f2e28' }}>
              일시적인 오류가 발생했습니다
            </h1>
            <p style={{ margin: '10px 0 0', fontSize: '14px', lineHeight: 1.6, color: '#6b7a72' }}>
              새 버전 배포 직후 이전 화면이 남아 있으면 생길 수 있어요.
              <br />
              새로고침하면 대부분 해결됩니다.
            </p>
            <div
              style={{
                marginTop: '24px',
                display: 'flex',
                gap: '8px',
                justifyContent: 'center',
                flexWrap: 'wrap',
              }}
            >
              <button
                onClick={() => window.location.reload()}
                style={{
                  height: '44px',
                  padding: '0 22px',
                  borderRadius: '10px',
                  border: 'none',
                  background: '#1f5c43',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                새로고침
              </button>
              <button
                onClick={reset}
                style={{
                  height: '44px',
                  padding: '0 22px',
                  borderRadius: '10px',
                  border: '1px solid #c9debe',
                  background: '#ffffff',
                  color: '#1f5c43',
                  fontSize: '14px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                다시 시도
              </button>
              <button
                onClick={() => {
                  window.location.href = '/';
                }}
                style={{
                  height: '44px',
                  padding: '0 22px',
                  borderRadius: '10px',
                  border: '1px solid #e3e0d3',
                  background: '#ffffff',
                  color: '#6b7a72',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                홈으로
              </button>
            </div>
            {error.digest && (
              <p style={{ margin: '18px 0 0', fontSize: '11px', color: '#a8b3ac' }}>
                오류 코드: {error.digest}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
