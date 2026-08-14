'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Menu, X, LogOut, ChevronDown, CalendarDays, UserCog } from 'lucide-react';
import { createBrowserClient } from '@/lib/db/browser';
import { planName } from '@/lib/payment/plans';
import './mobile-drawer.css';

// 학습 흐름 순서: 내신 대비와 CPX를 각각 독립 메뉴로 제공한다.
const NAV_ITEMS = [
  { label: '홈', href: '/dashboard' },
  { label: '내신 대비', href: '/notes', primary: true },
  { label: 'CPX', href: '/cpx', primary: true },
  { label: '내 문제집', href: '/library' },
  { label: '오답노트', href: '/wrong-notes' },
  { label: '요금제', href: '/plan' },
] as const;

// 해당 기능은 유지하되 학생용 메뉴에서만 임시로 숨긴다.
// 재공개할 때 이 목록에서 경로를 제거하면 된다.
const HIDDEN_STUDENT_NAV_HREFS = new Set(['/exam', '/mock']);

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
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const pendingMenuFocus = useRef<'first' | 'last' | null>(null);

  // 경로 변경 시 모바일 드로어 / 프로필 드롭다운 자동 닫기
  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      // 모달 드로어: Tab 을 드로어 내부에서 순환시켜 뒤 페이지로 새지 않게
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !drawerRef.current.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !drawerRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // 드로어 열림 → 닫기 버튼으로 포커스 이동, 닫힘 → 햄버거 버튼으로 복귀
  useEffect(() => {
    if (open) {
      drawerWasOpen.current = true;
      drawerCloseRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      hamburgerRef.current?.focus();
    }
  }, [open]);

  // 프로필 드롭다운: 바깥 클릭 / ESC 로 닫기 (ESC 는 트리거로 포커스 반환)
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        accountTriggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  // 팝오버가 키보드로 열렸으면 첫/마지막 menuitem 으로 포커스 이동 (menu 패턴)
  useEffect(() => {
    if (!menuOpen || !pendingMenuFocus.current) return;
    const items = accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items && items.length > 0) {
      (pendingMenuFocus.current === 'first' ? items[0] : items[items.length - 1]).focus();
    }
    pendingMenuFocus.current = null;
  }, [menuOpen]);

  function handleAccountTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    pendingMenuFocus.current = e.key === 'ArrowDown' ? 'first' : 'last';
    if (menuOpen) {
      const items = accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
      if (items && items.length > 0) {
        (e.key === 'ArrowDown' ? items[0] : items[items.length - 1]).focus();
      }
      pendingMenuFocus.current = null;
    } else {
      setMenuOpen(true);
    }
  }

  function handleAccountMenuKeyDown(e: React.KeyboardEvent) {
    const items = Array.from(
      accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (e.key === 'Tab') {
      setMenuOpen(false);
    }
  }

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

  const visibleNavItems = NAV_ITEMS.filter((item) => !HIDDEN_STUDENT_NAV_HREFS.has(item.href));
  const navItems = user.onboarded ? visibleNavItems : [ONBOARDING_NAV, ...visibleNavItems];

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const displayName = user.displayName ?? '사용자';
  const avatarInitial = user.displayName?.charAt(0)?.toUpperCase() ?? '?';
  const subtitle = user.schoolShortName
    ? `${user.schoolShortName} · ${gradeLabel(user.grade)}`
    : `${planName(user.planTier)} 플랜`;

  // 프로필 드롭다운 / 모바일 드로어 공통 메뉴 항목
  const MENU_ITEMS = [
    { label: '마이페이지', href: '/mypage', icon: CalendarDays },
    { label: '회원정보 수정', href: '/profile', icon: UserCog },
  ] as const;

  // 레퍼런스 로고(투명 배경 forest 심볼 + "Lecturelink"). logo-mark 기본 배경/그림자는 인라인으로 무효화.
  const Logo = () => (
    <Link href="/dashboard" className="logo" aria-label="LectureLink 홈">
      <span
        className="logo-mark"
        style={{ background: 'transparent', boxShadow: 'none', width: 40, height: 40 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/lecturelink-mark.png"
          alt="LectureLink 로고"
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </span>
      <span className="logo-text">LectureLink</span>
      <span className="beta">BETA</span>
    </Link>
  );

  return (
    <>
    <header className="header fixed top-0 inset-x-0 z-40">
      <div className="header-inner">
        {/* 좌측 로고 */}
        <Logo />

        {/* 가운데 메뉴 (데스크톱) — 900px 미만은 계정 메뉴가 잘려 햄버거로 전환 */}
        <nav className="nav hidden min-[900px]:flex" aria-label="주요 메뉴">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={clsx('primary' in item && item.primary && 'primary', isActive(item.href) && 'active')}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* 우측: 사용자 드롭다운 (데스크톱) */}
        <div className="account hidden min-[900px]:flex">
        <div className="relative" ref={menuRef}>
          <button
            ref={accountTriggerRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            onKeyDown={handleAccountTriggerKeyDown}
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
              <span className="text-[11px] text-[var(--color-muted)]">{subtitle}</span>
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
              ref={accountMenuRef}
              role="menu"
              onKeyDown={handleAccountMenuKeyDown}
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
                    aria-current={pathname === item.href ? 'page' : undefined}
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
          ref={hamburgerRef}
          onClick={() => setOpen(true)}
          aria-label="메뉴 열기"
          aria-expanded={open}
          className="min-[900px]:hidden w-11 h-11 flex items-center justify-center rounded-lg text-sage-800 hover:bg-[var(--color-sage-100)]"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>
    </header>

      {/* 모바일 드로어 — 헤더 밖 형제로 렌더링.
          (헤더의 backdrop-filter 가 fixed 자손의 containing block 이 되어
          배경막이 헤더 크기로 잘리는 문제를 피한다) */}
      {open && (
        <div
          className="ll-mobile-drawer-backdrop ll-student-mobile-drawer"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        className={clsx(
          'll-mobile-drawer ll-student-mobile-drawer',
          open && 'is-open',
        )}
        aria-label="학생 모바일 메뉴"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="ll-mobile-drawer-header">
          <Logo />
          <button
            ref={drawerCloseRef}
            onClick={() => setOpen(false)}
            aria-label="메뉴 닫기"
            className="ll-mobile-drawer-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="ll-mobile-drawer-nav">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={clsx(
                'll-mobile-drawer-link',
                isActive(item.href) && 'is-active',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ll-mobile-drawer-account">
            <div className="ll-mobile-drawer-avatar">
              {avatarInitial}
            </div>
            <div className="ll-mobile-drawer-identity">
              <b>{displayName}</b>
              <small>{subtitle}</small>
            </div>
          <div className="ll-mobile-drawer-actions">
          {MENU_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                className={clsx(
                  'll-mobile-drawer-action',
                  pathname === item.href && 'is-active',
                )}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="ll-mobile-drawer-logout"
          >
            <LogOut className="w-4 h-4" />
            {loggingOut ? '로그아웃 중...' : '로그아웃'}
          </button>
          </div>
        </div>
      </aside>
    </>
  );
}

