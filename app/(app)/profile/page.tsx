'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { createBrowserClient } from '@/lib/db/browser';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  CheckCircle2,
  AlertCircle,
  UserRound,
  GraduationCap,
  CalendarRange,
  Info,
  Mail,
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

// 필드 공통 스타일 — 포커스 시 그린 보더 + 키보드 포커스 링
const fieldClass =
  'w-full h-11 rounded-xl border border-[var(--color-border)] bg-white px-3.5 text-[15px] text-sage-800 transition-colors focus:border-sage-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-sage-400 focus-visible:ring-offset-1';

const HEADER_EYEBROW = (
  <>
    <UserRound className="w-3.5 h-3.5" strokeWidth={2.4} />
    계정
  </>
);
const HEADER_DESC =
  '회원가입 시 입력한 학교·학년·학기 등 정보를 확인하고 수정할 수 있습니다.';

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

  async function handleRegisterEmail() {
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

        // 과목은 프로필에 단일 저장되지 않으므로 첫 과목을 기본 선택
        if (subs.length > 0) setSelectedSubject(subs[0].id);
      })
      .catch((e) => {
        setLoadError(e instanceof ApiError ? e.message : '정보를 불러오지 못했습니다.');
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit() {
    if (!selectedSchool || !selectedSubject) return;
    setSubmitting(true);
    setSaved(false);
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
      // 저장 후 마이페이지로 이동
      router.push('/mypage');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '저장 중 오류가 발생했습니다.';
      alert(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <PageHeader eyebrow={HEADER_EYEBROW} title="회원 정보 수정" description={HEADER_DESC} />
        <div className="ll-card flex items-center justify-center h-64 text-[var(--color-muted)]">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-sage-600 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-sm">불러오는 중...</p>
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <PageHeader eyebrow={HEADER_EYEBROW} title="회원 정보 수정" description={HEADER_DESC} />
        <div className="ll-card p-6 flex items-center gap-3">
          <span className="ll-chip ll-chip-gold" style={{ width: '2.25rem', height: '2.25rem', borderRadius: '12px' }}>
            <AlertCircle className="w-4 h-4" strokeWidth={2} />
          </span>
          <span className="text-sm text-[var(--color-warn)]">{loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ll-system-page">
      <PageHeader eyebrow={HEADER_EYEBROW} title="회원 정보 수정" description={HEADER_DESC} />

      <div className="max-w-3xl">
        {/* ── 이메일 등록/변경 카드 (카카오 사용자 등 합성 이메일 대상 강조) ── */}
        {authEmail !== null && (
          <div className={`ll-card p-7 sm:p-8 mb-6 ${isSyntheticEmail ? 'border-[var(--color-primary)]' : ''}`}>
            <div className="flex items-start gap-3 mb-5">
              <span className="ll-chip" style={{ width: '2.75rem', height: '2.75rem' }}>
                <Mail className="w-5 h-5" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-sage-800 tracking-tight">{isSyntheticEmail ? '이메일 등록' : '이메일'}</h2>
                <p className="text-sm text-[var(--color-muted)] mt-1 leading-relaxed">
                  {isSyntheticEmail
                    ? '카카오로 가입하셨어요. 비밀번호 재설정·중요 알림 메일을 받으려면 이메일을 등록해 주세요.'
                    : <>현재 이메일: <b className="text-sage-800">{authEmail}</b></>}
                </p>
              </div>
            </div>
            {emailSent ? (
              <div className="rounded-lg bg-[var(--color-sage-100)] px-4 py-3 text-sm text-sage-800 leading-relaxed">
                입력하신 주소로 <b>확인 메일</b>을 보냈습니다. 메일 안의 링크를 누르면 이메일 등록이 완료됩니다.
                <br />몇 분 내에 오지 않으면 <b>스팸함·프로모션함</b>도 확인해 주세요.
              </div>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder={isSyntheticEmail ? '이메일 주소 입력' : '변경할 이메일 주소'}
                    className={fieldClass}
                  />
                  <Button onClick={handleRegisterEmail} loading={emailSubmitting} disabled={!newEmail.trim()}>
                    {isSyntheticEmail ? '등록' : '변경'}
                  </Button>
                </div>
                {emailError && <p className="mt-2 text-sm text-[var(--color-warn)]">{emailError}</p>}
              </>
            )}
          </div>
        )}

        {/* ── 폼 카드 ── */}
        <div className="ll-card p-7 sm:p-8">
          {/* 카드 헤더 */}
          <div className="flex items-start gap-3 mb-8">
            <span className="ll-chip" style={{ width: '2.75rem', height: '2.75rem' }}>
              <UserRound className="w-5 h-5" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-sage-800 tracking-tight">기본 정보</h2>
              <p className="text-sm text-[var(--color-muted)] mt-1 leading-relaxed">
                학교·학년·학기 정보를 최신 상태로 유지하면 같은 코호트 선배들의 학습 데이터를 정확히 반영할 수 있습니다.
              </p>
            </div>
          </div>

          <div className="space-y-8">
            {/* 프로필 */}
            <FieldGroup icon={<UserRound className="w-4 h-4" strokeWidth={2} />} title="프로필">
              <Field label="이름" className="sm:col-span-2">
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="이름을 입력하세요"
                  maxLength={50}
                  className={fieldClass}
                />
              </Field>
            </FieldGroup>

            <div className="h-px bg-[var(--color-border)]" />

            {/* 소속 */}
            <FieldGroup icon={<GraduationCap className="w-4 h-4" strokeWidth={2} />} title="소속">
              <Field label="학교">
                <select
                  className={fieldClass}
                  value={selectedSchool}
                  onChange={(e) => setSelectedSchool(e.target.value)}
                >
                  <option value="">선택...</option>
                  {schools.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="학년">
                <select
                  className={fieldClass}
                  value={selectedGrade}
                  onChange={(e) => setSelectedGrade(e.target.value as GradeValue)}
                >
                  {GRADE_OPTIONS.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </Field>
            </FieldGroup>

            <div className="h-px bg-[var(--color-border)]" />

            {/* 학기 · 과목 */}
            <FieldGroup icon={<CalendarRange className="w-4 h-4" strokeWidth={2} />} title="학기 · 과목">
              <Field label="연도">
                <select
                  className={fieldClass}
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                >
                  {YEAR_OPTIONS.map((y) => (
                    <option key={y} value={y}>
                      {y}년
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="학기">
                <select
                  className={fieldClass}
                  value={selectedSemester}
                  onChange={(e) => setSelectedSemester(e.target.value as 'spring' | 'fall')}
                >
                  <option value="spring">{selectedYear}년 1학기</option>
                  <option value="fall">{selectedYear}년 2학기</option>
                </select>
              </Field>

              <Field label="수강 과목" className="sm:col-span-2">
                <select
                  className={fieldClass}
                  value={selectedSubject}
                  onChange={(e) => setSelectedSubject(e.target.value)}
                >
                  <option value="">선택...</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </FieldGroup>
          </div>
        </div>

        {/* ── 안내 노트 ── */}
        <div className="ll-card ll-tint-soft mt-4 p-5 flex items-start gap-3">
          <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem', borderRadius: '12px' }}>
            <Info className="w-4 h-4" strokeWidth={2} />
          </span>
          <p className="text-sm text-sage-800 leading-relaxed">
            학교·학년·과목을 변경하면 새 학기 코호트가 자동으로 연결됩니다. 시험 범위 세부 설정은
            <strong className="font-semibold"> 마이페이지</strong>와 각 문제 풀이 화면에서 이어서 조정할 수 있습니다.
          </p>
        </div>

        {/* ── 저장 ── */}
        <div className="flex items-center justify-end gap-3 mt-6">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm font-semibold text-sage-700">
              <CheckCircle2 className="w-4 h-4" />
              저장되었습니다
            </span>
          )}
          <Button
            variant="accent"
            size="lg"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!selectedSchool || !selectedSubject}
          >
            <CheckCircle2 className="w-4 h-4" />
            변경사항 저장
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function FieldGroup({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2.5 mb-4">
        <span className="ll-chip" style={{ width: '2rem', height: '2rem', borderRadius: '10px' }}>
          {icon}
        </span>
        <h3 className="text-sm font-bold text-sage-800 tracking-tight">{title}</h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-[13px] font-semibold text-sage-800 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
