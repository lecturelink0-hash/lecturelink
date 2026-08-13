"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Building2,
  Mail,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { FormEvent, useState } from "react";

type FacultyStatus = "not_requested" | "pending" | "approved" | "rejected";

const STATUS_LABEL: Record<FacultyStatus, string> = {
  not_requested: "인증 정보 없음",
  pending: "교수 인증 검토 중",
  approved: "인증된 교수 계정",
  rejected: "교수 인증 재확인 필요",
};

export function ProfessorMyPage({
  displayName,
  email,
  schoolName,
  schoolShortName,
  facultyStatus,
}: {
  displayName: string;
  email: string;
  schoolName: string | null;
  schoolShortName: string | null;
  facultyStatus: FacultyStatus;
}) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [savedName, setSavedName] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const professorNamePreview = name.replace(/\s*교수(?:님)?$/, "").trim() || "이름";

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("화면에 표시할 이름을 입력해주세요.");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: nextName }),
      });
      if (!response.ok)
        throw new Error(
          "프로필을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.",
        );
      setName(nextName);
      setSavedName(nextName);
      setMessage("변경한 이름을 저장했습니다.");
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
            교수 계정 정보를
            <br />
            <span className="headline-accent">한곳에서</span> 관리하세요
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
            <div className="professor-readonly-field">
              <span>
                <Building2 size={17} aria-hidden="true" />
                소속 학교
              </span>
              <b>{schoolName ?? "등록된 학교 없음"}</b>
              {schoolShortName && schoolShortName !== schoolName && (
                <small>{schoolShortName}</small>
              )}
            </div>

            <div className="professor-profile-submit">
              <div aria-live="polite">
                {message && <p className="is-success">{message}</p>}
                {error && <p className="is-error">{error}</p>}
              </div>
              <button
                type="submit"
                className="professor-primary"
                disabled={saving || name.trim() === savedName}
              >
                <Save size={18} aria-hidden="true" />
                {saving ? "저장 중..." : "변경사항 저장"}
              </button>
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
    </div>
  );
}
