"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Plus, Upload, X } from "lucide-react";
import { readApiResponse } from "@/lib/utils/read-api-response";

type Course = { id: string; title: string; term?: string | null };
type Material = {
  id: string;
  course_id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  status: string;
  page_count: number | null;
  error_message?: string | null;
};

const RETRYABLE_MATERIAL_ERROR_CODES = [
  "database_failed",
  "storage_failed",
  "extraction_timeout",
] as const;

export function isRetryableTeachingMaterialFailure(material: Pick<Material, "status" | "error_message">) {
  if (material.status !== "failed") return false;
  const errorMessage = material.error_message?.toLowerCase() ?? "";
  return RETRYABLE_MATERIAL_ERROR_CODES.some((code) => errorMessage.includes(code));
}

function teachingMaterialFailureMessage(material: Pick<Material, "error_message">) {
  return material.error_message?.split(":").slice(1).join(":") || "강의자료 처리에 실패했습니다.";
}

const PREVIEW_COURSES: Course[] = [
  { id: "preview-cardiology", title: "순환기학", term: "2026년 2학기" },
  { id: "preview-arrhythmia", title: "부정맥 약물", term: "임상약리학" },
];
const PREVIEW_MATERIALS: Material[] = [
  { id: "preview-material-1", course_id: "preview-cardiology", file_name: "순환기학_부정맥_강의자료.pdf", file_type: "pdf", file_size_bytes: 6920000, status: "ready", page_count: 38 },
  { id: "preview-material-2", course_id: "preview-cardiology", file_name: "심전도_핵심정리.pptx", file_type: "pptx", file_size_bytes: 12400000, status: "ready", page_count: 24 },
];

export async function uploadTeachingMaterial(courseId: string, file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const fileHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const fileType = file.name.toLowerCase().endsWith(".pptx") ? "pptx" : "pdf";
  const initializeResponse = await fetch("/api/professor/teaching-materials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "initialize",
      courseId,
      fileName: file.name,
      fileType,
      mimeType: file.type || (fileType === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
      fileSizeBytes: file.size,
      fileHash,
    }),
  });
  const initialized = await readApiResponse<
    | (Material & { reused: true })
    | { materialId: string; signedUploadUrl: string; reused: false }
  >(initializeResponse, "강의자료 업로드를 준비하지 못했습니다.");
  if (!initializeResponse.ok || !initialized.ok || !initialized.data) {
    throw new Error(
      initialized?.error?.message ?? "강의자료 업로드를 준비하지 못했습니다.",
    );
  }
  if (initialized.data.reused) return initialized.data;

  const uploadResponse = await fetch(initialized.data.signedUploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!uploadResponse.ok) throw new Error("강의자료 파일을 저장하지 못했습니다.");

  const finalizeResponse = await fetch("/api/professor/teaching-materials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize", materialId: initialized.data.materialId }),
  });
  const finalized = await readApiResponse<Material & { reused: boolean }>(
    finalizeResponse,
    "강의자료 처리를 시작하지 못했습니다.",
  );
  if (!finalizeResponse.ok || !finalized.ok || !finalized.data) {
    throw new Error(finalized?.error?.message ?? "강의자료 처리를 시작하지 못했습니다.");
  }
  return finalized.data;
}

