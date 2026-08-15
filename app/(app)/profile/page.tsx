'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  GraduationCap,
  KeyRound,
  Mail,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api/client';
import { STUDY_SUBJECT_STORAGE_KEY, defaultSemester } from '@/lib/study-settings';
import { authErrorMessage } from '@/lib/auth/auth-error-message';
import {
  isValidPassword,
  PASSWORD_ERROR,
  PASSWORD_HINT,
  PASSWORD_MAX_LENGTH,
} from '@/lib/auth/password-policy';
import { createBrowserClient } from '@/lib/db/browser';
import { AccountDeletion } from '@/components/account/AccountDeletion';
import '@/components/faculty/formative-studio.css';
import '@/components/professor/professor.css';
import './profile.css';

const LOCAL_STUDENT_PREVIEW =
  process.env.NEXT_PUBLIC_LOCAL_STUDENT_UI_PREVIEW === 'true';

interface School {
  id: string;
  name: string;
  short_name: string;
}

interface MeProfile {
  displayName: string | null;
  school: { id: string; name: string; shortName: string } | null;
  grade: string | null;
}

interface SubjectOption {
  id: string;
  name: string;
}

interface StudySettingsRes {
  school_id: string | null;
  grade: string | null;
  semester: 'spring' | 'fall' | null;
  year: number | null;
}

const GRADE_OPTIONS = [
  { value: 'pre_1', label: '예과 1학년' },
  { value: 'pre_2', label: '예과 2학년' },
  { value: 'med_1', label: '본과 1학년' },
  { value: 'med_2', label: '본과 2학년' },
  { value: 'med_3', label: '본과 3학년' },
  { value: 'med_4', label: '본과 4학년' },
] as const;

type GradeValue = (typeof GRADE_OPTIONS)[number]['value'];

