'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { createBrowserClient } from '@/lib/db/browser';
import { authErrorMessage } from '@/lib/auth/auth-error-message';
import { AccountDeletion } from '@/components/account/AccountDeletion';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
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
  CalendarDays,
  Eye,
  EyeOff,
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

// 학생 폼 공통 규격 — 마이페이지 일정 추가 폼과 동일한 스타일
const INPUT_CLS =
  'w-full h-11 text-sm border border-[var(--color-line-strong)] rounded-lg px-3 bg-white text-sage-800 focus:outline-none focus:ring-1 focus:ring-sage-400 placeholder:text-[var(--color-muted)]';
const LABEL_CLS = 'block text-xs font-medium text-sage-700 mb-1';

// 비밀번호 입력칸 + 표시/숨김(눈동자) 토글.
function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  autoComplete: string;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minLength={minLength}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        className={`${INPUT_CLS} pr-11`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '비밀번호 숨기기' : '비밀번호 표시'}
        aria-pressed={visible}
        className="absolute top-1/2 right-1 -translate-y-1/2 w-9 h-9 grid place-items-center rounded-lg text-[var(--color-muted)] hover:text-sage-700 transition-colors"
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
      <div className="ll-system-page">
        <PageHeader title="회원정보 수정" description={HEADER_DESC} />
        <Card>
          <p className={`text-sm ${loadError ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'}`}>
            {loadError ?? '불러오는 중...'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="ll-system-page">
      <Link
        href="/mypage"
        className="inline-flex items-center gap-1 py-2 text-[13px] font-semibold text-[var(--color-muted)] hover:text-sage-800 transition-colors"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        마이페이지로
      </Link>
      <PageHeader
        className="mt-2"
        title="회원정보 수정"
        description={HEADER_DESC}
        action={
          <Badge variant="default">
            <BadgeCheck size={13} aria-hidden="true" />
            학생 계정
          </Badge>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 items-start">
        <Card
          icon={<UserRound className="w-5 h-5" strokeWidth={2} />}
          title="기본 정보"
          description="학교·학년·학기 정보를 입력하면 현재 학습 과정에 맞는 학습 범위가 적용됩니다."
        >
          <form onSubmit={handleSubmit} className="space-y-3" aria-label="기본 정보 수정">
            <div>
              <label htmlFor="profile-name" className={LABEL_CLS}>이름</label>
              <input
                id="profile-name"
                name="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="이름을 입력하세요"
                maxLength={50}
                autoComplete="name"
                className={INPUT_CLS}
              />
            </div>

            {/* 로그인 이메일 — 표시 전용 */}
            <div className="ll-tint rounded-lg px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-sage-700">
                <Mail size={14} aria-hidden="true" />
                로그인 이메일
              </p>
              <p className="mt-0.5 text-sm font-semibold text-sage-800 break-all">
                {isSyntheticEmail ? '등록된 이메일 없음 (카카오 로그인)' : authEmail || '이메일 정보 없음'}
              </p>
            </div>

            <div>
              <label htmlFor="profile-school" className={LABEL_CLS}>학교</label>
              <select
                id="profile-school"
                value={selectedSchool}
                onChange={(event) => setSelectedSchool(event.target.value)}
                required
                className={INPUT_CLS}
              >
                <option value="">선택...</option>
                {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor="profile-grade" className={LABEL_CLS}>학년</label>
              <select
                id="profile-grade"
                value={selectedGrade}
                onChange={(event) => setSelectedGrade(event.target.value as GradeValue)}
                className={INPUT_CLS}
              >
                {GRADE_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor="profile-year" className={LABEL_CLS}>연도 · 학기</label>
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  id="profile-year"
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(Number(event.target.value))}
                  aria-label="연도"
                  className={INPUT_CLS}
                >
                  {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}년</option>)}
                </select>
                <select
                  value={selectedSemester}
                  onChange={(event) => setSelectedSemester(event.target.value as 'spring' | 'fall')}
                  aria-label="학기"
                  className={INPUT_CLS}
                >
                  <option value="spring">{selectedYear}년 1학기</option>
                  <option value="fall">{selectedYear}년 2학기</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="profile-subject" className={LABEL_CLS}>수강 과목</label>
              <select
                id="profile-subject"
                value={selectedSubject}
                onChange={(event) => setSelectedSubject(event.target.value)}
                required
                className={INPUT_CLS}
              >
                <option value="">현재 수강 중인 과목 선택...</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                선택한 과목 기준으로 학습 범위가 설정됩니다.
              </p>
            </div>

            <div aria-live="polite">
              {saved && (
                <p className="text-xs font-semibold text-sage-700">저장되었습니다. 마이페이지로 이동합니다.</p>
              )}
              {formError && <p className="text-xs text-[var(--color-warn)]">{formError}</p>}
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              fullWidth
              loading={submitting}
              disabled={submitting || !selectedSchool || !selectedSubject}
            >
              <Save size={18} aria-hidden="true" />
              변경사항 저장
            </Button>
          </form>

          {/* 카카오(합성 이메일) 계정은 비밀번호가 없어 재인증이 불가능하므로 섹션 비노출.
              authEmail 로드 전에는 렌더하지 않아 카카오 계정에서의 깜빡임을 방지한다. */}
          {authEmail !== null && !isSyntheticEmail && (
            <div className="mt-6 pt-5 border-t border-[var(--color-border)]">
              <div className="flex items-start gap-3 mb-4">
                <span className="ll-chip">
                  <KeyRound className="w-5 h-5" strokeWidth={2} />
                </span>
                <div>
                  <h2 id="student-password-title" className="text-base font-bold text-sage-800 tracking-tight">
                    비밀번호 변경
                  </h2>
                  <p className="text-sm text-[var(--color-muted)] mt-1">
                    로그인에 사용할 새 비밀번호를 설정합니다.
                  </p>
                </div>
              </div>
              <form onSubmit={changePassword} aria-labelledby="student-password-title" className="space-y-3">
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <div>
                    <label htmlFor="pw-current" className={LABEL_CLS}>현재 비밀번호</label>
                    <PasswordInput
                      id="pw-current"
                      value={currentPassword}
                      onChange={setCurrentPassword}
                      autoComplete="current-password"
                      placeholder="본인 확인을 위해 입력"
                    />
                  </div>
                  <div>
                    <label htmlFor="pw-new" className={LABEL_CLS}>새 비밀번호</label>
                    <PasswordInput
                      id="pw-new"
                      value={password}
                      onChange={setPassword}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder={PASSWORD_HINT}
                    />
                  </div>
                  <div>
                    <label htmlFor="pw-confirm" className={LABEL_CLS}>새 비밀번호 확인</label>
                    <PasswordInput
                      id="pw-confirm"
                      value={passwordConfirm}
                      onChange={setPasswordConfirm}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="한 번 더 입력"
                    />
                  </div>
                </div>
                <div aria-live="polite">
                  {passwordMessage && (
                    <p className="text-xs font-semibold text-sage-700">{passwordMessage}</p>
                  )}
                  {passwordError && <p className="text-xs text-[var(--color-warn)]">{passwordError}</p>}
                </div>
                <Button
                  type="submit"
                  variant="secondary"
                  size="md"
                  fullWidth
                  loading={passwordSaving}
                  disabled={passwordSaving || !currentPassword || !password || !passwordConfirm}
                >
                  <KeyRound size={18} aria-hidden="true" />
                  비밀번호 변경
                </Button>
              </form>
            </div>
          )}
        </Card>

        <aside aria-label="계정 안내">
          <Card>
            <ShieldCheck className="w-6 h-6 text-sage-600" aria-hidden="true" />
            <h2 className="mt-3 text-base font-bold text-sage-800 tracking-tight">학생 계정</h2>
            <p className="mt-1.5 text-sm text-[var(--color-muted)] leading-relaxed">
              학교·학년·과목을 변경하면 해당 조건에 맞는 학습 설정이 자동으로 적용됩니다.
              시험 범위는 마이페이지 또는 문제 풀이 화면에서 언제든 변경할 수 있습니다.
            </p>
            <dl className="mt-4 pt-4 border-t border-[var(--color-border)] space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--color-muted)]">소속</dt>
                <dd className="font-semibold text-sage-800 text-right">{schoolShortName ?? '등록 정보 없음'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--color-muted)]">학년</dt>
                <dd className="font-semibold text-sage-800 text-right">{gradeLabel ?? '등록 정보 없음'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--color-muted)]">학기</dt>
                <dd className="font-semibold text-sage-800 text-right tnum">
                  {selectedYear}년 {selectedSemester === 'spring' ? '1학기' : '2학기'}
                </dd>
              </div>
            </dl>
            <Link
              href="/mypage"
              className="mt-5 inline-flex w-full items-center justify-center gap-1.5 h-11 rounded-xl border border-[var(--color-border)] bg-white text-sm font-bold text-sage-700 hover:bg-[var(--color-sage-100)] hover:border-[var(--color-line-strong)] transition-colors"
            >
              <CalendarDays size={18} aria-hidden="true" />
              마이페이지로 이동
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </Card>
        </aside>
      </div>

      <AccountDeletion />
    </div>
  );
}
