'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import styles from './onboarding.module.css';

interface School {
  id: string;
  name: string;
  short_name: string;
}

const GRADE_OPTIONS = [
  { value: 'pre_1', label: '예과 1학년' },
  { value: 'pre_2', label: '예과 2학년' },
  { value: 'med_1', label: '본과 1학년' },
  { value: 'med_2', label: '본과 2학년' },
  { value: 'med_3', label: '본과 3학년' },
  { value: 'med_4', label: '본과 4학년' },
] as const;

const PURPOSE_OPTIONS = [
  { value: 'naesin', label: '내신 대비', description: '학교 시험과 강의 복습' },
  { value: 'cpx', label: 'CPX 대비', description: '진료 수행과 실전 연습' },
  { value: 'other', label: '기타', description: '직접 목적 입력' },
] as const;

const CHANNEL_OPTIONS = ['학교 단톡방', '선후배 추천', '친구 추천', 'SNS/유튜브', '검색', '기타'] as const;

type Grade = typeof GRADE_OPTIONS[number]['value'];
type StudyPurpose = typeof PURPOSE_OPTIONS[number]['value'];

export default function OnboardingPage() {
  const [schools, setSchools] = useState<School[]>([]);
  const [selectedSchool, setSelectedSchool] = useState('');
  const [selectedGrade, setSelectedGrade] = useState<Grade>('med_2');
  const [studyPurpose, setStudyPurpose] = useState<StudyPurpose>('naesin');
  const [purposeDetail, setPurposeDetail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acquisitionChannel, setAcquisitionChannel] = useState('');
  const [loadingSchools, setLoadingSchools] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let active = true;

    Promise.all([
      api.get<School[]>('/api/schools'),
      api.get<{ displayName: string | null; accountType: 'student' | 'professor' }>('/api/me').catch(() => null),
    ])
      .then(([schoolList, me]) => {
        if (!active) return;
        if (me?.accountType === 'professor') {
          window.location.replace('/professor-onboarding');
          return;
        }
        setSchools(schoolList);
        if (me?.displayName && !me.displayName.includes('@')) setDisplayName(me.displayName);
      })
      .catch(() => {
        if (active) setLoadError('학교 목록을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
      })
      .finally(() => {
        if (active) setLoadingSchools(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const trimmedPurposeDetail = purposeDetail.trim();
  const canSubmit = Boolean(
    displayName.trim()
      && selectedSchool
      && (studyPurpose !== 'other' || trimmedPurposeDetail),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');

    if (!displayName.trim()) {
      setFormError('이름을 입력해 주세요.');
      return;
    }
    if (!selectedSchool) {
      setFormError('학교를 선택해 주세요.');
      return;
    }
    if (studyPurpose === 'other' && !trimmedPurposeDetail) {
      setFormError('기타 이용 목적을 입력해 주세요.');
      return;
    }

    setSubmitting(true);
    try {
      await api.patch('/api/me', { display_name: displayName.trim() });
      await api.post('/api/onboarding', {
        school_id: selectedSchool,
        grade: selectedGrade,
        study_purpose: studyPurpose,
        study_purpose_detail: studyPurpose === 'other' ? trimmedPurposeDetail : null,
        acquisition_channel: acquisitionChannel || null,
      });
      setCompleted(true);
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : '설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSubmitting(false);
    }
  }

  if (completed) {
    const learnerName = displayName.trim().includes('@')
      ? displayName.trim().split('@')[0]
      : displayName.trim();

    return (
      <section className={styles.completion} aria-labelledby="onboarding-complete-title">
        <span className={styles.completionIcon} aria-hidden="true">
          <CheckCircle2 strokeWidth={1.9} />
        </span>
        <h1 id="onboarding-complete-title">
          <span>{learnerName ? `${learnerName}님, ` : ''}준비가 끝났어요.</span>
          <br />바로 학습을 시작해보세요
        </h1>
        <p>입력한 학습 목적에 맞는 기능을 홈에서 바로 이용할 수 있습니다.</p>
        <div className={styles.completionActions}>
          <Button
            size="lg"
            className={styles.primaryButton}
            onClick={() => { window.location.href = '/dashboard'; }}
          >
            홈으로 이동
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </section>
    );
  }

  return (
    <div className={styles.page}>
      <Link href="/dashboard" className={styles.back}>
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        홈으로
      </Link>
      <header className={styles.pageHeader}>
        <span className={styles.eyebrow}>STEP 1 / 1 · 회원 정보 입력</span>
        <h1>
          <span>나에게 맞는 학습</span>을<br />시작해보세요
        </h1>
        <p>학교와 학년, 서비스 이용 목적만 알려주세요. 필요한 설정만 간단히 저장합니다.</p>
      </header>

      <form className={styles.formPanel} onSubmit={handleSubmit} noValidate>
        <div className={styles.formHeading}>
          <div>
            <h2>기본 정보</h2>
            <p>학습 경험을 준비하는 데 필요한 정보입니다.</p>
          </div>
        </div>

        <div className={styles.fieldGrid}>
          <Field label="이름" htmlFor="onboarding-name" required>
            <input
              id="onboarding-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="이름을 입력해 주세요"
              autoComplete="name"
              maxLength={50}
              className={styles.textInput}
            />
          </Field>

          <Field label="학교" required>
            <Select
              value={selectedSchool}
              onValueChange={setSelectedSchool}
              placeholder={loadingSchools ? '불러오는 중...' : '학교를 선택해 주세요'}
              ariaLabel="학교 선택"
              disabled={loadingSchools || Boolean(loadError)}
              className={styles.selectControl}
              options={schools.map((school) => ({ value: school.id, label: school.name }))}
            />
            {loadError && <small className={styles.fieldError}>{loadError}</small>}
          </Field>

          <Field label="학년" required>
            <Select
              value={selectedGrade}
              onValueChange={(value) => setSelectedGrade(value as Grade)}
              ariaLabel="학년 선택"
              className={styles.selectControl}
              options={GRADE_OPTIONS}
            />
          </Field>

          <Field label="알게 된 경로" hint="선택">
            <Select
              value={acquisitionChannel}
              onValueChange={setAcquisitionChannel}
              placeholder="선택해 주세요"
              ariaLabel="알게 된 경로 선택"
              className={styles.selectControl}
              options={CHANNEL_OPTIONS.map((channel) => ({ value: channel, label: channel }))}
            />
          </Field>
        </div>

        <fieldset className={styles.purposeFieldset}>
          <legend>
            서비스 이용 목적 <span aria-hidden="true">*</span>
          </legend>
          <div className={styles.purposeOptions} role="radiogroup" aria-label="서비스 이용 목적">
            {PURPOSE_OPTIONS.map((purpose) => {
              const selected = studyPurpose === purpose.value;
              return (
                <button
                  key={purpose.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={styles.purposeOption}
                  onClick={() => {
                    setStudyPurpose(purpose.value);
                    if (purpose.value !== 'other') setPurposeDetail('');
                  }}
                >
                  <span>
                    <strong>{purpose.label}</strong>
                    <small>{purpose.description}</small>
                  </span>
                  <i aria-hidden="true">{selected && <Check strokeWidth={2.5} />}</i>
                </button>
              );
            })}
          </div>

          {studyPurpose === 'other' && (
            <div className={styles.otherPurpose}>
              <label htmlFor="onboarding-purpose-detail">기타 이용 목적</label>
              <input
                id="onboarding-purpose-detail"
                type="text"
                value={purposeDetail}
                onChange={(event) => setPurposeDetail(event.target.value)}
                placeholder="예: 주관식 시험 대비"
                maxLength={100}
                className={styles.textInput}
                autoFocus
                required
              />
            </div>
          )}
        </fieldset>

        <div className={styles.formFooter}>
          <p id="onboarding-form-status" className={formError ? styles.formError : styles.formHint} role={formError ? 'alert' : undefined}>
            {formError || '필수 항목을 입력하면 학습을 시작할 수 있어요.'}
          </p>
          <Button
            type="submit"
            size="lg"
            loading={submitting}
            disabled={!canSubmit || loadingSchools || Boolean(loadError)}
            aria-describedby="onboarding-form-status"
            className={styles.primaryButton}
          >
            설정 완료하고 시작하기
            {!submitting && <ArrowRight aria-hidden="true" />}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
  htmlFor,
  required = false,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <span aria-hidden="true">*</span>}
        {hint && <small>{hint}</small>}
      </label>
      {children}
    </div>
  );
}
