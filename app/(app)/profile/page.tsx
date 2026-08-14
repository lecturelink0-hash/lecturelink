'use client';

import '@/components/professor/professor.css';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { createBrowserClient } from '@/lib/db/browser';
import { authErrorMessage } from '@/lib/auth/auth-error-message';
import { AccountDeletion } from '@/components/account/AccountDeletion';
import {
  isValidPassword,
  PASSWORD_ERROR,
  PASSWORD_HINT,
  PASSWORD_MAX_LENGTH,
} from '@/lib/auth/password-policy';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarRange,
  Eye,
  EyeOff,
  GraduationCap,
  KeyRound,
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

// 비밀번호 입력칸 + 표시/숨김(눈동자) 토글. 스타일은 professor.css의
// .professor-profile-form input 을 그대로 받고, 토글 버튼만 우측에 겹쳐 놓는다.
function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  autoComplete: string;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minLength={minLength}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        style={{ paddingRight: 44 }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '비밀번호 숨기기' : '비밀번호 표시'}
        aria-pressed={visible}
        style={{
          position: 'absolute',
          top: '50%',
          right: 7,
          transform: 'translateY(-50%)',
          width: 34,
          height: 34,
          display: 'grid',
          placeItems: 'center',
          padding: 0,
          border: 0,
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--p-muted)',
          cursor: 'pointer',
        }}
      >
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </div>
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

  // 로그인 이메일은 표시 전용 — 이 페이지에서 변경할 수 없다.
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const isSyntheticEmail = !!authEmail && authEmail.endsWith(SYNTHETIC_EMAIL_SUFFIX);

  // 비밀번호 변경 (교수용 마이페이지와 동일한 플로우)
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    createBrowserClient().auth.getUser().then(({ data }) => {
      setAuthEmail(data.user?.email ?? null);
    }).catch(() => {});
  }, []);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage(null);
    setPasswordError(null);
    if (!isValidPassword(password)) {
      setPasswordError(PASSWORD_ERROR);
      return;
    }
    if (password !== passwordConfirm) {
      setPasswordError('새 비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    if (!currentPassword) {
      setPasswordError('현재 비밀번호를 입력해주세요.');
      return;
    }
    if (!authEmail) {
      setPasswordError('로그인 정보를 확인하지 못했습니다. 새로고침 후 다시 시도해주세요.');
      return;
    }

    setPasswordSaving(true);
    try {
      const supabase = createBrowserClient();
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: authEmail,
        password: currentPassword,
      });
      if (reauthError) {
        setPasswordError(authErrorMessage(reauthError));
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setCurrentPassword('');
      setPassword('');
      setPasswordConfirm('');
      setPasswordMessage('비밀번호를 변경했습니다. 다음 로그인부터 새 비밀번호를 사용해주세요.');
    } catch (caught) {
      setPasswordError(authErrorMessage(caught));
    } finally {
      setPasswordSaving(false);
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

            {/* 카카오(합성 이메일) 계정은 비밀번호가 없어 재인증이 불가능하므로 섹션 비노출.
                authEmail 로드 전에는 렌더하지 않아 카카오 계정에서의 깜빡임을 방지한다. */}
            {authEmail !== null && !isSyntheticEmail && (
              <>
              <div className="professor-profile-divider" />
              <div className="professor-profile-title is-security">
                <span><KeyRound size={22} aria-hidden="true" /></span>
                <div>
                  <h2 id="student-password-title">비밀번호 변경</h2>
                  <p>로그인에 사용할 새 비밀번호를 설정합니다.</p>
                </div>
              </div>
              <form onSubmit={changePassword} className="professor-profile-form" aria-labelledby="student-password-title">
                <div className="professor-password-grid">
                  <label>
                    <span>현재 비밀번호</span>
                    <PasswordInput
                      value={currentPassword}
                      onChange={setCurrentPassword}
                      autoComplete="current-password"
                      placeholder="본인 확인을 위해 입력"
                    />
                  </label>
                  <label>
                    <span>새 비밀번호</span>
                    <PasswordInput
                      value={password}
                      onChange={setPassword}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder={PASSWORD_HINT}
                    />
                  </label>
                  <label>
                    <span>새 비밀번호 확인</span>
                    <PasswordInput
                      value={passwordConfirm}
                      onChange={setPasswordConfirm}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="한 번 더 입력"
                    />
                  </label>
                </div>
                <div className="professor-profile-submit">
                  <div aria-live="polite">
                    {passwordMessage && <p className="is-success">{passwordMessage}</p>}
                    {passwordError && <p className="is-error">{passwordError}</p>}
                  </div>
                  <button
                    type="submit"
                    className="professor-secondary"
                    disabled={passwordSaving || !currentPassword || !password || !passwordConfirm}
                  >
                    <KeyRound size={18} aria-hidden="true" />
                    {passwordSaving ? '변경 중...' : '비밀번호 변경'}
                  </button>
                </div>
              </form>
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
