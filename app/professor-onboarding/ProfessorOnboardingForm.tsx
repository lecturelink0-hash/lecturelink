'use client';

import Image from 'next/image';
import { ArrowRight, Building2, CheckCircle2, UserRound } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';

type MedicalSchool = { id: string; name: string; short_name: string };

const CHANNEL_OPTIONS = ['학교 관계자 소개', '동료 교수 추천', '학생 추천', 'SNS/유튜브', '검색', '기타'] as const;

export function ProfessorOnboardingForm({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName.includes('@') ? '' : initialName);
  const [schoolId, setSchoolId] = useState('');
  const [channel, setChannel] = useState('');
  const [schools, setSchools] = useState<MedicalSchool[]>([]);
  const [schoolsLoading, setSchoolsLoading] = useState(true);
  const [schoolsError, setSchoolsError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSchools = useCallback(async () => {
    setSchoolsLoading(true);
    setSchoolsError(false);
    try {
      const response = await fetch('/api/schools?type=medical');
      if (!response.ok) throw new Error();
      const payload = (await response.json()) as { data?: MedicalSchool[] };
      setSchools(payload.data ?? []);
    } catch {
      setSchoolsError(true);
    } finally {
      setSchoolsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSchools(); }, [loadSchools]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName || !schoolId || !channel) {
      setError('이름, 소속 대학, 알게 된 경로를 모두 입력해 주세요.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/professor-onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          school_id: schoolId,
          acquisition_channel: channel,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? '교수 정보를 저장하지 못했습니다.');
      }
      window.location.href = '/professor';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '교수 정보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="faculty-onboarding">
      <header className="faculty-onboarding-topbar">
        <span className="faculty-onboarding-brand">
          <Image src="/lecturelink-mark.png" width={40} height={40} alt="" priority />
          <b>LectureLink</b>
          <small>FACULTY</small>
        </span>
      </header>

      <div className="faculty-onboarding-layout">
        <section className="faculty-onboarding-intro">
          <CheckCircle2 aria-hidden="true" />
          <h1>교수용 LectureLink를<br />시작할 준비가 됐습니다</h1>
          <p>학생에게 표시될 기본 정보만 확인하면 바로 교수 홈으로 이동합니다.</p>
          <ol aria-label="설정 항목">
            <li><UserRound aria-hidden="true" /><span><b>이름</b><small>교수 화면과 강의에 표시됩니다.</small></span></li>
            <li><Building2 aria-hidden="true" /><span><b>현재 소속 대학</b><small>소속에 맞는 교수 환경을 구성합니다.</small></span></li>
          </ol>
        </section>

        <section className="faculty-onboarding-panel" aria-labelledby="faculty-onboarding-title">
          <div>
            <h2 id="faculty-onboarding-title">기본 정보 입력</h2>
            <p>세 항목을 입력하면 설정이 완료됩니다.</p>
          </div>
          <form onSubmit={submit}>
            <label>
              <span>이름</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={50} autoComplete="name" placeholder="이름 입력" required />
            </label>
            <label>
              <span>현재 소속 대학</span>
              <select value={schoolId} onChange={(event) => setSchoolId(event.target.value)} disabled={schoolsLoading || schoolsError} required>
                <option value="">{schoolsLoading ? '의과대학 목록을 불러오는 중...' : schoolsError ? '목록을 불러오지 못했습니다' : '소속 의과대학 선택'}</option>
                {schools.map((school) => <option value={school.id} key={school.id}>{school.name} ({school.short_name})</option>)}
              </select>
              {schoolsError && <small className="is-error">목록을 불러오지 못했습니다. <button type="button" onClick={() => void loadSchools()}>다시 불러오기</button></small>}
            </label>
            <label>
              <span>LectureLink를 알게 된 경로</span>
              <select value={channel} onChange={(event) => setChannel(event.target.value)} required>
                <option value="">알게 된 경로 선택</option>
                {CHANNEL_OPTIONS.map((option) => <option value={option} key={option}>{option}</option>)}
              </select>
            </label>

            {error && <p className="faculty-onboarding-error" role="alert">{error}</p>}
            <button type="submit" disabled={submitting || schoolsLoading || !name.trim() || !schoolId || !channel}>
              {submitting ? '저장 중...' : '교수 홈으로 시작하기'}
              {!submitting && <ArrowRight aria-hidden="true" />}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
