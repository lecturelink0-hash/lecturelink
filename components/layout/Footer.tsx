'use client';

import Link from 'next/link';

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
  /** 클릭 시 이메일 앱으로 이동하기 전에 보여줄 안내 메시지 */
  notice?: string;
}

interface FooterColumn {
  title: string;
  links: FooterLink[];
}

const columns: FooterColumn[] = [
  {
    title: '서비스',
    links: [
      { label: '문제 만들기', href: '/notes' },
      { label: '국시 문제', href: '/exam' },
      { label: '내 문제집', href: '/library' },
      { label: '오답노트', href: '/wrong-notes' },
    ],
  },
  {
    title: '지원',
    links: [
      // 카카오톡 문의는 전용 페이지(/contact)에서 채널로 연결 — 채널 URL은 KAKAO_CHANNEL_URL(런타임 env).
      { label: '카카오톡 문의', href: '/contact' },
      { label: '문의하기', href: '/contact' },
      { label: '오류 신고', href: 'mailto:lecturelink0@gmail.com?subject=렉처링크 오류 신고', external: true, notice: '오류 신고를 위해 이메일 화면으로 이동합니다.' },
      { label: '피드백 보내기', href: 'mailto:lecturelink0@gmail.com?subject=렉처링크 피드백', external: true, notice: '피드백을 보내기 위해 이메일 화면으로 이동합니다.' },
    ],
  },
  {
    title: '약관',
    links: [
      { label: '이용약관', href: '/terms' },
      { label: '개인정보처리방침', href: '/privacy' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-grid">
          {/* 좌측 — 로고 + 한줄 설명 */}
          <div className="footer-brand">
            <Link className="logo" href="/dashboard">
              <span className="logo-mark"><BookIcon /></span><span className="logo-text">렉쳐링크</span>
            </Link>
            <p>
              강의자료를 바탕으로 의학 문제를 생성하고, 오답을 분석해 시험 대비를 돕는 학습 플랫폼입니다.
            </p>
          </div>

          {/* 우측 — 3컬럼 */}
          <div className="contents">
            {columns.map((col) => (
              <div key={col.title} className="footer-col">
                <h2>{col.title}</h2><ul>
                  {col.links.map((link) => (
                    <li key={link.label}>
                      {link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => {
                            if (link.notice) {
                              e.preventDefault();
                              window.alert(link.notice);
                              window.location.href = link.href;
                            }
                          }}
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* 하단 카피 */}
        <div className="footer-bottom">
          <p>렉쳐링크는 학습 보조 도구이며, 생성된 문항과 해설은 검토 후 학습에 활용해주세요.</p>
          <p>© 2026 렉쳐링크. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

function BookIcon() {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>;
}
