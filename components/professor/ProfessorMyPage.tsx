"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Building2,
  KeyRound,
  Mail,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/db/browser";
import { authErrorMessage } from "@/lib/auth/auth-error-message";
import { AccountDeletion } from "@/components/account/AccountDeletion";
import {
  isValidPassword,
  PASSWORD_ERROR,
  PASSWORD_HINT,
  PASSWORD_MAX_LENGTH,
} from "@/lib/auth/password-policy";

type FacultyStatus = "not_requested" | "pending" | "approved" | "rejected";
type MedicalSchool = { id: string; name: string; short_name: string };

const STATUS_LABEL: Record<FacultyStatus, string> = {
  not_requested: "인증 정보 없음",
  pending: "교수 인증 검토 중",
  approved: "인증된 교수 계정",
  rejected: "교수 인증 재확인 필요",
};

export function ProfessorMyPage({
  displayName,
  email,
  schoolId,
  schoolName,
  schoolShortName,
  facultyStatus,
}: {
  displayName: string;
  email: string;
  schoolId: string | null;
  schoolName: string | null;
  schoolShortName: string | null;
  facultyStatus: FacultyStatus;
}) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [savedName, setSavedName] = useState(displayName);
  const [selectedSchoolId, setSelectedSchoolId] = useState(schoolId ?? "");
  const [savedSchoolId, setSavedSchoolId] = useState(schoolId ?? "");
  const [schools, setSchools] = useState<MedicalSchool[]>([]);
  const [schoolsLoading, setSchoolsLoading] = useState(true);
  const [schoolsError, setSchoolsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const professorNamePreview = name.replace(/\s*교수(?:님)?$/, "").trim() || "이름";

  const loadSchools = useCallback(async () => {
    setSchoolsLoading(true);
    setSchoolsError(false);
    setError(null);
    try {
      const response = await fetch("/api/schools?type=medical");
      if (!response.ok) throw new Error();
      const payload = (await response.json()) as { data?: MedicalSchool[] };
      setSchools(payload.data ?? []);
    } catch {
      setSchoolsError(true);
    } finally {
      setSchoolsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchools();
  }, [loadSchools]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("화면에 표시할 이름을 입력해주세요.");
      return;
    }
    if (!selectedSchoolId) {
      setError("소속 의과대학을 선택해주세요.");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: nextName, school_id: selectedSchoolId }),
      });
      if (!response.ok)
        throw new Error(
          "프로필을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.",
        );
      setName(nextName);
      setSavedName(nextName);
      setSavedSchoolId(selectedSchoolId);
      setMessage("변경한 교수자 정보를 저장했습니다.");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "프로필을 저장하지 못했습니다.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage(null);
    setPasswordError(null);
    if (!isValidPassword(password)) {
      setPasswordError(PASSWORD_ERROR);
      return;
    }
    if (password !== passwordConfirm) {
      setPasswordError("새 비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    if (!currentPassword) {
      setPasswordError("현재 비밀번호를 입력해주세요.");
      return;
    }

    setPasswordSaving(true);
    try {
      const supabase = createBrowserClient();
      const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
      if (reauthError) {
        setPasswordError(authErrorMessage(reauthError));
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setCurrentPassword("");
      setPassword("");
      setPasswordConfirm("");
      setPasswordMessage("비밀번호를 변경했습니다. 다음 로그인부터 새 비밀번호를 사용해주세요.");
    } catch (caught) {
      setPasswordError(authErrorMessage(caught));
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="professor-mypage">
      <Link className="back" href="/professor">
        <ArrowLeft size={16} aria-hidden="true" />
        홈으로
      </Link>
      <header className="professor-mypage-heading">
        <div>
          <span className="eyebrow">교수 도구 · 마이페이지</span>
          <h1>
            <span className="headline-accent">회원 정보</span> 수정
          </h1>
          <p className="lead">
            강의 화면과 학생에게 표시되는 이름, 로그인 정보와 소속을 확인합니다.
          </p>
        </div>
        <span className={`professor-faculty-status is-${facultyStatus}`}>
          <BadgeCheck size={19} aria-hidden="true" />
          {STATUS_LABEL[facultyStatus]}
        </span>
      </header>

      <div className="professor-mypage-grid">
        <section
          className="professor-profile-panel"
          aria-labelledby="faculty-profile-title"
        >
          <div className="professor-profile-title">
            <span>
              <UserRound size={22} aria-hidden="true" />
            </span>
            <div>
              <h2 id="faculty-profile-title">기본 정보</h2>
              <p>학생에게 보이는 교수자 정보를 확인하고 수정하세요.</p>
            </div>
          </div>

          <form onSubmit={saveProfile} className="professor-profile-form">
            <label>
              <span>표시 이름</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={1}
                maxLength={50}
                autoComplete="name"
                required
              />
              <small>
                저장하면 교수용 화면에 ‘{professorNamePreview} 교수님’으로
                표시됩니다.
              </small>
            </label>
            <div className="professor-readonly-field">
              <span>
                <Mail size={17} aria-hidden="true" />
                로그인 이메일
              </span>
              <b>{email || "이메일 정보 없음"}</b>
            </div>
            <label>
              <span><Building2 size={17} aria-hidden="true" />소속 의과대학</span>
              <select value={selectedSchoolId} onChange={(event) => setSelectedSchoolId(event.target.value)} disabled={schoolsLoading || schoolsError} required>
                <option value="">{schoolsLoading ? "전국 의과대학 목록을 불러오는 중..." : schoolsError ? "의과대학 목록을 불러오지 못했습니다" : "소속 의과대학 선택"}</option>
                {schools.map((school) => <option value={school.id} key={school.id}>{school.name} ({school.short_name})</option>)}
              </select>
              {schoolsError ? <small className="professor-school-error">목록을 불러오지 못했습니다. <button type="button" onClick={() => void loadSchools()}>다시 불러오기</button></small> : <small>대한민국 전국 40개 의과대학·의학전문대학원 중에서 선택할 수 있습니다.</small>}
            </label>

            <div className="professor-profile-submit">
              <div aria-live="polite">
                {message && <p className="is-success">{message}</p>}
                {error && <p className="is-error">{error}</p>}
              </div>
              <button
                type="submit"
                className="professor-primary"
                disabled={saving || schoolsLoading || (name.trim() === savedName && selectedSchoolId === savedSchoolId)}
              >
                <Save size={18} aria-hidden="true" />
                {saving ? "저장 중..." : "변경사항 저장"}
              </button>
            </div>
          </form>

          <div className="professor-profile-divider" />
          <div className="professor-profile-title is-security">
            <span><KeyRound size={22} aria-hidden="true" /></span>
            <div><h2 id="faculty-password-title">비밀번호 변경</h2><p>로그인에 사용할 새 비밀번호를 설정합니다.</p></div>
          </div>
          <form onSubmit={changePassword} className="professor-profile-form" aria-labelledby="faculty-password-title">
            <div className="professor-password-grid">
              <label><span>현재 비밀번호</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} maxLength={PASSWORD_MAX_LENGTH} autoComplete="current-password" placeholder="본인 확인을 위해 입력" required /></label>
              <label><span>새 비밀번호</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" placeholder={PASSWORD_HINT} required /></label>
              <label><span>새 비밀번호 확인</span><input type="password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} minLength={8} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" placeholder="한 번 더 입력" required /></label>
            </div>
            <div className="professor-profile-submit">
              <div aria-live="polite">{passwordMessage && <p className="is-success">{passwordMessage}</p>}{passwordError && <p className="is-error">{passwordError}</p>}</div>
              <button type="submit" className="professor-secondary" disabled={passwordSaving || !currentPassword || !password || !passwordConfirm}><KeyRound size={18} aria-hidden="true" />{passwordSaving ? "변경 중..." : "비밀번호 변경"}</button>
            </div>
          </form>
        </section>

        <aside className="professor-account-summary" aria-label="계정 안내">
          <div>
            <ShieldCheck size={24} aria-hidden="true" />
            <h2>교수 계정</h2>
            <p>
              강의자료를 바탕으로 예습자료와 형성평가를 만들고 학생 학습 현황을
              관리할 수 있습니다.
            </p>
          </div>
          <dl>
            <div>
              <dt>계정 상태</dt>
              <dd>{STATUS_LABEL[facultyStatus]}</dd>
            </div>
            <div>
              <dt>소속</dt>
              <dd>{schoolShortName ?? schoolName ?? "등록 정보 없음"}</dd>
            </div>
          </dl>
          <Link href="/professor/courses">
            <BookOpen size={18} aria-hidden="true" />
            통합 관리로 이동
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </aside>
      </div>

      <AccountDeletion />
    </div>
  );
}
