'use client';

import '@/components/professor/professor.css';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { createBrowserClient } from '@/lib/db/browser';
import { AccountDeletion } from '@/components/account/AccountDeletion';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  GraduationCap,
  Mail,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react';

// 카카오 커스텀 로그인 사용자의 합성 이메일 도메인 (수신 불가) — 실제 이메일 등록 유도 대상.
const SYNTHETIC_EMAIL_SUFFIX = '@kakao.users.lecturelink.kro.kr';

// ─── Types ─────────────────────────────────────────────────────────────────

interface School {
  id: string;
  name: string;
  short_name: string;
}

interface Subject {
  id: string;
  code: string;
  name: string;
}

// /api/me 응답 (session.profile 형태)
interface MeProfile {
  displayName: string | null;
  school: { id: string; name: string; shortName: string } | null;
  grade: string | null;
  currentSemester: 'spring' | 'fall' | null;
  currentYear: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const GRADE_OPTIONS = [
  { value: 'pre_1', label: '예과 1학년' },
  { value: 'pre_2', label: '예과 2학년' },
  { value: 'med_1', label: '본과 1학년' },
  { value: 'med_2', label: '본과 2학년' },
  { value: 'med_3', label: '본과 3학년' },
  { value: 'med_4', label: '본과 4학년' },
] as const;

type GradeValue = (typeof GRADE_OPTIONS)[number]['value'];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1];

const HEADER_DESC =
  '회원가입 시 입력한 학교·학년·학기 등 정보를 확인하고 수정할 수 있습니다.';

// 교수용 마이페이지(professor.css)와 동일한 룩을 학생 레이아웃 안에서 재사용하기 위한
// 스코프 래퍼 — `.professor-app`은 --p-* 변수 정의용으로만 쓰고 셸 배경/높이는 무효화.
const SKIN_WRAPPER_STYLE = { minHeight: 'auto', background: 'transparent' } as const;