export async function waitForTeachingMaterialReady(courseId: string, materialId: string) {
  const deadline = Date.now() + 120_000;
  let recoveryRequested = false;
  let lastRetryableFailure = "";
  while (Date.now() < deadline) {
    const response = await fetch(
      `/api/professor/teaching-materials?courseId=${encodeURIComponent(courseId)}`,
      { cache: "no-store" },
    );
    const payload = await readApiResponse<Material[]>(response, "자료 처리 상태를 확인하지 못했습니다.");
    if (!response.ok || !payload.ok) throw new Error(payload?.error?.message ?? "자료 처리 상태를 확인하지 못했습니다.");
    const material = (payload.data as Material[]).find((item) => item.id === materialId);
    if (material?.status === "ready") return material;
    if (material?.status === "failed") {
      if (!isRetryableTeachingMaterialFailure(material)) {
        throw new Error(teachingMaterialFailureMessage(material));
      }

      lastRetryableFailure = teachingMaterialFailureMessage(material);
      if (!recoveryRequested) {
        recoveryRequested = true;
        const retryResponse = await fetch(
          `/api/professor/teaching-materials/${encodeURIComponent(materialId)}/process`,
          { method: "POST" },
        );
        const retryPayload = await readApiResponse<{ id: string; status: string }>(
          retryResponse,
          "자료 저장을 다시 시도하지 못했습니다.",
        );
        if (!retryResponse.ok || !retryPayload.ok) {
          throw new Error(retryPayload?.error?.message ?? lastRetryableFailure);
        }
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
  if (lastRetryableFailure) {
    throw new Error(`${lastRetryableFailure} 자동 재시도 후에도 완료되지 않았습니다. 잠시 후 다시 시도해주세요.`);
  }
  throw new Error("자료 처리 시간이 길어지고 있습니다. 통합 관리에서 상태를 확인한 뒤 다시 시도해주세요.");
}

export function CourseMaterialSelector({
  courseId,
  onCourseId,
  materialId,
  onMaterialId,
  file,
  onFile,
  accept,
  onCourseTitle,
  onMaterialName,
}: {
  courseId: string;
  onCourseId: (value: string) => void;
  materialId: string;
  onMaterialId: (value: string) => void;
  file: File | null;
  onFile: (value: File | null) => void;
  accept: string;
  onCourseTitle?: (value: string) => void;
  onMaterialName?: (value: string) => void;
}) {
  const localPreview = process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === "true";
  const inputRef = useRef<HTMLInputElement>(null);
  const [courses, setCourses] = useState<Course[]>(localPreview ? PREVIEW_COURSES : []);
  const [materials, setMaterials] = useState<Material[]>(
    localPreview ? PREVIEW_MATERIALS.filter((item) => item.course_id === courseId) : [],
  );
  const [mode, setMode] = useState<"library" | "upload">("library");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadCourses(preferredId?: string) {
    if (localPreview) {
      const selectedId = preferredId ?? courseId;
      onCourseTitle?.(PREVIEW_COURSES.find((item) => item.id === selectedId)?.title ?? "");
      return;
    }
    const response = await fetch("/api/professor/courses");
    const payload = await readApiResponse<Course[]>(response, "차시 목록을 불러오지 못했습니다.");
    if (!payload.ok || !payload.data) return;
    setCourses(payload.data);
    const selectedId = preferredId ?? courseId;
    const selected = payload.data.find(
      (item: Course) => item.id === selectedId,
    );
    onCourseTitle?.(selected?.title ?? "");
  }

  async function loadMaterials(id: string) {
    if (!id) {
      setMaterials([]);
      return;
    }
    if (localPreview) {
      const next = PREVIEW_MATERIALS.filter((item) => item.course_id === id);
      setMaterials(next);
      const selected = next.find((item) => item.id === materialId);
      onMaterialName?.(selected?.file_name ?? "");
      if (selected) setMode("library");
      if (next.length === 0) setMode("upload");
      return;
    }
    const response = await fetch(
      `/api/professor/teaching-materials?courseId=${encodeURIComponent(id)}`,
    );
    const payload = await readApiResponse<Material[]>(response, "강의자료 목록을 불러오지 못했습니다.");
    if (payload.ok && payload.data) {
      setMaterials(payload.data);
      const selected = payload.data.find(
        (item: Material) => item.id === materialId,
      );
      onMaterialName?.(selected?.file_name ?? "");
      if (selected) setMode("library");
      if (payload.data.length === 0) setMode("upload");
    }
  }

  useEffect(() => {
    void loadCourses();
  }, []);
  useEffect(() => {
    void loadMaterials(courseId);
    const selected = courses.find((item) => item.id === courseId);
    onCourseTitle?.(selected?.title ?? "");
  }, [courseId, courses, materialId]);

  async function createCourse() {
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (localPreview) {
        const course: Course = {
          id: `preview-course-${Date.now()}`,
          title: title.trim(),
          term: term.trim() || null,
        };
        setCourses((current) => [...current, course]);
        onCourseId(course.id);
        onMaterialId("");
        onFile(null);
        onCourseTitle?.(course.title);
        onMaterialName?.("");
        setMode("upload");
        setCreating(false);
        setTitle("");
        setTerm("");
        return;
      }
      const response = await fetch("/api/professor/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, term }),
      });
      const payload = await readApiResponse<Course>(response, "차시를 만들지 못했습니다.");
      if (!response.ok || !payload.ok || !payload.data)
        throw new Error(payload?.error?.message ?? "차시를 만들지 못했습니다.");
      onCourseId(payload.data.id);
      onCourseTitle?.(payload.data.title);
      setCreating(false);
      setTitle("");
      setTerm("");
      await loadCourses(payload.data.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "차시를 만들지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  function chooseMaterial(value: string) {
    onMaterialId(value);
    onFile(null);
    onMaterialName?.(
      materials.find((item) => item.id === value)?.file_name ?? "",
    );
  }

  function chooseFile(next: File | undefined) {
    if (!next) return;
    onFile(next);
    onMaterialId("");
    onMaterialName?.(next.name);
  }

  const selectedMaterial = materials.find((item) => item.id === materialId);

  return (
    <section className="course-material-selector">
      <div className="selector-title">
        <b>차시 선택</b>
      </div>
      <div className="source-row">
        <label>
          <select
            aria-label="차시 선택"
            value={courseId}
            onChange={(event) => {
              onCourseId(event.target.value);
              onMaterialId("");
              onFile(null);
            }}
          >
            <option value="">차시를 선택하세요</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="inline-create-trigger"
          type="button"
          onClick={() => {
            if (!creating) {
              onCourseId("");
              onMaterialId("");
              onFile(null);
              onCourseTitle?.("");
              onMaterialName?.("");
            }
            setCreating((value) => !value);
          }}
        >
          <Plus size={17} /> 새 차시 만들기
        </button>
      </div>

      {creating && (
        <div className="inline-course-create">
          <strong>새 차시 만들기</strong>
          <label>
            <span>차시명</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="예: 피부진균증"
              maxLength={120}
            />
          </label>
          <label>
            <span>학기</span>
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="선택 입력"
              maxLength={60}
            />
          </label>
          <button
            type="button"
            disabled={busy || !title.trim()}
            onClick={createCourse}
          >
            {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}{" "}
            만들고 선택
          </button>
        </div>
      )}

      {courseId && (
        <>
          <div className="selector-stage selector-material-stage">
            <span>자료</span>
            <div>
              <b>강의자료 선택</b>
              <p>등록된 자료를 사용하거나 새 자료를 업로드하세요.</p>
            </div>
          </div>
          <div
            className="material-source-tabs"
            role="tablist"
            aria-label="강의자료 선택 방식"
          >
            <button
              type="button"
              className={mode === "library" ? "is-active" : ""}
              onClick={() => setMode("library")}
            >
              등록된 강의자료
            </button>
            <button
              type="button"
              className={mode === "upload" ? "is-active" : ""}
              onClick={() => setMode("upload")}
            >
              새로 업로드
            </button>
          </div>
          {mode === "library" ? (
            <div className="material-library-picker">
              <select
                value={materialId}
                onChange={(event) => chooseMaterial(event.target.value)}
              >
                <option value="">강의자료 선택</option>
                {materials
                  .filter((item) => item.status === "ready")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.file_name}
                      {item.page_count ? ` · ${item.page_count}쪽` : ""}
                    </option>
                  ))}
              </select>
              {materials.length === 0 && (
                <p>이 차시에 등록된 자료가 없습니다. 새로 업로드해주세요.</p>
              )}
              {selectedMaterial && (
                <div className="selected-material-notice" role="status">
                  <CheckCircle2 size={19} />
                  <span>
                    <b>선택된 강의자료</b>
                    <small>{selectedMaterial.file_name} 파일이 현재 작업에 사용됩니다.</small>
                  </span>
                </div>
              )}
            </div>
          ) : file ? (
            <div className="selected-new-file">
              <FileText size={19} />
              <span>
                <b>{file.name}</b>
                <small>
                  {(file.size / 1024 / 1024).toFixed(1)} MB · 생성 시 차시에
                  저장됩니다.
                </small>
              </span>
              <button
                type="button"
                aria-label="파일 제거"
                onClick={() => onFile(null)}
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <button
              className="compact-upload"
              type="button"
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={18} />
              <span>
                <b>새 강의자료 선택</b>
                <small>PPTX, PDF · 최대 25MB</small>
              </span>
              <input
                ref={inputRef}
                type="file"
                accept={accept}
                hidden
                onChange={(event) => chooseFile(event.target.files?.[0])}
              />
            </button>
          )}
        </>
      )}
      {error && <p className="selector-error">{error}</p>}
    </section>
  );
}