const PREVIEW_SCHOOLS: School[] = [
  ['경북대학교 의과대학', '경북대'],
  ['계명대학교 의과대학', '계명대'],
  ['대구가톨릭대학교 의과대학', '대구가톨릭대'],
  ['동국대학교 의과대학', '동국대'],
  ['영남대학교 의과대학', '영남대'],
  ['가천대학교 의과대학', '가천대'],
  ['가톨릭대학교 의과대학', '가톨릭대'],
  ['가톨릭관동대학교 의과대학', '가톨릭관동대'],
  ['강원대학교 의과대학', '강원대'],
  ['건국대학교 의과대학', '건국대'],
  ['건양대학교 의과대학', '건양대'],
  ['경상국립대학교 의과대학', '경상국립대'],
  ['경희대학교 의과대학', '경희대'],
  ['고려대학교 의과대학', '고려대'],
  ['고신대학교 의과대학', '고신대'],
  ['단국대학교 의과대학', '단국대'],
  ['동아대학교 의과대학', '동아대'],
  ['부산대학교 의과대학', '부산대'],
  ['서울대학교 의과대학', '서울대'],
  ['성균관대학교 의과대학', '성균관대'],
  ['순천향대학교 의과대학', '순천향대'],
  ['아주대학교 의과대학', '아주대'],
  ['연세대학교 의과대학', '연세대'],
  ['연세대학교 원주의과대학', '연세대(원주)'],
  ['울산대학교 의과대학', '울산대'],
  ['원광대학교 의과대학', '원광대'],
  ['을지대학교 의과대학', '을지대'],
  ['이화여자대학교 의과대학', '이화여대'],
  ['인제대학교 의과대학', '인제대'],
  ['인하대학교 의과대학', '인하대'],
  ['전남대학교 의과대학', '전남대'],
  ['전북대학교 의과대학', '전북대'],
  ['제주대학교 의과대학', '제주대'],
  ['조선대학교 의과대학', '조선대'],
  ['중앙대학교 의과대학', '중앙대'],
  ['차의과학대학교 의학전문대학원', '차의과학대'],
  ['충남대학교 의과대학', '충남대'],
  ['충북대학교 의과대학', '충북대'],
  ['한림대학교 의과대학', '한림대'],
  ['한양대학교 의과대학', '한양대'],
].map(([name, shortName], index) => ({
  id: `preview-medical-school-${index + 1}`,
  name,
  short_name: shortName,
}));

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  minLength,
  hint,
  className,
  invalid,
  feedbackId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder: string;
  minLength?: number;
  hint?: string;
  className?: string;
  invalid: boolean;
  feedbackId: string;
}) {
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [hintId, invalid ? feedbackId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <div className={`professor-password-field${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="professor-password-input">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          minLength={minLength}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          required
        />
        <button
          type="button"
          className="professor-password-toggle"
          onClick={() => setVisible((current) => !current)}
          aria-label={`${label} ${visible ? '숨기기' : '보기'}`}
          aria-pressed={visible}
        >
          {visible ? (
            <EyeOff size={19} aria-hidden="true" />
          ) : (
            <Eye size={19} aria-hidden="true" />
          )}
        </button>
      </div>
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}

function StudentProfileHeader() {
  return (
    <>
      <Link className="back" href="/dashboard">
        <ArrowLeft size={16} aria-hidden="true" />
        홈으로
      </Link>
      <header className="page-head professor-mypage-heading">
        <div>
          <span className="eyebrow">학생 도구 · 회원정보</span>
          <h1>
            <span className="headline-accent">회원 정보</span> 수정
          </h1>
          <p className="lead">
            학습 화면에 표시되는 이름과 소속, 로그인 정보를 확인하고 수정합니다.
          </p>
        </div>
        <span className="professor-faculty-status">
          <BadgeCheck size={19} aria-hidden="true" />
          학생 계정 활성
        </span>
      </header>
    </>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const [schools, setSchools] = useState<School[]>(
    LOCAL_STUDENT_PREVIEW ? PREVIEW_SCHOOLS : [],
  );
  const [displayName, setDisplayName] = useState(
    LOCAL_STUDENT_PREVIEW ? '김민준' : '',
  );
  const [selectedSchool, setSelectedSchool] = useState(
    LOCAL_STUDENT_PREVIEW ? PREVIEW_SCHOOLS[0].id : '',
  );
  const [selectedGrade, setSelectedGrade] = useState<GradeValue>('med_2');
  const [loading, setLoading] = useState(!LOCAL_STUDENT_PREVIEW);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(
    LOCAL_STUDENT_PREVIEW ? 'student.preview@lecturelink.local' : null,
  );
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [studySemester, setStudySemester] = useState<'spring' | 'fall'>(defaultSemester());
  const [studyYear, setStudyYear] = useState<number>(new Date().getFullYear());
  const [studySubject, setStudySubject] = useState('');
  const [studySaving, setStudySaving] = useState(false);
  const [studySavedName, setStudySavedName] = useState<string | null>(null);
  const [studyError, setStudyError] = useState<string | null>(null);
  useEffect(() => {
    if (LOCAL_STUDENT_PREVIEW) return;
    createBrowserClient()
      .auth.getUser()
      .then(({ data }) => setAuthEmail(data.user?.email ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (LOCAL_STUDENT_PREVIEW) return;
    Promise.all([
      api.get<School[]>('/api/schools'),
      api.get<MeProfile>('/api/me'),
    ])
      .then(([schoolList, me]) => {
        setSchools(schoolList);
        setDisplayName(me.displayName ?? '');
        if (me.school?.id) setSelectedSchool(me.school.id);
        if (me.grade) setSelectedGrade(me.grade as GradeValue);
      })
      .catch((caught) => {
        setLoadError(
          caught instanceof ApiError
            ? caught.message
            : '정보를 불러오지 못했습니다.',
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (LOCAL_STUDENT_PREVIEW) return;
    api
      .get<SubjectOption[]>('/api/subjects?with_sub_topics=false')
      .then(setSubjects)
      .catch(() => undefined);
    api
      .get<StudySettingsRes>('/api/me/study-settings')
      .then((settings) => {
        if (settings.semester) setStudySemester(settings.semester);
        if (settings.year) setStudyYear(settings.year);
      })
      .catch(() => undefined);
    const storedSubject = window.localStorage.getItem(STUDY_SUBJECT_STORAGE_KEY);
    if (storedSubject) setStudySubject(storedSubject);
  }, []);

  async function handleSubmit() {
    if (!selectedSchool || !displayName.trim()) return;
    setSubmitting(true);
    setSaved(false);
    try {
      if (LOCAL_STUDENT_PREVIEW) {
        setSaved(true);
        return;
      }
      await api.patch('/api/me', {
        display_name: displayName.trim(),
        school_id: selectedSchool,
        grade: selectedGrade,
      });
      setSaved(true);
      router.refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : '저장 중 오류가 발생했습니다.';
      window.alert(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function saveStudySettings() {
    if (!studySubject) return;
    setStudySaving(true);
    setStudyError(null);
    setStudySavedName(null);
    try {
      if (LOCAL_STUDENT_PREVIEW) {
        setStudySavedName('미리보기 과목');
        return;
      }
      const res = await api.put<{ cohort_id: string; subject_name: string }>(
        '/api/me/study-settings',
        { semester: studySemester, year: studyYear, subject_id: studySubject },
      );
      window.localStorage.setItem(STUDY_SUBJECT_STORAGE_KEY, studySubject);
      setStudySavedName(res.subject_name);
    } catch (caught) {
      setStudyError(
        caught instanceof ApiError
          ? caught.message
          : '저장 중 오류가 발생했습니다.',
      );
    } finally {
      setStudySaving(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
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
      setPasswordError('로그인 이메일을 확인하지 못했습니다.');
      return;
    }

    setPasswordSaving(true);
    try {
      if (!LOCAL_STUDENT_PREVIEW) {
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
      }
      setCurrentPassword('');
      setPassword('');
      setPasswordConfirm('');
      setPasswordMessage(
        '비밀번호를 변경했습니다. 다음 로그인부터 새 비밀번호를 사용해주세요.',
      );
    } catch (caught) {
      setPasswordError(authErrorMessage(caught));
    } finally {
      setPasswordSaving(false);
    }
  }

  const selectedSchoolInfo = schools.find(
    (school) => school.id === selectedSchool,
  );
  const selectedGradeLabel =
    GRADE_OPTIONS.find((grade) => grade.value === selectedGrade)?.label ??
    '등록 정보 없음';

  if (loading || loadError) {
    return (
      <div className="professor-app student-profile-app">
        <div className="faculty-studio ll-upload-page professor-mypage student-account-page">
          <StudentProfileHeader />
          <section className="studio-section card pad professor-profile-panel student-profile-state" aria-live="polite">
            {loading ? (
              <>
                <span className="student-profile-spinner" aria-hidden="true" />
                <p>회원 정보를 불러오는 중입니다.</p>
              </>
            ) : (
              <>
                <AlertCircle size={22} className="text-[var(--color-error)]" aria-hidden="true" />
                <div>
                  <h2>회원 정보를 불러오지 못했습니다.</h2>
                  <p className="text-[var(--color-error)]">{loadError}</p>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="professor-app student-profile-app">
      <div className="faculty-studio ll-upload-page professor-mypage student-account-page">
        <StudentProfileHeader />

        <div className="studio-workbench professor-mypage-grid">
          <main className="studio-main professor-mypage-main">
            <section
              className="studio-section card pad professor-profile-panel"
              aria-labelledby="student-profile-title"
            >
              <div className="professor-profile-title">
                <span>
                  <UserRound size={22} aria-hidden="true" />
                </span>
                <div>
                  <h2 id="student-profile-title">기본 정보</h2>
                  <p>학습 화면과 개인화 설정에 사용할 정보를 수정하세요.</p>
                </div>
              </div>

              <div className="professor-profile-form">
                <div className="student-profile-field-grid">
                  <div className="professor-form-field is-full">
                    <label htmlFor="student-display-name">표시 이름</label>
                    <input
                      id="student-display-name"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="이름을 입력하세요"
                      maxLength={50}
                      autoComplete="name"
                    />
                    <small>학습 기록과 활동 화면에 표시되는 이름입니다.</small>
                  </div>

                  {authEmail !== null && (
                    <div className="professor-readonly-field is-full">
                      <span>
                        <Mail size={17} aria-hidden="true" />
                        로그인 이메일
                      </span>
                      <b>{authEmail}</b>
                      <small>로그인 이메일은 이 화면에서 변경할 수 없습니다.</small>
                    </div>
                  )}

                  <div className="student-profile-divider is-full" />

                  <div className="professor-form-field">
                    <label htmlFor="student-school">
                      <Building2 size={17} aria-hidden="true" />
                      소속 의과대학
                    </label>
                    <select
                      id="student-school"
                      value={selectedSchool}
                      onChange={(event) => setSelectedSchool(event.target.value)}
                      required
                    >
                      <option value="">소속 의과대학 선택</option>
                      {schools.map((school) => (
                        <option value={school.id} key={school.id}>
                          {school.name}
                        </option>
                      ))}
                    </select>
                    <small>대한민국 전국 40개 의과대학·의학전문대학원 중에서 선택할 수 있습니다.</small>
                  </div>

                  <div className="professor-form-field">
                    <label htmlFor="student-grade">
                      <GraduationCap size={17} aria-hidden="true" />
                      학년
                    </label>
                    <select
                      id="student-grade"
                      value={selectedGrade}
                      onChange={(event) =>
                        setSelectedGrade(event.target.value as GradeValue)
                      }
                    >
                      {GRADE_OPTIONS.map((grade) => (
                        <option key={grade.value} value={grade.value}>
                          {grade.label}
                        </option>
                      ))}
                    </select>
                  </div>

                </div>

                <div className="professor-profile-submit">
                  <div aria-live="polite">
                    {saved && (
                      <p className="is-success">
                        <CheckCircle2 size={16} aria-hidden="true" />
                        변경한 학생 정보를 저장했습니다.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="professor-primary"
                    onClick={() => void handleSubmit()}
                    disabled={submitting || !selectedSchool || !displayName.trim()}
                  >
                    <Save size={18} aria-hidden="true" />
                    {submitting ? '저장 중...' : '변경사항 저장'}
                  </button>
                </div>
              </div>
            </section>

            <section
              className="studio-section card pad professor-profile-panel"
              aria-labelledby="student-study-settings-title"
            >
              <div className="professor-profile-title">
                <span>
                  <BookOpen size={22} aria-hidden="true" />
                </span>
                <div>
                  <h2 id="student-study-settings-title">학습 설정</h2>
                  <p>
                    학기와 수강 과목을 저장하면 같은 학교·학년 선배들의 시험 범위
                    데이터와 연결되어 추천 풀이에 반영됩니다.
                  </p>
                </div>
              </div>

              <div className="professor-profile-form">
                <div className="student-profile-field-grid">
                  <div className="professor-form-field">
                    <label htmlFor="student-study-year">연도</label>
                    <select
                      id="student-study-year"
                      value={studyYear}
                      onChange={(event) => setStudyYear(Number(event.target.value))}
                    >
                      {Array.from(
                        new Set([
                          studyYear,
                          new Date().getFullYear(),
                          new Date().getFullYear() + 1,
                        ]),
                      )
                        .sort()
                        .map((year) => (
                          <option key={year} value={year}>
                            {year}년
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="professor-form-field">
                    <label htmlFor="student-study-semester">학기</label>
                    <select
                      id="student-study-semester"
                      value={studySemester}
                      onChange={(event) =>
                        setStudySemester(event.target.value as 'spring' | 'fall')
                      }
                    >
                      <option value="spring">1학기</option>
                      <option value="fall">2학기</option>
                    </select>
                  </div>

                  <div className="professor-form-field is-full">
                    <label htmlFor="student-study-subject">
                      <BookOpen size={17} aria-hidden="true" />
                      수강 과목
                    </label>
                    <select
                      id="student-study-subject"
                      value={studySubject}
                      onChange={(event) => setStudySubject(event.target.value)}
                    >
                      <option value="">수강 과목 선택</option>
                      {subjects.map((subject) => (
                        <option key={subject.id} value={subject.id}>
                          {subject.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      저장하면 이번 학기 코호트(같은 학교·학년·과목 집단)에
                      배정됩니다. 소속 학교와 학년을 먼저 저장해야 합니다.
                    </small>
                  </div>
                </div>

                <div className="professor-profile-submit">
                  <div aria-live="polite">
                    {studySavedName && (
                      <p className="is-success">
                        <CheckCircle2 size={16} aria-hidden="true" />
                        {studySavedName} 학습 설정을 저장했습니다.
                      </p>
                    )}
                    {studyError && (
                      <p className="is-error">
                        <AlertCircle size={16} aria-hidden="true" />
                        {studyError}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="professor-primary"
                    onClick={() => void saveStudySettings()}
                    disabled={studySaving || !studySubject}
                  >
                    <Save size={18} aria-hidden="true" />
                    {studySaving ? '저장 중...' : '학습 설정 저장'}
                  </button>
                </div>
              </div>
            </section>

            <section
              className="studio-section card pad professor-profile-panel professor-security-panel"
              aria-labelledby="student-password-title"
            >
              <div className="professor-profile-title">
                <span>
                  <KeyRound size={22} aria-hidden="true" />
                </span>
                <div>
                  <h2 id="student-password-title">비밀번호 변경</h2>
                  <p>로그인에 사용할 새 비밀번호를 설정합니다.</p>
                </div>
              </div>
              <form
                onSubmit={changePassword}
                className="professor-profile-form"
                aria-labelledby="student-password-title"
              >
                <div className="professor-password-grid">
                  <PasswordField
                    id="student-current-password"
                    className="is-current"
                    label="현재 비밀번호"
                    value={currentPassword}
                    onChange={setCurrentPassword}
                    autoComplete="current-password"
                    placeholder="본인 확인을 위해 입력"
                    invalid={Boolean(passwordError)}
                    feedbackId="student-password-feedback"
                  />
                  <PasswordField
                    id="student-new-password"
                    label="새 비밀번호"
                    value={password}
                    onChange={setPassword}
                    autoComplete="new-password"
                    placeholder="새 비밀번호 입력"
                    minLength={8}
                    hint={PASSWORD_HINT}
                    invalid={Boolean(passwordError)}
                    feedbackId="student-password-feedback"
                  />
                  <PasswordField
                    id="student-new-password-confirm"
                    label="새 비밀번호 확인"
                    value={passwordConfirm}
                    onChange={setPasswordConfirm}
                    autoComplete="new-password"
                    placeholder="한 번 더 입력"
                    minLength={8}
                    invalid={Boolean(passwordError)}
                    feedbackId="student-password-feedback"
                  />
                </div>
                <div className="professor-profile-submit">
                  <div id="student-password-feedback" aria-live="polite">
                    {passwordMessage && (
                      <p className="is-success">{passwordMessage}</p>
                    )}
                    {passwordError && (
                      <p className="is-error">{passwordError}</p>
                    )}
                  </div>
                  <button
                    type="submit"
                    className="professor-primary"
                    disabled={
                      passwordSaving ||
                      !currentPassword ||
                      !password ||
                      !passwordConfirm
                    }
                  >
                    <KeyRound size={18} aria-hidden="true" />
                    {passwordSaving ? '변경 중...' : '비밀번호 변경'}
                  </button>
                </div>
              </form>
            </section>

            <AccountDeletion variant="student" />
          </main>

          <aside
            className="faculty-summary summary summary-hero card pad professor-account-summary"
            aria-label="학생 계정 안내"
          >
            <div className="card-head professor-account-summary-head">
              <h2>학생 계정</h2>
              <p>
                학습 범위와 문제 풀이 기록을 바탕으로 학습 계획과 취약 영역을 관리할 수 있습니다.
              </p>
            </div>
            <dl className="summary-list professor-account-summary-list">
              <div className="summary-item professor-account-summary-item">
                <dt>계정 상태</dt>
                <dd>학습 계정 활성</dd>
              </div>
              <div className="summary-item professor-account-summary-item">
                <dt>소속</dt>
                <dd title={selectedSchoolInfo?.name}>
                  {selectedSchoolInfo?.short_name ?? '등록 정보 없음'}
                </dd>
              </div>
              <div className="summary-item professor-account-summary-item">
                <dt>학년</dt>
                <dd>{selectedGradeLabel}</dd>
              </div>
            </dl>
            <Link
              className="primary-btn professor-account-summary-cta"
              href="/mypage"
            >
              <BookOpen size={18} aria-hidden="true" />
              학습 현황으로 이동
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <p className="summary-note note professor-account-summary-note">
              <ShieldCheck size={15} aria-hidden="true" />
              계정 정보와 학습 기록은 안전하게 보호됩니다.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
