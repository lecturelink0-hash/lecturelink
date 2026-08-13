"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  FileText,
  Plus,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  Lock,
  MoreHorizontal,
} from "lucide-react";
import "@/components/faculty/formative-studio.css";
import {
  isRetryableTeachingMaterialFailure,
  uploadTeachingMaterial,
} from "./CourseMaterialSelector";
import "./course-workspace.css";

type Course = {
  id: string;
  title: string;
  code: string;
  term: string | null;
  status: string;
  created_at: string;
};
type Artifact = {
  id: string;
  type: string;
  title: string;
  status: string;
  source_name: string | null;
  summary?: string | null;
  created_at: string;
  published_at?: string | null;
};
type Material = {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  page_count: number | null;
  status: string;
  error_message?: string | null;
  created_at: string;
  updated_at?: string;
};
type CourseDetailData = {
  course: Course;
  artifacts: Artifact[];
  materials: Material[];
  studentCount: number;
};
type MaterialUploadState = {
  fileName: string;
  stage: "uploading" | "processing" | "complete" | "failed";
  message: string;
};
const TYPES = {
  formative: { label: "형성평가", icon: ClipboardCheck },
  preview: { label: "예습자료", icon: BookOpen },
  material_review: { label: "자료 개선", icon: FileCheck2 },
} as const;

const formatDate = (value: string) => new Intl.DateTimeFormat("ko-KR", {
  year: "numeric", month: "short", day: "numeric",
}).format(new Date(value));

const artifactStatus = (artifact: Artifact) => artifact.published_at || artifact.status === "published"
  ? "배포됨" : artifact.status === "approved" ? "검토 완료" : "초안";
const LOCAL_PREVIEW_COURSES: Course[] = [
  {
    id: "preview-cardiology",
    title: "순환기학",
    code: "CARDIO",
    term: "8주차 · 심전도 실습 전",
    status: "active",
    created_at: "2026-07-20T00:00:00.000Z",
  },
  {
    id: "preview-arrhythmia",
    title: "부정맥 약물",
    code: "RHYTHM",
    term: "중간고사 전 복습",
    status: "active",
    created_at: "2026-07-18T00:00:00.000Z",
  },
];
const LOCAL_PREVIEW_DETAIL: CourseDetailData = {
  course: LOCAL_PREVIEW_COURSES[0],
  studentCount: 42,
  materials: [
    {
      id: "preview-material-1",
      file_name: "순환기학_부정맥_강의자료.pdf",
      file_type: "pdf",
      file_size_bytes: 6920000,
      page_count: 38,
      status: "ready",
      created_at: "2026-07-23T00:00:00.000Z",
    },
    {
      id: "preview-material-2",
      file_name: "심전도_핵심정리.pptx",
      file_type: "pptx",
      file_size_bytes: 12400000,
      page_count: 24,
      status: "ready",
      created_at: "2026-07-22T00:00:00.000Z",
    },
  ],
  artifacts: [
    {
      id: "preview-artifact-1",
      type: "formative",
      title: "부정맥 감별 형성평가",
      status: "review",
      source_name: "순환기학_부정맥_강의자료.pdf",
      created_at: "2026-07-23T00:00:00.000Z",
    },
    {
      id: "preview-artifact-2",
      type: "preview",
      title: "심전도 판독 선수지식",
      status: "approved",
      source_name: "심전도_핵심정리.pptx",
      created_at: "2026-07-22T00:00:00.000Z",
    },
    {
      id: "preview-artifact-3",
      type: "material_review",
      title: "순환기학 강의자료 개선안",
      status: "review",
      source_name: "순환기학_부정맥_강의자료.pdf",
      created_at: "2026-07-21T00:00:00.000Z",
    },
  ],
};

