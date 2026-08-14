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
    title: '학습',
    links: [
      { label: '내신 대비', href: '/notes' },
      { label: 'CPX', href: '/cpx' },
      { label: '내 문제집', href: '/library' },
      { label: '오답노트', href: '/wrong-notes' },
      { label: '요금제', href: '/plan' },
    ],
  },
  {
    title: '계정 및 지원',
    links: [
      { label: '마이페이지', href: '/mypage' },
      { label: '회원정보 수정', href: '/profile' },
      { label: '자주 묻는 질문', href: '/faq' },
      { label: '문의하기', href: '/contact' },
    ],
  },
  {
    title: '약관',
    links: [
      { label: '이용약관', href: '/terms' },
      { label: '개인정보처리방침', href: '/privacy' },
      { label: '환불·해지 정책', href: '/refund' },
    ],
  },
];

export function Footer({ variant = 'student' }: { variant?: 'student' | 'faculty' }) {
  const footerColumns: FooterColumn[] = variant === 'faculty'
    ? [
        {
          title: '수업 준비',
          links: [
            { label: '교수 홈', href: '/professor' },
            { label: '통합 관리', href: '/professor/courses' },
            { label: '예습자료', href: '/professor/bridge' },
            { label: '형성평가', href: '/professor/formative' },
          ],
        },
        {
          title: '검토 및 지원',
          links: [
            { label: '문항 검토', href: '/professor/quality' },
            { label: '마이페이지', href: '/professor/mypage' },
            { label: '문의하기', href: '/contact' },
          ],
        },
        columns[2],
      ]
    : columns;

  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-grid">
          {/* 좌측 — 로고 + 한줄 설명 */}
          <div className="footer-brand">
            <Link className="logo" href={variant === 'faculty' ? '/professor' : '/dashboard'}>
              <span className="logo-mark"><BookIcon /></span><span className="logo-text">LectureLink</span>
            </Link>
            <p>
              {variant === 'faculty'
                ? '강의자료에서 수업 준비 자료를 만들고, 학생의 이해를 확인하는 의학 교육 지원 플랫폼입니다.'
                : '강의자료를 바탕으로 의학 문제를 생성하고, 오답을 분석해 시험 대비를 돕는 학습 플랫폼입니다.'}
            </p>
          </div>

          {/* 우측 — 3컬럼 */}
          <div className="contents">
            {footerColumns.map((col) => (
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
          <p>LectureLink는 학습 보조 도구이며, 생성된 문항과 해설은 검토 후 학습에 활용해주세요.</p>
          <p>© 2026 LectureLink. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

function BookIcon() {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>;
}
