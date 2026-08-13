"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { UploadNextSteps } from "@/components/ui/UploadNextSteps";
import { Segmented } from "@/components/ui/Segmented";
import { GuideLabel } from "@/components/ui/GuideLabel";
import {
  CourseMaterialSelector,
  uploadTeachingMaterial,
  waitForTeachingMaterialReady,
} from "@/components/professor/CourseMaterialSelector";
import "./formative-studio.css";
import "@/components/professor/course-material-selector.css";

type Question = {
  id: string;
  stem: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
  objective: string;
  sourcePages: number[];
  cognitiveLevel: "회상" | "이해" | "적용";
  qualityFlags: string[];
  imageDataUrl: string | null;
};

type GenerateResponse = {
  title: string;
  materialSummary: string;
  objectives: string[];
  questions: Question[];
  reviewSummary: string;
  imageAnalysis: {
    requested: boolean;
    candidateCount: number;
    warnings: string[];
  };
};

const ACCEPT =
  ".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation";

const PREVIEW_QUESTIONS = [
  {
    stem: "다음 중 이 강의에서 설명한 핵심 개념으로 가장 적절한 것은?",
    choices: ["핵심 개념에 대한 첫 번째 설명", "서로 관련이 적은 두 번째 설명", "강의 범위를 벗어난 세 번째 설명", "반대 의미를 가진 네 번째 설명", "추가 확인이 필요한 다섯 번째 설명"],
    answerIndex: 0,
    explanation: "첫 번째 선택지는 강의자료의 핵심 내용을 정확하게 요약합니다. 나머지 선택지는 범위가 다르거나 핵심 개념과 일치하지 않습니다.",
    objective: "강의의 핵심 개념을 구분하고 설명할 수 있다.",
  },
  {
    stem: "강의에서 제시한 내용을 실제 상황에 적용한 예로 가장 적절한 것은?",
    choices: ["조건을 일부만 반영한 사례", "핵심 조건을 모두 반영한 사례", "결과와 원인을 반대로 연결한 사례", "자료에서 다루지 않은 사례", "판단에 필요한 정보가 부족한 사례"],
    answerIndex: 1,
    explanation: "두 번째 사례는 강의에서 제시한 조건과 판단 순서를 모두 반영하고 있어 가장 적절합니다.",
    objective: "학습한 원리를 간단한 상황에 적용할 수 있다.",
  },
  {
    stem: "다음 설명 중 강의자료의 내용과 일치하지 않는 것은?",
    choices: ["주요 정의에 관한 설명", "기본 원리에 관한 설명", "판단 순서에 관한 설명", "강의 내용과 반대되는 설명", "주의사항에 관한 설명"],
    answerIndex: 3,
    explanation: "네 번째 선택지는 강의에서 설명한 방향과 반대이므로 옳지 않습니다.",
    objective: "핵심 설명과 잘못된 설명을 구분할 수 있다.",
  },
] as const;

function createPreviewResult(count: number): GenerateResponse {
  return {
    title: "형성평가 검토하기",
    materialSummary: "선택한 강의자료를 바탕으로 만든 스타일 확인용 초안입니다. 실제 API나 저장 기능은 사용하지 않습니다.",
    objectives: ["핵심 개념 확인", "내용 적용", "오개념 구분"],
    questions: Array.from({ length: Math.max(1, count) }, (_, index) => {
      const sample = PREVIEW_QUESTIONS[index % PREVIEW_QUESTIONS.length];
      return {
        id: `preview-question-${index + 1}`,
        ...sample,
        choices: [...sample.choices],
        sourcePages: [index + 2, index + 3],
        cognitiveLevel: "이해" as Question["cognitiveLevel"],
        qualityFlags: index === 2 ? ["교수 검토가 필요한 예시 표시"] : [],
        imageDataUrl: null,
      };
    }),
    reviewSummary: "미리보기 문항의 형식과 기본 구성을 확인했습니다. 문항 내용은 화면 확인을 위한 예시입니다.",
    imageAnalysis: { requested: false, candidateCount: 0, warnings: [] },
  };
}

