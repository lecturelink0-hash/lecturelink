'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CheckCircle2 } from 'lucide-react';

interface School { id: string; name: string; short_name: string }
interface SubTopic {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  level: number;
  exam_relevance: 1 | 2 | 3;
  is_risk_category: boolean;
}
interface Subject {
  id: string;
  name: string;
  code: string;
  sub_topics: SubTopic[];
}
interface CohortLookupRes {
  cohort_id: string | null;
  is_fallback: boolean;
  sample_size: number;
  scores: Array<{ sub_topic_id: string; inclusion_score: number; confidence: number; sample_size: number }>;
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
  { value: 'naesin', label: '내신 대비' },
  { value: 'kmle', label: '국시 대비' },
  { value: 'usmle', label: 'USMLE' },
  { value: 'other', label: '기타' },
] as const;

const CHANNEL_OPTIONS = ['학교 단톡방', '선후배 추천', '친구 추천', 'SNS/유튜브', '검색', '기타'] as const;

export default function OnboardingPage() {

  const [schools, setSchools] = useState<School[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSchool, setSelectedSchool] = useState('');
  const [selectedGrade, setSelectedGrade] = useState<typeof GRADE_OPTIONS[number]['value']>('med_2');
  const [selectedSemester, setSelectedSemester] = useState<'spring' | 'fall'>('spring');
  const [selectedYear] = useState(new Date().getFullYear());
  const [selectedSubject, setSelectedSubject] = useState('');
  const [studyPurpose, setStudyPurpose] = useState<typeof PURPOSE_OPTIONS[number]['value']>('kmle');
  const [purposeDetail, setPurposeDetail] = useState(''); // '기타' 선택 시 주관식 입력
  const [displayName, setDisplayName] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [acquisitionChannel, setAcquisitionChannel] = useState('');
  const [scopeChecks, setScopeChecks] = useState<Record<string, boolean>>({});
  const [seniorData, setSeniorData] = useState<Record<string, number>>({});
  const [isFallback, setIsFallback] = useState(false);
  const [seniorCount, setSeniorCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  // 초기 로드: 학교 + 과목
  useEffect(() => {
    Promise.all([
      api.get<School[]>('/api/schools'),
      api.get<Subject[]>('/api/subjects'),
      api.get<{ displayName: string | null }>('/api/me').catch(() => null),
    ])
      .then(([sch, subs, me]) => {
        setSchools(sch);
        setSubjects(subs);
        if (subs.length > 0) setSelectedSubject(subs[0].id);
        // 이메일이 이름으로 채워진 경우는 프리필하지 않음(사용자가 실제 이름 입력).
        if (me?.displayName && !me.displayName.includes('@')) setDisplayName(me.displayName);
      })
      .catch(() => {});
  }, []);

  // 학교·학년·과목 변경 시 코호트 lookup
  useEffect(() => {
    if (!selectedSchool || !selectedSubject) return;
    api
      .get<CohortLookupRes>(
        `/api/cohorts/lookup?school_id=${selectedSchool}&grade=${selectedGrade}&year=${selectedYear}&semester=${selectedSemester}&subject_id=${selectedSubject}`,
      )
      .then((res) => {
        const map: Record<string, number> = {};
        for (const s of res.scores) {
          map[s.sub_topic_id] = s.inclusion_score;
        }
        setSeniorData(map);
        setIsFallback(res.is_fallback);
        setSeniorCount(res.sample_size);

        // 기본 체크: 선배 50% 이상 포함된 sub_topic 자동 선택
        const subject = subjects.find((s) => s.id === selectedSubject);
        if (subject) {
          const initial: Record<string, boolean> = {};
          for (const st of subject.sub_topics.filter((t) => t.level === 1)) {
            const score = map[st.id] ?? st.exam_relevance / 3;
            initial[st.id] = score >= 0.5;
          }
          setScopeChecks(initial);
        }
      });
  }, [selectedSchool, selectedGrade, selectedSemester, selectedYear, selectedSubject, subjects]);

  async function handleSubmit() {
    if (!displayName.trim()) { alert('이름을 입력해주세요.'); return; }
    if (!selectedSchool || !selectedSubject) return;
    setSubmitting(true);
    try {
      const nm = displayName.trim();
      if (nm) await api.patch('/api/me', { display_name: nm }).catch(() => {});
      await api.post('/api/onboarding', {
        school_id: selectedSchool,
        grade: selectedGrade,
        semester: selectedSemester,
        year: selectedYear,
        subject_id: selectedSubject,
        study_purpose: studyPurpose,
        study_purpose_detail: studyPurpose === 'other' ? (purposeDetail.trim() || null) : null,
        referral_code: referralCode || null,
        acquisition_channel: acquisitionChannel || null,
      });
      // 가입 축하 화면 노출(기획서). '계속하기'로 홈 이동.
      setCompleted(true);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '오류가 발생했습니다';
      alert(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const currentSubject = subjects.find((s) => s.id === selectedSubject);

  if (completed) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <div className="flex justify-center mb-5">
          <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--color-curated-bg)] text-sage-700">
            <CheckCircle2 className="w-9 h-9" strokeWidth={2} />
          </span>
        </div>
        <h1 className="text-2xl font-bold text-sage-800 mb-2 break-keep leading-snug">
          {(() => {
            const nm = (displayName || '').includes('@') ? displayName.split('@')[0] : displayName;
            return nm ? `${nm}님, 가입을 축하합니다 🎉` : '가입을 축하합니다 🎉';
          })()}
        </h1>
        <p className="text-[15px] text-[var(--color-muted)] leading-relaxed mb-8">
          이제 학습을 시작할 수 있어요. <br />
          <span className="text-sage-800 font-semibold">통합 요금제</span>는 지금 무료체험으로 시작할 수 있습니다.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button variant="accent" size="lg" onClick={() => { window.location.href = '/plan'; }}>
            요금제 보기 · 무료체험 시작
          </Button>
          <Button variant="secondary" size="lg" onClick={() => { window.location.href = '/dashboard'; }}>
            홈으로 계속하기
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ll-system-page">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-sage-800 mb-2">온보딩 — 시험 범위 설정</h1>
        <p className="text-sm text-[var(--color-muted)]">
          학교·학년·학기를 입력하면 선배들의 시험 범위 데이터를 기반으로 추천 콘텐츠가 자동 설정됩니다.
        </p>
      </div>

      {/* Step 1 */}
      <Card title="1. 학교 정보 입력" description="정확한 정보를 입력하면 같은 학교 선배들의 학습 데이터를 활용할 수 있습니다." className="mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="이름 *">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="이름 (필수 · 카카오 이름 그대로 사용 가능)"
              className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white"
            />
          </Field>

          <Field label="학교">
            <select className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white" value={selectedSchool} onChange={(e) => setSelectedSchool(e.target.value)}>
              <option value="">선택...</option>
              {schools.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>

          <Field label="학년">
            <select className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white" value={selectedGrade} onChange={(e) => setSelectedGrade(e.target.value as typeof selectedGrade)}>
              {GRADE_OPTIONS.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </Field>

          <Field label="학기">
            <select className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white" value={selectedSemester} onChange={(e) => setSelectedSemester(e.target.value as 'spring' | 'fall')}>
              <option value="spring">{selectedYear}년 1학기</option>
              <option value="fall">{selectedYear}년 2학기</option>
            </select>
          </Field>

          <Field label="수강 과목">
            <select className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white" value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
        </div>

        {/* 서비스 이용 목적 */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-sage-800 mb-1.5">서비스 이용 목적</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PURPOSE_OPTIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setStudyPurpose(p.value)}
                className={`h-10 rounded-lg border text-sm font-medium transition-colors ${
                  studyPurpose === p.value
                    ? 'bg-sage-700 text-white border-sage-700'
                    : 'bg-white text-sage-800 border-[var(--color-border)] hover:border-sage-600'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {studyPurpose === 'other' && (
            <input
              type="text"
              value={purposeDetail}
              onChange={(e) => setPurposeDetail(e.target.value)}
              placeholder="이용 목적을 자유롭게 입력해주세요 (예: 주관식 시험 대비)"
              maxLength={100}
              className="mt-2 w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white focus:border-sage-600 focus:outline-none"
            />
          )}
        </div>

        {/* 추천인 / 알게된 경로 (선택) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <Field label="추천인 코드 (선택)">
            <input
              value={referralCode}
              onChange={(e) => setReferralCode(e.target.value)}
              placeholder="친구·선배 추천 코드"
              className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white focus:border-sage-600 focus:outline-none"
            />
          </Field>
          <Field label="알게된 경로 (선택)">
            <select
              className="w-full h-10 rounded-lg border border-[var(--color-border)] px-3 text-sm bg-white"
              value={acquisitionChannel}
              onChange={(e) => setAcquisitionChannel(e.target.value)}
            >
              <option value="">선택...</option>
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      {/* Step 2 */}
      {currentSubject && (
        <Card
          title="2. 시험 범위 확인"
          description={
            seniorCount > 0
              ? `선배 ${seniorCount}명${isFallback ? ' (직전 학기 데이터)' : ''}이 누적한 시험 범위 데이터입니다. 본인 학기에 맞게 체크박스를 수정하세요.`
              : '아직 같은 코호트 선배 데이터가 없습니다. KMLE 빈출도 기반으로 추천된 범위를 본인 학기에 맞게 조정하세요.'
          }
          className="mb-4"
        >
          <div className="space-y-2">
            {currentSubject.sub_topics.filter((st) => st.level === 1).map((st) => {
              const seniorRate = seniorData[st.id];
              const checked = scopeChecks[st.id] ?? false;
              return (
                <label
                  key={st.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    checked
                      ? 'bg-[var(--color-sage-200)] border-sage-600'
                      : 'bg-white border-[var(--color-border)] hover:bg-[var(--color-sage-100)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setScopeChecks((s) => ({ ...s, [st.id]: e.target.checked }))}
                    className="w-4 h-4 accent-sage-700"
                  />
                  <div className="flex-1 text-sm font-medium text-sage-800">{st.name}</div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {st.is_risk_category && <span className="text-[var(--color-warn)] mr-2">⚠ 응급</span>}
                    {'★'.repeat(st.exam_relevance)}
                  </div>
                  {seniorRate !== undefined && (
                    <div className="text-[11px] font-semibold text-sage-700 ml-2 min-w-[80px] text-right">
                      선배 {Math.round(seniorRate * 100)}% 포함
                    </div>
                  )}
                </label>
              );
            })}
          </div>
        </Card>
      )}

      <div className="bg-[var(--color-sage-100)] border border-[var(--color-sage-200)] rounded-lg p-4 mb-6 text-sm text-sage-800">
        <strong>잘 모르겠다면?</strong> 첫 1~2주는 광범위하게 풀어보세요.
        각 문제의 <strong>“시험 범위 아니에요”</strong> 버튼을 누르면 자동으로 범위가 조정됩니다.
      </div>

      <div className="flex justify-end">
        <Button
          size="lg"
          onClick={handleSubmit}
          loading={submitting}
          disabled={!selectedSchool || !selectedSubject}
        >
          <CheckCircle2 className="w-4 h-4" />
          학습 시작
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-sage-800 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
