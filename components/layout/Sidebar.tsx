'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Menu, X, LogOut, ChevronDown, CalendarDays, UserCog } from 'lucide-react';
import { createBrowserClient } from '@/lib/db/browser';

// 레퍼런스(lecturelink_connected_site) 순서 준수. CPX는 국시 대비 안으로 통합돼 상단 메뉴에서 제외.
// feature: 레퍼런스처럼 골드 그라데이션 + ✦로 강조되는 핵심 메뉴(내신 대비·국시 대비).
const NAV_ITEMS = [
  { label: '홈', href: '/dashboard' },
  { label: '내신 대비', href: '/notes', feature: true },
  { label: '국시 대비', href: '/exam', feature: true },
  { label: '내 문제집', href: '/library' },
  { label: '오답노트', href: '/wrong-notes' },
  { label: '모의고사', href: '/mock' },
  { label: '요금제', href: '/plan' },
] as const;

const ONBOARDING_NAV = {
  label: '온보딩',
  href: '/onboarding',
} as const;

interface SidebarProps {
  user: {
    displayName: string | null;
    schoolShortName: string | null;
    grade: string | null;
    planTier: string;
    onboarded: boolean;
  };
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 경로 변경 시 모바일 드로어 / 프로필 드롭다운 자동 닫기
  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // 프로필 드롭다운: 바깥 클릭 / ESC 로 닫기
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      const supabase = createBrowserClient();
      await supabase.auth.signOut();
    } finally {
      window.location.href = '/login';
    }
  }

  const gradeLabel = (g: string | null) => {
    if (!g) return '';
    const map: Record<string, string> = {
      pre_1: '예과 1학년',
      pre_2: '예과 2학년',
      med_1: '본과 1학년',
      med_2: '본과 2학년',
      med_3: '본과 3학년',
      med_4: '본과 4학년',
    };
    return map[g] ?? g;
  };

  const planLabel: Record<string, string> = {
    free: 'Free',
    lite: '내신 대비',
    standard: '국가고시 대비',
    pro: '통합형',
  };

  const navItems = user.onboarded ? NAV_ITEMS : [ONBOARDING_NAV, ...NAV_ITEMS];

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const displayName = user.displayName ?? '사용자';
  const avatarInitial = user.displayName?.charAt(0)?.toUpperCase() ?? '?';
  const subtitle = user.schoolShortName
    ? `${user.schoolShortName} · ${gradeLabel(user.grade)}`
    : `${planLabel[user.planTier] ?? user.planTier} 플랜`;

  // 프로필 드롭다운 / 모바일 드로어 공통 메뉴 항목
  const MENU_ITEMS = [
    { label: '마이페이지', href: '/mypage', icon: CalendarDays },
    { label: '회원정보 수정', href: '/profile', icon: UserCog },
  ] as const;

  // 레퍼런스 로고(투명 배경 forest 심볼 + "Lecturelink"). logo-mark 기본 배경/그림자는 인라인으로 무효화.
  const Logo = () => (
    <Link href="/dashboard" className="logo" aria-label="Lecturelink 홈">
      <span
        className="logo-mark"
        style={{ background: 'transparent', boxShadow: 'none', width: 40, height: 40 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/lecturelink-mark.png"
          alt="Lecturelink 로고"
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </span>
      <span className="logo-text">Lecturelink</span>
      <span className="beta">BETA</span>
    </Link>
  );

  return (
    <header className="header fixed top-0 inset-x-0 z-40">
      <div className="header-inner">
        {/* 좌측 로고 */}
        <Logo />

        {/* 가운데 메뉴 (데스크톱) — 활성 밑줄 */}
        <nav className="nav hidden md:flex" aria-label="주요 메뉴">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx('feature' in item && item.feature && 'feature', isActive(item.href) && 'active')}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* 우측: 사용자 드롭다운 (데스크톱) */}
        <div className="account hidden md:flex">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="내 계정 메뉴"
            className={clsx(
              'flex items-center gap-2 rounded-lg pl-2 pr-1.5 py-1.5 transition-colors hover:bg-[var(--color-sage-100)]',
              (menuOpen || pathname === '/mypage' || pathname === '/profile') && 'bg-[var(--color-sage-100)]',
            )}
          >
            <span className="avatar">
              {avatarInitial}
            </span>
            <span className="flex flex-col leading-tight text-left">
              <span className="text-[13px] font-semibold text-sage-800">{displayName}</span>
              <span className="text-[10px] text-[var(--color-muted)]">{subtitle}</span>
            </span>
            <ChevronDown
              className={clsx(
                'w-4 h-4 text-[var(--color-muted)] transition-transform',
                menuOpen && 'rotate-180',
              )}
            />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-[var(--color-border)] bg-white shadow-lg py-1.5 z-50"
            >
              <div className="px-3 py-2 border-b border-[var(--color-border)] mb-1">
                <div className="text-[13px] font-semibold text-sage-800 truncate">{displayName}</div>
                <div className="text-[11px] text-[var(--color-muted)] truncate">{subtitle}</div>
              </div>
              {MENU_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    className={clsx(
                      'flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg text-[13px] transition-colors',
                      pathname === item.href
                        ? 'text-sage-800 font-semibold bg-[var(--color-sage-100)]'
                        : 'text-sage-800 hover:bg-[var(--color-sage-100)]',
                    )}
                  >
                    <Icon className="w-4 h-4 text-sage-600" />
                    {item.label}
                  </Link>
                );
              })}
              <div className="border-t border-[var(--color-border)] mt-1 pt-1 px-1">
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  role="menuitem"
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-[var(--color-muted)] hover:text-sage-800 hover:bg-[var(--color-sage-100)] transition-colors disabled:opacity-50"
                >
                  <LogOut className="w-4 h-4" />
                  {loggingOut ? '로그아웃 중...' : '로그아웃'}
                </button>
              </div>
            </div>
          )}
        </div>
        </div>

        {/* 모바일 메뉴 버튼 */}
        <button
          onClick={() => setOpen(true)}
          aria-label="메뉴 열기"
          className="md:hidden w-9 h-9 flex items-center justify-center rounded-lg text-sage-800 hover:bg-[var(--color-sage-100)]"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* 모바일 드로어 */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={clsx(
          'md:hidden fixed inset-y-0 right-0 w-72 bg-white border-l border-[var(--color-border)] z-50 flex flex-col transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="h-14 flex items-center justify-between px-4 border-b border-[var(--color-border)]">
          <Logo />
          <button
            onClick={() => setOpen(false)}
            aria-label="메뉴 닫기"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-sage-800 hover:bg-[var(--color-sage-100)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-3 overflow-y-auto">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'block px-3 py-2.5 rounded-lg mb-0.5 text-[14px] transition-colors',
                isActive(item.href)
                  ? 'text-sage-800 font-bold bg-[var(--color-sage-100)]'
                  : 'text-[var(--color-muted)] font-medium hover:bg-[var(--color-sage-100)]',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="p-3 mt-auto space-y-2 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2.5 px-1 py-2">
            <div className="w-8 h-8 rounded-full bg-sage-600 text-white flex items-center justify-center text-[12px] font-bold">
              {avatarInitial}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-sage-800 truncate">{displayName}</div>
              <div className="text-[10px] text-[var(--color-muted)] truncate">{subtitle}</div>
            </div>
          </div>
          {MENU_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] transition-colors',
                  pathname === item.href
                    ? 'text-sage-800 font-bold bg-[var(--color-sage-100)]'
                    : 'text-sage-800 font-medium hover:bg-[var(--color-sage-100)]',
                )}
              >
                <Icon className="w-4 h-4 text-sage-600" />
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full flex items-center justify-center gap-2 h-9 rounded-lg border border-[var(--color-border)] text-[12px] font-medium text-[var(--color-muted)] hover:text-sage-800 hover:bg-[var(--color-sage-100)] transition-colors disabled:opacity-50"
          >
            <LogOut className="w-3.5 h-3.5" />
            {loggingOut ? '로그아웃 중...' : '로그아웃'}
          </button>
        </div>
      </aside>
    </header>
  );
}

