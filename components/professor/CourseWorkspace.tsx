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
} from "lucide-react";
import "@/components/faculty/formative-studio.css";
import { uploadTeachingMaterial } from "./CourseMaterialSelector";
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
};
type Material = {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  page_count: number | null;
  status: string;
  created_at: string;
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
const LOCAL_PREVIEW_COURSES: Course[] = [
  {
    id: "preview-cardiology",
    title: "순환기학",
    code: "CARDIO",
    term: "2026년 2학기",
    status: "active",
    created_at: "2026-07-20T00:00:00.000Z",
  },
  {
    id: "preview-arrhythmia",
    title: "부정맥 약물",
    code: "RHYTHM",
    term: "임상약리학",
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

export function CourseList() {
  const localPreview =
    process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === "true";
  const [courses, setCourses] = useState<Course[]>(
    localPreview ? LOCAL_PREVIEW_COURSES : [],
  );
  const [title, setTitle] = useState("");
  const [term, setTerm] = useState("");
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
        term: term.trim() || null,
        status: "active",
        created_at: new Date().toISOString(),
      };
      setCourses((current) => [createdCourse, ...current]);
      showCreated(createdCourse);
      setTitle("");
      setTerm("");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/professor/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, term }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setCreateMessage("차시를 추가하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setTitle("");
      setTerm("");
      await load();
      showCreated(payload.data);
    } finally {
      setBusy(false);
    }
  }

  async function removeCourse(course: Course) {
    const confirmed = window.confirm(
      `‘${course.title}’ 작업공간을 삭제하시겠습니까?\n\n저장된 강의자료, 생성 결과, 배포한 형성평가와 학생 제출 결과가 함께 삭제됩니다.`,
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
            payload?.error?.message ?? "작업공간을 삭제하지 못했습니다.",
          );
          return;
        }
      }
      setCourses((current) => current.filter((item) => item.id !== course.id));
      setCreateMessage(`‘${course.title}’ 작업공간을 삭제했습니다.`);
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
              <span>학기</span>
              <input
                aria-label="학기"
                placeholder="예: 2026년 2학기"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
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
          {courses.map((course, index) => (
            <article
              className={`course-card${course.id === createdCourseId ? " is-new" : ""}`}
              key={course.id}
            >
              <Link className="course-card-open" href={`/professor/courses/${course.id}`}>
                <div className="course-card-top">
                  <span className="course-card-icon">
                    <BookOpen size={19} />
                  </span>
                  <small>{course.term || "학기 미지정"}</small>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                </div>
                <h3>{course.title}</h3>
                <span className="course-card-link">
                  차시 열기 <ArrowRight size={15} />
                </span>
              </Link>
              <button
                type="button"
                className="course-card-delete"
                aria-label={`${course.title} 작업공간 삭제`}
                disabled={deletingCourseId === course.id}
                onClick={() => void removeCourse(course)}
              >
                <Trash2 size={16} />
                {deletingCourseId === course.id ? "삭제 중" : "삭제"}
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
        message: "강의자료가 추가되었습니다.",
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

  async function removeMaterial(material: Material) {
    if (!window.confirm(`‘${material.file_name}’ 파일을 서버에서 삭제하시겠습니까?`)) return;
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
                <p>
                  <b>업로드 자료 보호 안내</b>
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
                  </div>
                  <div className="course-row-actions">
                    <Link
                      href={`/professor/formative?course=${courseId}&material=${material.id}`}
                    >
                      형성평가 만들기 <ArrowRight size={15} />
                    </Link>
                    <Link
                      href={`/professor/bridge?course=${courseId}&material=${material.id}`}
                    >
                      예습자료 만들기 <ArrowRight size={15} />
                    </Link>
                    <Link
                      href={`/professor/materials?course=${courseId}&material=${material.id}`}
                    >
                      자료 개선하기 <ArrowRight size={15} />
                    </Link>
                    <button
                      type="button"
                      className="course-material-delete"
                      disabled={deletingId === material.id}
                      onClick={() => void removeMaterial(material)}
                    >
                      <Trash2 size={16} />
                      {deletingId === material.id ? "삭제 중" : "삭제"}
                    </button>
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
                      {items.map((item) => (
                        <Link
                          href={
                            type === "formative"
                              ? `/professor/artifacts/${item.id}`
                              : "#"
                          }
                          className="course-output-row"
                          key={item.id}
                        >
                          <div>
                            <b>{item.title}</b>
                          </div>
                          <ArrowRight size={15} />
                        </Link>
                      ))}
                      {!items.length && (
                        <p className="course-output-empty">
                          아직 만든 {meta.label}가 없습니다.
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
export function CourseAnalytics({ courseId }: { courseId: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch(`/api/professor/courses/${courseId}/analytics`)
      .then((r) => r.json())
      .then((p) => p.ok && setData(p.data));
  }, [courseId]);
  if (!data)
    return <div className="professor-empty">분석을 불러오는 중입니다.</div>;
  return (
    <div className="professor-dashboard">
      <header className="professor-welcome">
        <div>
          <p>차시 분석 리포트</p>
          <h1>
            {data.course.title}
            <br />
            학생 이해도
          </h1>
        </div>
      </header>
      <section className="analytics-grid">
        <div>
          <small>배포한 평가</small>
          <b>{data.publicationCount}</b>
        </div>
        <div>
          <small>제출 학생</small>
          <b>{data.submittedCount}</b>
        </div>
        <div>
          <small>평균 정답률</small>
          <b>
            {data.averagePercent === null ? "—" : `${data.averagePercent}%`}
          </b>
        </div>
      </section>
      <section className="professor-tools">
        <div className="professor-section-head">
          <h2>취약 문항</h2>
          <p>정답률이 낮은 순서입니다.</p>
        </div>
        <div className="professor-tool-list">
          {data.items.map((x: any, i: number) => (
            <div className="professor-tool" key={x.itemId}>
              <span className="professor-tool-order">{i + 1}</span>
              <div>
                <h3>문항 응답 {x.answers}건</h3>
                <p>
                  정답 {x.correct}건 · 오답 {x.answers - x.correct}건
                </p>
              </div>
              <small>{x.correctPercent}%</small>
            </div>
          ))}
          {!data.items.length && (
            <div className="professor-empty">
              학생 제출이 쌓이면 문항별 이해도가 표시됩니다.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