const LOCAL_PREVIEW_ANALYTICS = {
  course: { id: "preview-cardiology", title: "순환기학" },
  publicationCount: 3,
  submittedCount: 42,
  averagePercent: 76,
  items: [
    {
      itemId: "preview-item-1",
      artifactId: "preview-artifact-1",
      artifactTitle: "부정맥 감별 형성평가",
      position: 3,
      stem: "심방세동 환자의 초기 평가에서 가장 먼저 확인해야 하는 항목은 무엇인가요?",
      answers: 42,
      correct: 21,
      correctPercent: 50,
    },
    {
      itemId: "preview-item-2",
      artifactId: "preview-artifact-1",
      artifactTitle: "부정맥 감별 형성평가",
      position: 1,
      stem: "규칙적인 빈맥과 불규칙한 빈맥을 구분하는 심전도 소견으로 가장 적절한 것은?",
      answers: 42,
      correct: 27,
      correctPercent: 64,
    },
    {
      itemId: "preview-item-3",
      artifactId: "preview-artifact-1",
      artifactTitle: "부정맥 감별 형성평가",
      position: 4,
      stem: "항응고 치료 시작 여부를 판단할 때 함께 고려해야 하는 임상 정보는 무엇인가요?",
      answers: 42,
      correct: 31,
      correctPercent: 74,
    },
  ],
};