export function FormativeAssessmentStudio() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [rangeMode, setRangeMode] = useState<"전체 자료" | "페이지 선택">(
    "전체 자료",
  );
  const [pageRange, setPageRange] = useState("");
  const [include, setInclude] = useState("");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState("중");
  const [excluded, setExcluded] = useState("");
  const [additionalPrompt, setAdditionalPrompt] = useState("");
  const [useImages, setUseImages] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorTitle, setErrorTitle] = useState("초안을 만들지 못했습니다.");
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [courseId, setCourseId] = useState(searchParams.get("course") ?? "");
  const [courseTitle, setCourseTitle] = useState("");
  const [materialId, setMaterialId] = useState(
    searchParams.get("material") ?? "",
  );
  const [materialName, setMaterialName] = useState("");
  const sourceReady = Boolean(file || materialId);

  function chooseFile(next: File | null | undefined) {
    if (!next) {
      setFile(null);
      return;
    }
    setError("");
    setFile(next);
  }

  async function generate() {
    if (!courseId) {
      setError("결과를 저장할 차시를 선택해 주세요.");
      return;
    }
    if (!sourceReady) {
      setError("형성평가에 사용할 강의자료를 선택해 주세요.");
      return;
    }
    if (rangeMode === "페이지 선택" && !pageRange.trim()) {
      setError("출제할 페이지 범위를 입력해 주세요.");
      return;
    }
    if (process.env.NODE_ENV === "development") {
      setError("");
      sessionStorage.setItem(
        "lecturelink-formative-preview",
        JSON.stringify(createPreviewResult(count)),
      );
      router.push("/professor/artifacts/preview#generation-result");
      return;
    }
    setLoading(true);
    setError("");
    setErrorTitle("초안을 만들지 못했습니다.");
    try {
      let selectedMaterialId = materialId;
      if (file) {
        const stored = await uploadTeachingMaterial(courseId, file);
        selectedMaterialId = stored.id;
        setMaterialId(stored.id);
        setMaterialName(stored.file_name);
        await waitForTeachingMaterialReady(courseId, stored.id);
      }
      const form = new FormData();
      form.append("materialId", selectedMaterialId);
      form.append(
        "range",
        rangeMode === "전체 자료" ? "전체 자료" : pageRange.trim(),
      );
      form.append("objective", include);
      form.append("count", String(count));
      form.append("difficulty", difficulty);
      form.append("excluded", excluded);
      form.append("additionalPrompt", additionalPrompt);
      form.append("useImages", String(useImages));

      const response = await fetch("/api/faculty/formative/generate", {
        method: "POST",
        body: form,
      });
      const responseText = await response.text();
      let payload: { ok?: boolean; data?: unknown; error?: { message?: string } };
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(
          response.status >= 500
            ? "AI 생성 서버의 응답이 지연되거나 중단되었습니다. 잠시 후 다시 시도해주세요."
            : "생성 서버의 응답을 확인하지 못했습니다.",
        );
      }
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload?.error?.message ?? "형성평가를 생성하지 못했습니다.",
        );
      }
      const generated = payload.data as GenerateResponse;
      const saveResponse = await fetch(
        `/api/professor/courses/${courseId}/formative`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: generated.title,
            sourceName: materialName || file?.name,
            materialId: selectedMaterialId,
            summary: generated.materialSummary,
            objectives: generated.objectives,
            questions: generated.questions,
          }),
        },
      );
      const saveText = await saveResponse.text();
      let saved: { ok?: boolean; data?: { id?: string }; error?: { message?: string } };
      try {
        saved = JSON.parse(saveText);
      } catch {
        setErrorTitle("초안 저장을 완료하지 못했습니다.");
        throw new Error("생성된 문항의 저장 응답을 확인하지 못했습니다. 다시 시도해주세요.");
      }
      if (!saveResponse.ok || !saved.ok) {
        setErrorTitle("초안 저장을 완료하지 못했습니다.");
        throw new Error(saved?.error?.message ?? "생성한 문항을 저장하지 못했습니다.");
      }
      if (!saved.data?.id) {
        setErrorTitle("초안 저장을 완료하지 못했습니다.");
        throw new Error("저장된 형성평가의 식별 정보를 확인하지 못했습니다.");
      }
      router.push(`/professor/artifacts/${saved.data.id}#generation-result`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "형성평가를 생성하지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="faculty-studio ll-upload-page">
      <Link href="/professor" className="back">
        <ArrowLeft size={16} />
        홈으로
      </Link>
      <header className="page-head">
        <div>
          <p className="eyebrow">교수 도구 · 형성평가</p>
          <h1>
            <span className="headline-accent">형성평가</span>로 이해도를
            확인하세요
          </h1>
          <p className="lead">
            강의자료의 근거를 벗어나지 않는 복습문항을 만들고, 교수 검수 후
            학생에게 전달합니다.
          </p>
        </div>
        <div className="guide">
          <button type="button" className="guide-trigger">
            <span className="guide-icon">?</span><GuideLabel />
          </button>
          <div className="guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li>
                <strong>강의자료 업로드</strong>: 형성평가의 근거가 될 PPTX 또는
                PDF를 올립니다.
              </li>
              <li>
                <strong>문항 설계</strong>: 출제 범위와 학습목표, 난이도를
                선택합니다.
              </li>
              <li>
                <strong>교수 검수</strong>: 생성된 문항을 확인하고 승인한 뒤
                차시에 저장합니다.
              </li>
            </ol>
          </div>
        </div>
      </header>

      <div
        className={
          sourceReady ? "studio-workbench" : "studio-workbench is-upload-only"
        }
      >
        <main className="studio-main">
          <section
            className="studio-section material-section card pad"
            aria-labelledby="material-title"
          >
            <span className="studio-step-number" aria-hidden="true">
              1
            </span>
            <div className="card-head">
              <div>
                <h2 id="material-title">강의자료 업로드</h2>
                <p>
                  형성평가의 근거로 사용할 PPTX 또는 PDF 한 개를 올려주세요.
                </p>
              </div>
              <div className="tag">
                <Badge variant="default">필수</Badge>
              </div>
            </div>
            {sourceReady && (
              <span className="status-copy">
                <ShieldCheck size={15} /> 교수 검수 전 비공개
              </span>
            )}
            <CourseMaterialSelector
              courseId={courseId}
              onCourseId={setCourseId}
              materialId={materialId}
              onMaterialId={setMaterialId}
              file={file}
              onFile={chooseFile}
              accept={ACCEPT}
              onCourseTitle={setCourseTitle}
              onMaterialName={setMaterialName}
            />
          </section>

          {sourceReady && (
            <section
              className="studio-section design-section card pad"
              aria-labelledby="design-title"
            >
              <span className="studio-step-number" aria-hidden="true">
                2
              </span>
              <div className="card-head">
                <div>
                  <h2 id="design-title">문항 설계</h2>
                  <p>프롬프트 대신 수업 의도만 선택하면 됩니다.</p>
                </div>
              </div>

              <div className="form-grid studio-design-grid">
                <div className="design-group full">
                  <div className="design-group-heading">
                    <h3>필수 설정</h3>
                    <div className="tag">
                      <Badge variant="default">필수</Badge>
                    </div>
                  </div>
                  <div className="required-settings-grid">
                    <div className="field full">
                      <span className="field-label">출제 범위</span>
                      <Segmented
                        options={["전체 자료", "페이지 선택"] as const}
                        value={rangeMode}
                        onChange={setRangeMode}
                        ariaLabel="출제 범위"
                      />
                      {rangeMode === "페이지 선택" && (
                        <input
                          className="page-range-input"
                          value={pageRange}
                          maxLength={120}
                          onChange={(event) => setPageRange(event.target.value)}
                          placeholder="예: 1~3, 5, 8~10"
                          aria-label="출제할 페이지"
                        />
                      )}
                    </div>
                    <div className="field">
                      <div className="range-head">
                        <span className="field-label">문항 수</span>
                        <strong className="range-value">
                          {count}
                          <span>문항</span>
                        </strong>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        step="1"
                        value={count}
                        onChange={(event) =>
                          setCount(Number(event.target.value))
                        }
                        aria-label="문항 수"
                      />
                      <div className="range-scale">
                        <span>1</span>
                        <span>5</span>
                        <span>10</span>
                      </div>
                    </div>
                    <div className="field">
                      <span className="field-label">난이도</span>
                      <Segmented
                        options={["하", "중", "상"] as const}
                        value={difficulty}
                        onChange={setDifficulty}
                        ariaLabel="난이도"
                      />
                    </div>
                    <label className="field full image-option">
                      <span className="image-option-control">
                        <input
                          type="checkbox"
                          checked={useImages}
                          onChange={(event) =>
                            setUseImages(event.target.checked)
                          }
                        />
                        <span className="image-option-copy">
                          <strong className="image-option-title">
                            강의자료 이미지 사용
                          </strong>
                          <span className="image-option-description">
                            자료 속 X-ray, CT, ECG, 병리 이미지 등을 분석해 이미지 문항에 활용합니다.
                          </span>
                          <span className="image-option-note">
                            이미지를 사용하면 생성 시간이 조금 더 오래 걸릴 수 있지만, 시각 자료의 임상 맥락을 반영해 문항의 퀄리티를 높일 수 있습니다.
                          </span>
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="design-group full optional-settings">
                  <div className="design-group-heading">
                    <h3>추가 요청</h3>
                    <div className="tag tag-muted">
                      <Badge variant="gray">선택</Badge>
                    </div>
                  </div>
                  <div className="optional-settings-grid">
                    <label className="field">
                      <span className="field-label">
                        강조할 내용 <small>(1~2문항)</small>
                      </span>
                      <textarea
                        maxLength={300}
                        value={include}
                        onChange={(event) => setInclude(event.target.value)}
                        placeholder="예: 항부정맥 약물의 작용 기전"
                      />
                      <small className="formative-field-help">
                        입력한 내용은 전체 문항에 반복하지 않고 1~2문항에서만
                        핵심 주제로 다룹니다.
                      </small>
                      <small className="field-counter">
                        {include.length}/300
                      </small>
                    </label>
                    <label className="field">
                      <span className="field-label">제외할 내용</span>
                      <textarea
                        maxLength={300}
                        value={excluded}
                        onChange={(event) => setExcluded(event.target.value)}
                        placeholder="예: 세부 용량이나 부작용 암기 문항은 제외해 주세요."
                      />
                      <small className="field-counter">
                        {excluded.length}/300
                      </small>
                    </label>
                    <label className="field">
                      <span className="field-label">
                        추가하고 싶은 프롬프트
                      </span>
                      <textarea
                        maxLength={500}
                        value={additionalPrompt}
                        onChange={(event) =>
                          setAdditionalPrompt(event.target.value)
                        }
                        placeholder="문항을 만들 때 추가로 반영할 요청을 자유롭게 입력해 주세요."
                      />
                      <small className="field-counter">
                        {additionalPrompt.length}/500
                      </small>
                    </label>
                  </div>
                </div>
              </div>
            </section>
          )}

          {error && !sourceReady && (
            <div className="studio-error" role="alert">
              <AlertTriangle size={17} />
              {error}
            </div>
          )}

          {result && (
            <section
              className="studio-section review-section card pad"
              aria-labelledby="review-title"
            >
              <div className="card-head">
                <div>
                  <h2 id="review-title">검수할 문항</h2>
                  <p>{result.materialSummary}</p>
                </div>
                <span className="approval-count">{result.questions.length}문항 생성</span>
              </div>
              <div className="objective-strip">
                {result.objectives.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <div className="verification-summary">
                <ShieldCheck size={16} />
                <span>
                  <b>자동 검증 완료</b>
                  {result.reviewSummary}
                </span>
              </div>
              {result.imageAnalysis.requested && (
                <div
                  className={
                    result.imageAnalysis.candidateCount > 0
                      ? "image-analysis-status"
                      : "image-analysis-status is-warning"
                  }
                >
                  {result.imageAnalysis.candidateCount > 0
                    ? `크롭된 이미지 후보 ${result.imageAnalysis.candidateCount}개를 분석했습니다.`
                    : result.imageAnalysis.warnings.join(" ") ||
                      "사용 가능한 이미지 후보를 찾지 못했습니다."}
                </div>
              )}
              <div className="question-list">
                {result.questions.map((question, index) => (
                  <article className="question" key={question.id}>
                    <div className="question-topline">
                      <span className="question-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="question-meta">
                        <span>
                          출제 근거:{" "}
                          {question.sourcePages.length
                            ? `${[...question.sourcePages].sort((a, b) => a - b).join(", ")}쪽`
                            : "자료 전체"}
                        </span>
                      </div>
                    </div>
                    <h3>{question.stem}</h3>
                    {question.imageDataUrl && (
                      <div className="formative-question-image">
                        <img
                          src={question.imageDataUrl}
                          alt={`문항 ${index + 1} 참고 이미지`}
                        />
                      </div>
                    )}
                    <ol>
                      {question.choices.map((choice, choiceIndex) => (
                        <li
                          className={
                            choiceIndex === question.answerIndex
                              ? "is-answer"
                              : ""
                          }
                          key={choice}
                        >
                          <span>{choiceIndex + 1}</span>
                          {choice}
                          {choiceIndex === question.answerIndex && (
                            <Check size={15} />
                          )}
                        </li>
                      ))}
                    </ol>
                    <div className="question-rationale">
                      <b>해설</b>
                      <p>{question.explanation}</p>
                      <small>학습목표 · {question.objective}</small>
                    </div>
                    {question.qualityFlags.length > 0 && (
                      <div className="quality-flags">
                        <AlertTriangle size={15} />
                        <span>{question.qualityFlags.join(" · ")}</span>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>

        {!sourceReady && (
          <div className="studio-flow-arrow" aria-hidden="true">
            <span />
            <ArrowRight size={24} strokeWidth={2.4} />
          </div>
        )}

        {!sourceReady && (
          <UploadNextSteps
            className="studio-next-flow"
            steps={[
              {
                number: 2,
                title: "문항 설계",
                description: "출제 범위·문항 수·난이도를 선택합니다.",
              },
              {
                number: 3,
                title: "형성평가 생성",
                description: "강의자료의 근거 안에서 복습문항 초안을 만듭니다.",
              },
              {
                number: 4,
                title: "검수 후 저장",
                description: "문항을 검토한 뒤 차시에 저장하고 배포합니다.",
              },
            ]}
            footer={
              <>
                먼저 왼쪽 <b className="text-sage-700">1. 강의자료 업로드</b>
                에서 파일을 선택해주세요.
              </>
            }
          />
        )}

        {sourceReady && (
          <aside className="faculty-summary summary summary-hero card pad">
            <div className="card-head">
              <div>
                <h2>형성평가 초안</h2>
                <p>설정을 확인하고 초안 생성을 시작하세요.</p>
              </div>
            </div>
            <dl className="summary-list">
              <div className="summary-item">
                <span>저장할 차시</span>
                <strong>{courseTitle || "차시 선택 필요"}</strong>
              </div>
              <div className="summary-item summary-material">
                <span className="summary-material-label">자료</span>
                <strong
                  className="summary-material-name"
                  title={materialName || file?.name || "선택 전"}
                >
                  {materialName || file?.name || "선택 전"}
                </strong>
              </div>
              <div className="summary-item">
                <span>범위</span>
                <strong>
                  {rangeMode === "전체 자료"
                    ? "전체 자료"
                    : pageRange || "페이지 미입력"}
                </strong>
              </div>
              <div className="summary-item">
                <span>구성</span>
                <strong>
                  {count}문항 · {difficulty}
                </strong>
              </div>
              <div className="summary-item">
                <span>이미지</span>
                <strong>{useImages ? "사용" : "사용 안 함"}</strong>
              </div>
            </dl>
            {error && (
              <div className="summary-generate-error" role="alert">
                <AlertTriangle size={18} />
                <span>
                  <b>{errorTitle}</b>
                  {error}
                </span>
              </div>
            )}
            <button
              className="generate-button primary-btn"
              type="button"
              disabled={
                !courseId ||
                !sourceReady ||
                loading ||
                (rangeMode === "페이지 선택" && !pageRange.trim())
              }
              onClick={generate}
            >
              {loading ? (
                <>
                  <Loader2 className="spin" size={17} />{" "}
                  {useImages ? "자료와 이미지로 문항 생성 중" : "강의자료로 문항 생성 중"}
                </>
              ) : (
                <>
                  초안 생성 <ArrowRight size={17} />
                </>
              )}
            </button>
            <p className="summary-note note">
              AI가 만든 초안입니다. 학생 공개 전 교수의 내용 검수가 필요합니다.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
