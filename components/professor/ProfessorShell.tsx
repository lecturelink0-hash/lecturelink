'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Lock, LogOut, Menu, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/db/browser';
import './professor.css';
import '@/components/layout/mobile-drawer.css';

const NAV = [
  { href: '/professor', label: '홈' },
  { href: '/professor/courses', label: '통합 관리' },
  { href: '/professor/bridge', label: '예습자료' },
  { href: '/professor/formative', label: '형성평가' },
  { href: '/professor/quality', label: '문항 검토' },
] as const;

export function ProfessorShell({ children, displayName, schoolName }: { children: React.ReactNode; displayName: string; schoolName: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setOpen(false); setAccountOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);
  useEffect(() => {
    if (!accountOpen) return;
    const close = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [accountOpen]);

  async function logout() {
    await createBrowserClient().auth.signOut();
    window.location.href = '/login';
  }

  const active = (href: string) => pathname === href || (href !== '/professor' && pathname.startsWith(`${href}/`));
  const logo = <Link href="/professor" className="professor-top-logo">{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/lecturelink-mark.png" alt="" /><b>Lecturelink</b><small>FACULTY</small></Link>;

  return (
    <div className="professor-app">
      <header className="professor-topbar"><div className="professor-topbar-inner">
        {logo}
        <nav className="professor-topnav" aria-label="교수 메뉴">
          {NAV.map((item) => <Link className={active(item.href) ? 'is-active' : ''} href={item.href} key={item.href}>{item.label}</Link>)}
          <span className="professor-nav-locked" aria-disabled="true" title="베타테스트 이후 공개됩니다">자료 개선 <Lock size={12} aria-hidden="true" /></span>
        </nav>
        <div className="professor-top-account" ref={accountRef}>
          <button type="button" onClick={() => setAccountOpen((value) => !value)} aria-expanded={accountOpen} aria-haspopup="menu">
            <span>{displayName.charAt(0)}</span><span><b>{displayName}</b><small>{schoolName ?? '교수 계정'}</small></span><ChevronDown size={18} />
          </button>
          {accountOpen && <div className="professor-account-menu" role="menu"><div><b>{displayName}</b><small>{schoolName ?? 'LectureLink 교수'}</small></div><Link href="/professor/mypage" className={active('/professor/mypage') ? 'is-active' : ''} role="menuitem"><UserRound size={19} />마이페이지</Link><button type="button" onClick={logout} role="menuitem"><LogOut size={19} />로그아웃</button></div>}
        </div>
        <button className="professor-menu-trigger" type="button" onClick={() => setOpen(true)} aria-label="메뉴 열기"><Menu size={25} /></button>
      </div></header>
      {open && <><button className="ll-mobile-drawer-backdrop" type="button" onClick={() => setOpen(false)} aria-label="메뉴 닫기" /><aside className="ll-mobile-drawer is-open" aria-label="교수 모바일 메뉴">
        <div className="ll-mobile-drawer-header">{logo}<button className="ll-mobile-drawer-close" type="button" onClick={() => setOpen(false)} aria-label="메뉴 닫기"><X size={24} /></button></div>
        <nav className="ll-mobile-drawer-nav">
          {NAV.map((item) => <Link className={`ll-mobile-drawer-link ${active(item.href) ? 'is-active' : ''}`} href={item.href} key={item.href}>{item.label}</Link>)}
          <span className="ll-mobile-drawer-locked" aria-disabled="true"><span>자료 개선 <Lock size={15} aria-hidden="true" /></span><small>베타테스트 이후 공개됩니다</small></span>
        </nav>
        <div className="ll-mobile-drawer-account"><span className="ll-mobile-drawer-avatar">{displayName.charAt(0)}</span><div className="ll-mobile-drawer-identity"><b>{displayName}</b><small>{schoolName ?? '교수 계정'}</small></div><div className="ll-mobile-drawer-actions"><Link className={`ll-mobile-drawer-action ${active('/professor/mypage') ? 'is-active' : ''}`} href="/professor/mypage"><UserRound size={19} />마이페이지</Link><button className="ll-mobile-drawer-logout" type="button" onClick={logout}><LogOut size={19} />로그아웃</button></div></div>
      </aside></>}
      <main className="professor-content">{children}</main>
    </div>
  );
}