export function CourseList() {
  const localPreview =
    process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === "true";
  const [courses, setCourses] = useState<Course[]>(
    localPreview ? LOCAL_PREVIEW_COURSES : [],
  );
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingCourseId, setDeletingCourseId] = useState<string | null>(null);
  const [createdCourseId, setCreatedCourseId] = useState<string | null>(null);
  const [createMessage, setCreateMessage] = useState("");
  const courseListRef = useRef<HTMLElement>(null);

  async function load() {
    if (localPreview) return;
    const response = await fetch("/api/professor/courses");
    const payload = await response.json();
    if (payload.ok) setCourses(payload.data);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!createMessage) return;
    const timer = window.setTimeout(() => setCreateMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [createMessage]);

  function showCreated(course: Course) {
    setCreatedCourseId(course.id);
    setCreateMessage(`‘${course.title}’ 차시가 추가되었습니다.`);
    window.setTimeout(() => {
      courseListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  async function create() {
    if (!title.trim()) return;
    setCreatedCourseId(null);
    setCreateMessage("");
    if (localPreview) {
      const createdCourse = {
        id: `preview-${Date.now()}`,
        title: title.trim(),
        code: "PREVIEW",
        term: note.trim() || null,
        status: "active",
        created_at: new Date().toISOString(),
      };
      setCourses((current) => [createdCourse, ...current]);
      showCreated(createdCourse);
      setTitle("");
      setNote("");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/professor/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, note }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setCreateMessage("차시를 추가하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setTitle("");
      setNote("");
      await load();
      showCreated(payload.data);
    } finally {
      setBusy(false);
    }
  }

  async function removeCourse(course: Course) {
    const confirmed = window.confirm(
      `‘${course.title}’ 차시를 삭제하시겠습니까?\n\n저장된 강의자료, 생성 결과, 배포한 형성평가와 학생 제출 결과가 함께 삭제되며 복구할 수 없습니다.`,
    );
    if (!confirmed) return;

    setDeletingCourseId(course.id);
    setCreatedCourseId(null);
    setCreateMessage("");
    try {
      if (!localPreview) {
        const response = await fetch(
          `/api/professor/courses/${encodeURIComponent(course.id)}`,
          { method: "DELETE" },
        );
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          setCreateMessage(
            payload?.error?.message ?? "차시를 삭제하지 못했습니다.",
          );
          return;
        }
      }
      setCourses((current) => current.filter((item) => item.id !== course.id));
      setCreateMessage(`‘${course.title}’ 차시를 삭제했습니다.`);
    } finally {
      setDeletingCourseId(null);
    }
  }

  return (
    <div className="professor-dashboard course-library faculty-studio ll-upload-page">
      <Link href="/professor" className="back">
        <ArrowLeft size={16} />
        홈으로
      </Link>
      <div className="course-intro-grid">
        <div className="course-intro-main">
          <header className="course-library-head page-head">
            <div>
              <span className="eyebrow">교수 도구 · 통합 관리</span>
              <h1>
                예습부터 복습까지,
                <br />
                <span className="headline-accent">한 차시 안에서</span> 관리하세요
              </h1>
              <p className="lead">
                차시별로 강의자료, 예습자료, 형성평가와 학습 결과를 모아 관리합니다.
              </p>
            </div>
          </header>

          <section className="course-create-panel">
          <div className="course-create-copy">
            <span className="course-create-icon" aria-hidden="true"><Plus size={24} /></span>
            <h2>새 차시 만들기</h2>
          </div>
          <div className="course-create">
            <label>
              <span>차시명</span>
              <input
                aria-label="차시명"
                placeholder="예: 부정맥 약물"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              <span>간단 메모 <small>(선택)</small></span>
              <input
                aria-label="간단 메모"
                placeholder="예: 8주차 · 심전도 실습 전"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={60}
              />
            </label>
            <button
              className="course-create-button"
              disabled={busy || !title.trim()}
              onClick={create}
            >
              <Plus size={16} /> {busy ? "만드는 중" : "차시 만들기"}
            </button>
          </div>
          </section>
        </div>

        <section
          className="course-workflow"
          aria-labelledby="course-workflow-title"
        >
          <div className="course-workflow-copy">
            <h2 id="course-workflow-title">이용 순서</h2>
          </div>
          <div className="course-use-flow">
            <div>
              <span>1</span>
              <p><b>새 차시 만들기</b> 버튼을 누릅니다.</p>
            </div>
            <div>
              <span>2</span>
              <p><b>내 차시 작업공간</b>에 새 카드가 추가됩니다.</p>
            </div>
            <div>
              <span>3</span>
              <p>차시 카드를 열고 필요한 기능을 선택합니다.</p>
            </div>
          </div>
          <ol>
            <li>
              <span><FileCheck2 size={17} /></span>
              <div><b>자료 개선</b><small>강의자료를 읽기 쉽게 정리</small></div>
            </li>
            <li>
              <span><BookOpen size={17} /></span>
              <div><b>예습자료</b><small>수업 전 필요한 내용 준비</small></div>
            </li>
            <li>
              <span><ClipboardCheck size={17} /></span>
              <div><b>형성평가</b><small>수업 후 복습 문항 제작</small></div>
            </li>
            <li>
              <span><BarChart3 size={17} /></span>
              <div><b>학습 결과</b><small>학생 응답과 오답 확인</small></div>
            </li>
          </ol>
        </section>
      </div>

      <section className="course-library-list" ref={courseListRef}>
        <div className="professor-section-head">
          <div>
            <h2>내 차시 작업공간</h2>
          </div>
          <p>
            {courses.length > 0
              ? `현재 ${courses.length}개의 차시가 있습니다.`
              : "아래에서 첫 차시를 만들어 주세요."}
          </p>
        </div>
        {createMessage && (
          <div className="course-create-message" role="status" aria-live="polite">
            <span><FileCheck2 size={22} /></span>
            <div>
              <b>{createMessage}</b>
              {createdCourseId && <small>새 작업공간이 목록 맨 앞에 표시되었습니다.</small>}
            </div>
          </div>
        )}
        <div className="course-card-grid">
          {courses.map((course) => (
            <article
              className={`course-card${course.id === createdCourseId ? " is-new" : ""}`}
              key={course.id}
            >
              <Link className="course-card-open" href={`/professor/courses/${course.id}`}>
                <div className="course-card-top">
                  <span className="course-card-icon">
                    <BookOpen size={19} />
                  </span>
                  <small>{course.term || "메모 없음"}</small>
                  {course.id === createdCourseId && (
                    <span className="course-card-new-badge">새로 추가됨</span>
                  )}
                </div>
                <h3>{course.title}</h3>
                <small className="course-card-date">{formatDate(course.created_at)} 생성</small>
                <span className="course-card-link">
                  차시 열기 <ArrowRight size={15} />
                </span>
              </Link>
              <button
                type="button"
                className="course-card-delete"
                aria-label={`${course.title} 차시 삭제`}
                title="차시 삭제"
                disabled={deletingCourseId === course.id}
                onClick={() => void removeCourse(course)}
              >
                {deletingCourseId === course.id
                  ? <Loader2 className="is-spinning" size={19} aria-hidden="true" />
                  : <Trash2 size={19} aria-hidden="true" />}
              </button>
            </article>
          ))}
          {!courses.length && (
            <div className="professor-empty">
              아직 만든 차시가 없습니다. 아래에서 차시를 만들어 주세요.
            </div>
          )}
        </div>
      </section>

    </div>
  );
}

export function CourseDetail({ courseId }: { courseId: string }) {
  const localPreview =
    process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === "true";
  const [data, setData] = useState<CourseDetailData | null>(
    localPreview
      ? {
          ...LOCAL_PREVIEW_DETAIL,
          course:
            LOCAL_PREVIEW_COURSES.find((course) => course.id === courseId) ??
            LOCAL_PREVIEW_DETAIL.course,
        }
      : null,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<MaterialUploadState | null>(null);
  const [uploadedMaterialId, setUploadedMaterialId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const retryFileRef = useRef<File | null>(null);
  useEffect(() => {
    if (localPreview) return;
    fetch(`/api/professor/courses/${courseId}`)
      .then((r) => r.json())
      .then((p) => p.ok && setData(p.data));
  }, [courseId, localPreview]);
  useEffect(() => {
    if (
      localPreview ||
      !data?.materials.some(
        (material) => material.status === "processing" || isRetryableTeachingMaterialFailure(material),
      )
    ) return;
    const timer = window.setInterval(() => {
      fetch(`/api/professor/courses/${courseId}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => payload.ok && setData(payload.data));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [courseId, data?.materials, localPreview]);
  const groups = useMemo(
    () => ({
      formative: data?.artifacts.filter((a) => a.type === "formative") ?? [],
      preview: data?.artifacts.filter((a) => a.type === "preview") ?? [],
      material_review:
        data?.artifacts.filter((a) => a.type === "material_review") ?? [],
    }),
    [data],
  );
  async function upload(file: File | undefined) {
    if (!file) return;
    retryFileRef.current = file;
    setUploading(true);
    setUploadedMaterialId(null);
    setUploadState({
      fileName: file.name,
      stage: "uploading",
      message: "파일을 안전하게 저장하고 있습니다.",
    });
    const processingTimer = window.setTimeout(() => {
      setUploadState((current) => current?.stage === "uploading" ? {
        ...current,
        stage: "processing",
        message: "자료의 글자와 페이지를 읽고 있습니다.",
      } : current);
    }, 700);
    try {
      if (localPreview) {
        const previewMaterial: Material = {
          id: `preview-material-${Date.now()}`,
          file_name: file.name,
          file_type: file.name.toLowerCase().endsWith(".pptx") ? "pptx" : "pdf",
          file_size_bytes: file.size,
          page_count: null,
          status: "ready",
          created_at: new Date().toISOString(),
        };
        await new Promise((resolve) => window.setTimeout(resolve, 1100));
        setData((current) => current ? {
          ...current,
          materials: [previewMaterial, ...current.materials],
        } : current);
        setUploadedMaterialId(previewMaterial.id);
      } else {
        const stored = await uploadTeachingMaterial(courseId, file);
        const response = await fetch(`/api/professor/courses/${courseId}`);
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload?.error?.message ?? "자료 목록을 다시 불러오지 못했습니다.");
        }
        setData(payload.data);
        setUploadedMaterialId(stored.id);
      }
      retryFileRef.current = null;
      setUploadState({
        fileName: file.name,
        stage: "complete",
        message: "파일 저장 완료 · 자료의 글자와 페이지를 읽고 있습니다.",
      });
      window.setTimeout(() => setUploadState((current) =>
        current?.stage === "complete" ? null : current
      ), 5000);
    } catch (error) {
      setUploadState({
        fileName: file.name,
        stage: "failed",
        message: error instanceof Error ? error.message : "강의자료를 업로드하지 못했습니다.",
      });
    } finally {
      window.clearTimeout(processingTimer);
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function retryMaterial(material: Material) {
    setDeletingId(material.id);
    try {
      const response = await fetch(`/api/professor/teaching-materials/${material.id}/process`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message ?? "다시 처리를 시작하지 못했습니다.");
      setData((current) => current ? {
        ...current,
        materials: current.materials.map((item) => item.id === material.id ? { ...item, status: "processing", error_message: null } : item),
      } : current);
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : "다시 처리를 시작하지 못했습니다.");
    } finally {
      setDeletingId(null);
    }
  }

  async function removeMaterial(material: Material) {
    if (!window.confirm(`‘${material.file_name}’ 강의자료를 LectureLink에서 완전히 삭제하시겠습니까?\n\n저장된 파일도 함께 삭제되며 복구할 수 없습니다.`)) return;
    setDeletingId(material.id);
    try {
      if (!localPreview) {
        const response = await fetch(
          `/api/professor/teaching-materials?materialId=${encodeURIComponent(material.id)}`,
          { method: "DELETE" },
        );
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          window.alert(payload?.error?.message ?? "강의자료를 삭제하지 못했습니다.");
          return;
        }
      }
      setData((current) => current ? {
        ...current,
        materials: current.materials.filter((item) => item.id !== material.id),
      } : current);
    } finally {
      setDeletingId(null);
    }
  }
  if (!data)
    return <div className="professor-empty">차시를 불러오는 중입니다.</div>;
  return (
    <div className="faculty-studio ll-upload-page course-workspace-page">
      <Link href="/professor/courses" className="back">
        <ArrowLeft size={16} />통합 관리로
      </Link>
      <header className="page-head">
        <div>
          <p className="eyebrow">
            통합 관리 · {data.course.term || "수업 차시"}
          </p>
          <h1>
            <span className="headline-accent">{data.course.title}</span>{" "}
            수업 준비를 이어가세요
          </h1>
          <p className="lead">
            강의자료를 한 번 저장하고 형성평가, 예습자료, 자료 개선에 반복해서
            활용할 수 있습니다.
          </p>
        </div>
      </header>

      <div className="studio-workbench course-workbench">
        <main className="studio-main">
          <section className="studio-section card pad course-material-section">
            <span className="studio-step-number" aria-hidden="true">
              1
            </span>
            <div className="course-material-top">
              <div className="card-head">
                <div>
                <h2>강의자료</h2>
                <p>
                  차시에 저장하고 여러 교수 도구에서 반복해 사용할 자료입니다.
                </p>
                <button
                  className="primary-btn course-upload-button"
                  disabled={uploading}
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload size={16} />
                  {uploading ? "저장 중" : "새 자료 업로드"}
                </button>
                </div>
                <input
                  ref={inputRef}
                  hidden
                  type="file"
                  accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                  onChange={(event) => void upload(event.target.files?.[0])}
                />
              </div>
              <aside className="course-data-notice">
                <ShieldCheck size={22} />
                <b>업로드 자료 보호 안내</b>
                <p>
                  삭제한 자료는 서버에서도 삭제됩니다. 모델 학습이나 외부 배포에
                  사용하지 않고, 선택한 기능의 분석에만 사용합니다.
                </p>
              </aside>
            </div>
            <div className="course-material-list">
              {uploadState && (
                <article
                  className={`course-upload-status is-${uploadState.stage}`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="course-upload-status-icon">
                    {uploadState.stage === "complete" ? <CheckCircle2 size={22} /> :
                      uploadState.stage === "failed" ? <AlertCircle size={22} /> :
                      <Loader2 className="is-spinning" size={22} />}
                  </span>
                  <div>
                    <b>{uploadState.fileName}</b>
                    <span>{uploadState.message}</span>
                  </div>
                  {uploadState.stage === "failed" && retryFileRef.current && (
                    <button type="button" onClick={() => void upload(retryFileRef.current ?? undefined)}>
                      <RotateCcw size={16} /> 다시 시도
                    </button>
                  )}
                </article>
              )}
              {data.materials.map((material) => (
                <article
                  className={`course-material-row${material.id === uploadedMaterialId ? " is-new" : ""}`}
                  key={material.id}
                >
                  <span className="course-row-icon">
                    <FileText size={18} />
                  </span>
                  <div className="course-row-copy">
                    <b>{material.file_name}</b>
                    <small className={`course-material-status is-${material.status}`}>
                      {material.status === "ready" && "사용할 수 있는 강의자료입니다"}
                      {material.status === "processing" && "자료의 글자와 페이지를 읽고 있습니다"}
                      {material.status === "failed" && (material.error_message?.split(":").slice(1).join(":") || "자료 처리에 실패했습니다")}
                    </small>
                  </div>
                  <div className="course-row-actions">
                    {material.status === "ready" ? <><Link
                      href={`/professor/formative?course=${courseId}&material=${material.id}`}
                    >
                      형성평가 만들기 <ArrowRight size={15} />
                    </Link>
                    <Link
                      href={`/professor/bridge?course=${courseId}&material=${material.id}`}
                    >
                      예습자료 만들기 <ArrowRight size={15} />
                    </Link></> : (
                      <button type="button" className="course-material-retry" disabled={deletingId === material.id} onClick={() => void retryMaterial(material)}>
                        <RotateCcw size={16} /> {material.status === "processing" ? "처리 상태 확인" : "다시 처리"}
                      </button>
                    )}
                    <span className="course-material-locked" aria-disabled="true" title="베타테스트 이후 공개됩니다">자료 개선 <Lock size={14} /></span>
                    <details className="course-row-menu">
                      <summary aria-label={`${material.file_name} 자료 메뉴`}><MoreHorizontal size={18} /></summary>
                      <button type="button" className="course-material-delete" disabled={deletingId === material.id} onClick={() => void removeMaterial(material)}>
                        <Trash2 size={16} /> {deletingId === material.id ? "삭제 중" : "강의자료 삭제"}
                      </button>
                    </details>
                  </div>
                </article>
              ))}
              {!data.materials.length && !uploadState && (
                <div className="course-empty">
                  <Upload size={17} />
                  <span>
                    <b>저장된 강의자료가 없습니다.</b>
                    <small>
                      새 자료를 업로드하면 이 차시의 자료 보관함에 저장됩니다.
                    </small>
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="studio-section card pad course-results-section">
            <span className="studio-step-number" aria-hidden="true">
              2
            </span>
            <div className="card-head">
              <div>
                <h2>생성 결과</h2>
              </div>
            </div>
            <div className="course-output-groups">
              {(
                Object.entries(groups) as Array<
                  [keyof typeof TYPES, Artifact[]]
                >
              ).map(([type, items]) => {
                const meta = TYPES[type];
                const Icon = meta.icon;
                return (
                  <section
                    className={`course-output-group course-output-group-${type}`}
                    key={type}
                  >
                    <header>
                      <span>
                        <Icon size={24} />
                      </span>
                      <div>
                        <h3>{meta.label}</h3>
                      </div>
                    </header>
                    <div>
                      {items.map((item) => {
                        if (type === "formative") {
                          return (
                            <Link href={`/professor/artifacts/${item.id}`} className="course-output-row" key={item.id}>
                              <div>
                                <b>{item.title}</b>
                                <small>{formatDate(item.created_at)} · {artifactStatus(item)}</small>
                              </div>
                              <ArrowRight size={15} />
                            </Link>
                          );
                        }
                        if (type === "preview") {
                          return (
                            <Link href={`/professor/artifacts/${item.id}/preview`} className="course-output-row" key={item.id}>
                              <div>
                                <b>{item.title}</b>
                                <small>{formatDate(item.created_at)} · {artifactStatus(item)}</small>
                              </div>
                              <span className="course-output-open">열람하기 <ArrowRight size={15} /></span>
                            </Link>
                          );
                        }
                        return (
                          <div className="course-output-row is-unavailable" key={item.id}>
                            <div><b>{item.title}</b><small>{formatDate(item.created_at)} · {artifactStatus(item)}</small></div>
                            <span>열람 준비 중</span>
                          </div>
                        );
                      })}
                      {!items.length && (
                        <div className="course-output-empty">
                          <p>아직 만든 {meta.label}가 없습니다.</p>
                          {type === "formative" && data.materials.some((material) => material.status === "ready") && (
                            <Link href={`/professor/formative?course=${courseId}&material=${data.materials.find((material) => material.status === "ready")?.id}`}>형성평가 만들기 <ArrowRight size={14} /></Link>
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </section>
          <section className="course-analytics-entry">
            <div><BarChart3 size={22} /><span><b>학습 결과</b><small>학생 응답, 정답률과 취약 문항을 확인합니다.</small></span></div>
            <Link href={`/professor/courses/${courseId}/analytics`}>학습 결과 보기 <ArrowRight size={15} /></Link>
          </section>
        </main>
      </div>
    </div>
  );
}
export function CourseAnalytics({ courseId }: { courseId: string }) {
  const localPreview =
    process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === "true";
  const [data, setData] = useState<any>(
    localPreview
      ? {
          ...LOCAL_PREVIEW_ANALYTICS,
          course: {
            ...LOCAL_PREVIEW_ANALYTICS.course,
            id: courseId,
          },
        }
      : null,
  );
  useEffect(() => {
    if (localPreview) return;
    fetch(`/api/professor/courses/${courseId}/analytics`)
      .then((r) => r.json())
      .then((p) => p.ok && setData(p.data));
  }, [courseId, localPreview]);
  if (!data)
    return (
      <div className="professor-dashboard course-analytics-page">
        <div className="course-analytics-loading" role="status">
          <Loader2 className="is-spinning" size={20} aria-hidden="true" />
          분석을 불러오는 중입니다.
        </div>
      </div>
    );
  return (
    <div className="professor-dashboard course-analytics-page ll-upload-page">
      <Link href={`/professor/courses/${courseId}`} className="back"><ArrowLeft size={16} />{data.course.title} 차시로</Link>
      <header className="page-head course-analytics-head">
        <div>
          <p className="eyebrow">차시 분석 리포트</p>
          <h1><span className="headline-accent">{data.course.title}</span> 학생 이해도</h1>
          <p className="lead">학생 제출 현황과 정답률을 확인하고 우선 검토할 문항을 살펴보세요.</p>
        </div>
      </header>
      <section className="course-analytics-summary" aria-label="학습 결과 요약">
        <div className="course-analytics-stat">
          <small>배포한 평가</small>
          <p><b>{data.publicationCount}</b><span>개</span></p>
        </div>
        <div className="course-analytics-stat">
          <small>제출 학생</small>
          <p><b>{data.submittedCount}</b><span>명</span></p>
        </div>
        <div className="course-analytics-stat">
          <small>평균 정답률</small>
          <p><b>
            {data.averagePercent === null ? "—" : `${data.averagePercent}%`}
          </b></p>
        </div>
      </section>
      <section className="course-analytics-section">
        <div className="course-analytics-section-head">
          <div>
            <h2>취약 문항</h2>
            <p>정답률이 낮은 문항부터 확인할 수 있습니다.</p>
          </div>
          <span>총 {data.items.length}문항</span>
        </div>
        <div className="course-analytics-list">
          {data.items.map((x: any, i: number) => (
            <article className="course-analytics-item" key={x.itemId}>
              <span className="course-analytics-rank">{i + 1}</span>
              <div className="course-analytics-item-copy">
                <small>{x.artifactTitle ?? "형성평가"} · 문항 {(x.position ?? i) + 1}</small>
                <h3>{x.stem ?? `문항 응답 ${x.answers}건`}</h3>
                <p>정답 {x.correct}건 · 오답 {x.answers - x.correct}건</p>
              </div>
              <div className="course-analytics-rate">
                <small>정답률</small>
                <strong>{x.correctPercent}%</strong>
              </div>
              {x.artifactId && <Link href={`/professor/artifacts/${x.artifactId}`}>문항 검토하기 <ArrowRight size={15} /></Link>}
            </article>
          ))}
          {!data.items.length && (
            <div className="course-analytics-empty">
              <BarChart3 size={24} aria-hidden="true" />
              <strong>아직 분석할 학습 결과가 없습니다.</strong>
              학생 제출이 쌓이면 문항별 이해도가 표시됩니다.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