function PageHeading() {
  return (
    <header className="professor-mypage-heading">
      <div>
        <span className="eyebrow">계정 · 회원정보</span>
        <h1>
          <span className="headline-accent">회원 정보</span> 수정
        </h1>
        <p className="lead">{HEADER_DESC}</p>
      </div>
      <span className="professor-faculty-status">
        <BadgeCheck size={19} aria-hidden="true" />
        학생 계정
      </span>
    </header>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter();

  const [schools, setSchools] = useState<School[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);

  const [displayName, setDisplayName] = useState('');
  const [selectedSchool, setSelectedSchool] = useState('');
  const [selectedGrade, setSelectedGrade] = useState<GradeValue>('med_2');
  const [selectedSemester, setSelectedSemester] = useState<'spring' | 'fall'>('spring');
  const [selectedYear, setSelectedYear] = useState(CURRENT_YEAR);
  const [selectedSubject, setSelectedSubject] = useState('');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 이메일 등록/변경 (특히 카카오 커스텀 로그인 사용자)
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState('');
  const isSyntheticEmail = !!authEmail && authEmail.endsWith(SYNTHETIC_EMAIL_SUFFIX);

  useEffect(() => {
    createBrowserClient().auth.getUser().then(({ data }) => {
      setAuthEmail(data.user?.email ?? null);
    }).catch(() => {});
  }, []);

  async function handleRegisterEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const em = newEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      setEmailError('올바른 이메일 주소를 입력해 주세요.');
      return;
    }
    if (em.endsWith(SYNTHETIC_EMAIL_SUFFIX)) {
      setEmailError('사용할 수 없는 주소입니다.');
      return;
    }
    setEmailSubmitting(true);
    setEmailError('');
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.updateUser(
        { email: em },
        { emailRedirectTo: `${window.location.origin}/auth/callback` },
      );
      if (error) {
        setEmailError(error.message.includes('registered') ? '이미 사용 중인 이메일입니다.' : '이메일 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      setEmailSent(true);
    } finally {
      setEmailSubmitting(false);
    }
  }

  // 초기 로드: 학교·과목 목록 + 현재 프로필 프리필
  useEffect(() => {
    Promise.all([
      api.get<School[]>('/api/schools'),
      api.get<Subject[]>('/api/subjects?with_sub_topics=false'),
      api.get<MeProfile>('/api/me'),
    ])
      .then(([sch, subs, me]) => {
        setSchools(sch);
        setSubjects(subs);

        setDisplayName(me.displayName ?? '');
        if (me.school?.id) setSelectedSchool(me.school.id);
        if (me.grade) setSelectedGrade(me.grade as GradeValue);
        if (me.currentSemester) setSelectedSemester(me.currentSemester);
        if (me.currentYear) setSelectedYear(me.currentYear);

        // 과목은 프로필에 단일 저장되지 않아 현재 값을 알 수 없다.
        // 임의로 첫 과목을 프리필하면 저장만 해도 의도치 않게 과목(코호트)이 바뀌므로
        // 빈 값으로 두고 사용자가 직접 선택하게 한다(선택 전에는 저장 버튼 비활성).
      })
      .catch((e) => {
        setLoadError(e instanceof ApiError ? e.message : '정보를 불러오지 못했습니다.');
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSchool || !selectedSubject) return;
    setSubmitting(true);
    setSaved(false);
    setFormError(null);
    try {
      // 이름 변경은 PATCH /api/me
      const trimmedName = displayName.trim();
      if (trimmedName) {
        await api.patch('/api/me', { display_name: trimmedName });
      }

      // 학교·학년·학기·연도·과목 업데이트는 기존 온보딩 API 재사용
      await api.post('/api/onboarding', {
        school_id: selectedSchool,
        grade: selectedGrade,
        semester: selectedSemester,
        year: selectedYear,
        subject_id: selectedSubject,
      });

      setSaved(true);
      // 성공 메시지를 잠깐 보여준 뒤 마이페이지로 이동
      window.setTimeout(() => router.push('/mypage'), 1200);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : '저장 중 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  const schoolShortName = schools.find((s) => s.id === selectedSchool)?.short_name ?? null;
  const gradeLabel = GRADE_OPTIONS.find((g) => g.value === selectedGrade)?.label ?? null;

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading || loadError) {
    return (
      <div className="professor-app" style={SKIN_WRAPPER_STYLE}>
        <div className="professor-mypage">
          <PageHeading />
          <div className="professor-mypage-grid">
            <section className="professor-profile-panel">
              <p style={{ margin: 0, color: loadError ? '#913b3b' : 'var(--p-muted)', fontSize: 14 }}>
                {loadError ?? '불러오는 중...'}
              </p>
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="professor-app" style={SKIN_WRAPPER_STYLE}>
      <div className="professor-mypage">
        <Link className="back" href="/mypage">
          <ArrowLeft size={16} aria-hidden="true" />
          마이페이지로
        </Link>
        <PageHeading />

        <div className="professor-mypage-grid">
          <section className="professor-profile-panel" aria-labelledby="student-profile-title">
            <div className="professor-profile-title">
              <span>
                <UserRound size={22} aria-hidden="true" />
              </span>
              <div>
                <h2 id="student-profile-title">기본 정보</h2>
                <p>학교·학년·학기 정보를 입력하면 현재 학습 과정에 맞는 학습 범위가 적용됩니다.</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="professor-profile-form">
              <label>
                <span>이름</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="이름을 입력하세요"
                  maxLength={50}
                  autoComplete="name"
                />
              </label>
              <div className="professor-readonly-field">
                <span>
                  <Mail size={17} aria-hidden="true" />
                  로그인 이메일
                </span>
                <b>{isSyntheticEmail ? '등록된 이메일 없음 (카카오 로그인)' : authEmail || '이메일 정보 없음'}</b>
                {isSyntheticEmail && <small>아래 ‘이메일 등록’에서 알림을 받을 이메일을 등록할 수 있습니다.</small>}
              </div>
              <label>
                <span><Building2 size={17} aria-hidden="true" />학교</span>
                <select value={selectedSchool} onChange={(event) => setSelectedSchool(event.target.value)} required>
                  <option value="">선택...</option>
                  {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>
                <span><GraduationCap size={17} aria-hidden="true" />학년</span>
                <select value={selectedGrade} onChange={(event) => setSelectedGrade(event.target.value as GradeValue)}>
                  {GRADE_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                </select>
              </label>
              <label>
                <span><CalendarRange size={17} aria-hidden="true" />연도 · 학기</span>
                <div className="professor-password-grid">
                  <select value={selectedYear} onChange={(event) => setSelectedYear(Number(event.target.value))} aria-label="연도">
                    {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}년</option>)}
                  </select>
                  <select value={selectedSemester} onChange={(event) => setSelectedSemester(event.target.value as 'spring' | 'fall')} aria-label="학기">
                    <option value="spring">{selectedYear}년 1학기</option>
                    <option value="fall">{selectedYear}년 2학기</option>
                  </select>
                </div>
              </label>
              <label>
                <span><BookOpen size={17} aria-hidden="true" />수강 과목</span>
                <select value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} required>
                  <option value="">현재 수강 중인 과목 선택...</option>
                  {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <small>선택한 과목 기준으로 학습 범위가 설정됩니다.</small>
              </label>

              <div className="professor-profile-submit">
                <div aria-live="polite">
                  {saved && <p className="is-success">저장되었습니다. 마이페이지로 이동합니다.</p>}
                  {formError && <p className="is-error">{formError}</p>}
                </div>
                <button
                  type="submit"
                  className="professor-primary"
                  disabled={submitting || !selectedSchool || !selectedSubject}
                >
                  <Save size={18} aria-hidden="true" />
                  {submitting ? '저장 중...' : '변경사항 저장'}
                </button>
              </div>
            </form>

            {authEmail !== null && (
              <>
                <div className="professor-profile-divider" />
                <div className="professor-profile-title is-security">
                  <span><Mail size={22} aria-hidden="true" /></span>
                  <div>
                    <h2 id="student-email-title">{isSyntheticEmail ? '이메일 등록' : '이메일 변경'}</h2>
                    <p>
                      {isSyntheticEmail
                        ? '카카오로 가입하셨어요. 비밀번호 재설정·중요 알림 메일을 받으려면 이메일을 등록해 주세요.'
                        : '로그인과 알림에 사용할 이메일 주소를 변경합니다.'}
                    </p>
                  </div>
                </div>
                {emailSent ? (
                  <div className="professor-profile-form" aria-live="polite">
                    <div className="professor-readonly-field">
                      <span>
                        <CheckCircle2 size={17} aria-hidden="true" />
                        확인 메일 발송됨
                      </span>
                      <b>입력하신 주소로 확인 메일을 보냈습니다. 메일 안의 링크를 누르면 등록이 완료됩니다.</b>
                      <small>몇 분 내에 오지 않으면 스팸함·프로모션함도 확인해 주세요.</small>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleRegisterEmail} className="professor-profile-form" aria-labelledby="student-email-title">
                    <label>
                      <span>{isSyntheticEmail ? '등록할 이메일 주소' : '변경할 이메일 주소'}</span>
                      <input
                        type="email"
                        value={newEmail}
                        onChange={(event) => setNewEmail(event.target.value)}
                        placeholder="이메일 주소 입력"
                        autoComplete="email"
                      />
                    </label>
                    <div className="professor-profile-submit">
                      <div aria-live="polite">
                        {emailError && <p className="is-error">{emailError}</p>}
                      </div>
                      <button
                        type="submit"
                        className="professor-secondary"
                        disabled={emailSubmitting || !newEmail.trim()}
                      >
                        <Mail size={18} aria-hidden="true" />
                        {emailSubmitting ? '처리 중...' : isSyntheticEmail ? '이메일 등록' : '이메일 변경'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </section>

          <aside className="professor-account-summary" aria-label="계정 안내">
            <div>
              <ShieldCheck size={24} aria-hidden="true" />
              <h2>학생 계정</h2>
              <p>
                학교·학년·과목을 변경하면 해당 조건에 맞는 학습 설정이 자동으로 적용됩니다.
                시험 범위는 마이페이지 또는 문제 풀이 화면에서 언제든 변경할 수 있습니다.
              </p>
            </div>
            <dl>
              <div>
                <dt>소속</dt>
                <dd>{schoolShortName ?? '등록 정보 없음'}</dd>
              </div>
              <div>
                <dt>학년</dt>
                <dd>{gradeLabel ?? '등록 정보 없음'}</dd>
              </div>
              <div>
                <dt>학기</dt>
                <dd>{selectedYear}년 {selectedSemester === 'spring' ? '1학기' : '2학기'}</dd>
              </div>
            </dl>
            <Link href="/mypage">
              <CalendarDays size={18} aria-hidden="true" />
              마이페이지로 이동
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </aside>
        </div>

        <AccountDeletion />
      </div>
    </div>
  );
}
