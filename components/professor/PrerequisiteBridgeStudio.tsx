"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  Clipboard,
  Loader2,
  Printer,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { UploadNextSteps } from "@/components/ui/UploadNextSteps";
import { readApiResponse } from "@/lib/utils/read-api-response";
import {
  CourseMaterialSelector,
  uploadTeachingMaterial,
  waitForTeachingMaterialReady,
} from "./CourseMaterialSelector";
import { ProfessorTaskProgress } from "./ProfessorTaskProgress";
import "@/components/faculty/formative-studio.css";
import "./course-material-selector.css";
import "./prerequisite-bridge.css";

type BridgeResult = {
  artifactId: string;
  title: string;
  topic: string;
  designStyle: "medical-clean" | "hand-drawn" | "blueprint" | "editorial";
  courseConnection: string;
  lectureMap: string[];
  estimatedMinutes: number;
  prerequisiteConcepts: Array<{
    name: string;
    whyNeeded: string;
    quickReview: string;
    visualCue: string;
  }>;
  coreFlow: string[];
  commonConfusions: Array<{ confusion: string; correction: string }>;
  readinessCheck: Array<{ question: string; answer: string }>;
  externalSources: Array<{ title: string; organization: string; url: string }>;
  visualDataUrl?: string | null;
  textAudit?: { status: "passed" | "needs_review"; issues: string[] };
};

const ACCEPT =
  ".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation";
const LEARNERS = [
  "의예과 1학년",
  "의예과 2학년",
  "의학과 1학년",
  "의학과 2학년",
  "의학과 3학년",
  "의학과 4학년",
  "기타",
] as const;
type LearnerLevel = (typeof LEARNERS)[number];
const DESIGN_STYLES = [
  { value: "auto", label: "자동 추천", note: "주제 구조에 맞춰 선택" },
  { value: "medical-clean", label: "메디컬 클린", note: "해부·임상 흐름" },
  { value: "hand-drawn", label: "손그림 노트", note: "기억법·핵심 개념" },
  { value: "blueprint", label: "블루프린트", note: "기전·경로" },
  { value: "editorial", label: "에디토리얼", note: "비교·전체 개요" },
] as const;
type DesignStyle = (typeof DESIGN_STYLES)[number]["value"];

function toPlainText(result: BridgeResult) {
  return [
    result.title,
    result.courseConnection,
    "",
    "먼저 떠올릴 개념",
    ...result.prerequisiteConcepts.map(
      (item, index) =>
        `${index + 1}. ${item.name}\n${item.quickReview}\n왜 필요한가: ${item.whyNeeded}`,
    ),
    "",
    "이번 수업으로 이어지는 흐름",
    ...result.coreFlow.map((item, index) => `${index + 1}. ${item}`),
    ...(result.readinessCheck.length
      ? [
          "",
          "예습 확인 문항",
          ...result.readinessCheck.map(
            (item, index) =>
              `${index + 1}. ${item.question}\n정답: ${item.answer}`,
          ),
        ]
      : []),
  ].join("\n");
}

export function PrerequisiteBridgeStudio() {
  const searchParams = useSearchParams();
  const [file, setFile] = useState<File | null>(null);
  const [learnerLevel, setLearnerLevel] =
    useState<LearnerLevel>("의학과 2학년");
  const [customLearner, setCustomLearner] = useState("");
  const [reviewLength, setReviewLength] = useState("10분");
  const [designStyle, setDesignStyle] = useState<DesignStyle>("auto");
  const [emphasis, setEmphasis] = useState("");
  const [includeReadiness, setIncludeReadiness] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BridgeResult | null>(null);
  const [copied, setCopied] = useState(false);
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
    setResult(null);
    setFile(next);
  }

  async function generate() {
    if (
      !sourceReady ||
      !courseId ||
      (learnerLevel === "기타" && !customLearner.trim())
    )
      return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      let selectedMaterialId = materialId;
      if (file) {
        const stored = await uploadTeachingMaterial(courseId, file);
        selectedMaterialId = stored.id;
        await waitForTeachingMaterialReady(courseId, stored.id);
        setMaterialId(stored.id);
        setMaterialName(stored.file_name);
      }
      const form = new FormData();
      form.append("requestId", crypto.randomUUID());
      form.append("materialId", selectedMaterialId);
      form.append("courseId", courseId);
      form.append(
        "learnerLevel",
        learnerLevel === "기타" ? customLearner.trim() : learnerLevel,
      );
      form.append("reviewLength", reviewLength);
      form.append("designStyle", designStyle);
      form.append("emphasis", emphasis);
      form.append("includeReadiness", String(includeReadiness));
      let response: Response | null = null;
      let lastNetworkError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          response = await fetch("/api/professor/bridge/generate", {
            method: "POST",
            body: form,
          });
          if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
        } catch (networkError) {
          lastNetworkError = networkError;
          if (attempt === 2) throw networkError;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
      if (!response) throw lastNetworkError ?? new Error("예습자료 생성 서버에 연결하지 못했습니다.");
      const payload = await readApiResponse<BridgeResult>(
        response,
        "예습자료를 만들지 못했습니다.",
      );
      if (!response.ok || !payload.ok)
        throw new Error(
          payload?.error?.message ?? "예습자료를 만들지 못했습니다.",
        );
      if (!payload.data) throw new Error("생성된 예습자료를 불러오지 못했습니다.");
      setResult(payload.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "예습자료를 만들지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(toPlainText(result));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="faculty-studio bridge-studio ll-upload-page">
      <Link href="/professor" className="back">
        <ArrowLeft size={16} />
        홈으로
      </Link>

      <header className="page-head">
        <div>
          <p className="eyebrow">교수 도구 · 예습자료</p>
          <h1>
            <span className="headline-accent">예습자료</span>와 함께 수업을
            시작하세요
          </h1>
          <p className="lead">
            업로드한 강의에서 주제를 파악하고, 수업을 이해하는 데 필요한 이전
            단계의 지식만 짧게 되짚어줍니다.
          </p>
        </div>
        <div className="guide">
          <button type="button" className="guide-trigger">
            <span className="guide-icon">?</span>사용 설명서
          </button>
          <div className="guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li>
                <strong>강의자료 업로드</strong>: PPTX 또는 PDF를 올리면 수업
                주제를 자동으로 파악합니다.
              </li>
              <li>
                <strong>예습 범위 설정</strong>: 학습자와 목표 복습시간을
                선택합니다.
              </li>
              <li>
                <strong>교수 검토</strong>: 생성된 한 페이지 예습자료를 확인한
                뒤 학생에게 배포합니다.
              </li>
            </ol>
          </div>
        </div>
      </header>

      <div
        className={
          sourceReady
            ? "studio-workbench bridge-workbench"
            : "studio-workbench bridge-workbench is-upload-only"
        }
      >
        <main className="studio-main">
          <section
            className="studio-section material-section card pad"
            aria-labelledby="bridge-upload-title"
          >
            <span className="studio-step-number" aria-hidden="true">
              1
            </span>
            <div className="card-head">
              <div>
                <h2 id="bridge-upload-title">강의자료 업로드</h2>
                <p>
                  AI가 자료에서 수업 주제와 필요한 선수지식의 범위를 찾습니다.
                </p>
              </div>
              <div className="tag">
                <Badge variant="default">필수</Badge>
              </div>
            </div>
            {sourceReady && (
              <span className="status-copy">
                <ShieldCheck size={15} /> 교수 검토 전 비공개
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
              className="studio-section bridge-settings card pad"
              aria-labelledby="bridge-settings-title"
            >
              <span className="studio-step-number" aria-hidden="true">
                2
              </span>
              <div className="card-head">
                <div>
                  <h2 id="bridge-settings-title">예습자료 설정</h2>
                  <p>학생 수준과 수업 전 복습 분량을 정해주세요.</p>
                </div>
              </div>

              <div className="bridge-controls">
                <div className="design-group full">
                  <div className="design-group-heading">
                    <h3>학습자</h3>
                    <div className="tag">
                      <Badge variant="default">필수</Badge>
                    </div>
                  </div>
                  <Segmented
                    options={LEARNERS}
                    value={learnerLevel}
                    onChange={setLearnerLevel}
                    ariaLabel="학습자"
                  />
                  {learnerLevel === "기타" && (
                    <input
                      className="bridge-text-input"
                      value={customLearner}
                      onChange={(event) => setCustomLearner(event.target.value)}
                      placeholder="학습자 수준을 입력해주세요."
                    />
                  )}
                </div>

                <div className="design-group full">
                  <div className="design-group-heading">
                    <h3>목표 복습시간</h3>
                    <div className="tag">
                      <Badge variant="default">필수</Badge>
                    </div>
                  </div>
                  <Segmented
                    options={["5분", "10분", "15분"] as const}
                    value={reviewLength}
                    onChange={setReviewLength}
                    ariaLabel="목표 복습시간"
                  />
                </div>

                <div className="design-group full bridge-optional">
                  <div className="design-group-heading">
                    <h3>추가 설정</h3>
                    <div className="tag tag-muted">
                      <Badge variant="gray">선택</Badge>
                    </div>
                  </div>
                  <label className="field">
                    <span className="field-label">꼭 연결하고 싶은 개념</span>
                    <textarea
                      value={emphasis}
                      onChange={(event) => setEmphasis(event.target.value)}
                      placeholder="예: SA node 활동전위와 이온채널"
                      maxLength={300}
                    />
                  </label>
                  <label className="bridge-check-option">
                    <input
                      type="checkbox"
                      checked={includeReadiness}
                      onChange={(event) => setIncludeReadiness(event.target.checked)}
                    />
                    <span>
                      <b>선수지식 확인 문항 2개 포함</b>
                      <small>문제 아래에 정답과 짧은 해설이 작게 표시됩니다.</small>
                    </span>
                  </label>
                </div>

                <div className="design-group full">
                  <div className="design-group-heading">
                    <h3>인포그래픽 디자인</h3>
                    <div className="tag"><Badge variant="default">자동 추천</Badge></div>
                  </div>
                  <div className="bridge-style-grid" role="radiogroup" aria-label="인포그래픽 디자인">
                    {DESIGN_STYLES.map((style) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={designStyle === style.value}
                        className={designStyle === style.value ? "is-selected" : ""}
                        onClick={() => setDesignStyle(style.value)}
                        key={style.value}
                      >
                        <b>{style.label}</b><span>{style.note}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {error && (
            <div className="studio-error" role="alert">
              <AlertTriangle size={17} />
              {error}
            </div>
          )}

          {loading && (
            <ProfessorTaskProgress description="강의자료를 분석하고 한 페이지 예습 인포그래픽을 생성한 뒤 글자와 의학 내용을 검수하고 있습니다." />
          )}

          {result && (
            <article className={`bridge-result bridge-infographic style-${result.designStyle} ${result.visualDataUrl ? "has-generated-image" : ""} card pad`}>
              <div className="bridge-result-bar">
                <div>
                  <span>AI 초안 · 교수 검토 필요</span>
                  <b>{result.estimatedMinutes}분 복습</b>
                </div>
                <div>
                  <button type="button" onClick={copyResult}>
                    {copied ? <Check size={16} /> : <Clipboard size={16} />}
                    {copied ? "복사됨" : "텍스트 복사"}
                  </button>
                  <button type="button" onClick={() => window.print()}>
                    <Printer size={16} />
                    PDF 저장·인쇄
                  </button>
                </div>
              </div>
              <header>
                <img className="bridge-logo" src="/lecturelink-mark.png" alt="LectureLink" />
                <span className="bridge-topic">PRE-CLASS MAP · {result.topic}</span>
                <h2>{result.title}</h2>
                <p>{result.courseConnection}</p>
              </header>
              <section className="bridge-map-section">
                <h3>오늘 수업 한눈에 보기</h3>
                <ol className="bridge-lecture-map">
                  {result.lectureMap.map((item, index) => <li key={item}><span>{index + 1}</span>{item}</li>)}
                </ol>
              </section>
              {result.visualDataUrl && (
                <figure className="bridge-hero-visual">
                  <img src={result.visualDataUrl} alt={`${result.topic} 완성형 예습 인포그래픽`} />
                </figure>
              )}
              {result.visualDataUrl && result.textAudit && (
                <div className={`bridge-audit ${result.textAudit.status}`}>
                  <ShieldCheck size={15} />
                  <div>
                    <b>{result.textAudit.status === "passed" ? "자동 글자·내용 검수 통과" : "교수 검토가 필요한 항목이 있습니다"}</b>
                    {result.textAudit.issues.length > 0 && <p>{result.textAudit.issues.join(" · ")}</p>}
                  </div>
                </div>
              )}
              <section>
                <h3>먼저 떠올릴 개념</h3>
                {result.prerequisiteConcepts.map((item, index) => (
                  <div className="bridge-concept" key={item.name}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h4>{item.name}</h4>
                      <p>{item.quickReview}</p>
                      <div className="bridge-visual-cue" aria-label="시각 자료 설명">{item.visualCue}</div>
                      <small>
                        <b>이번 수업에 필요한 이유</b>
                        {item.whyNeeded}
                      </small>
                    </div>
                  </div>
                ))}
              </section>
              <section>
                <h3>이번 수업으로 이어지는 흐름</h3>
                <ol className="bridge-flow">
                  {result.coreFlow.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </section>
              {result.commonConfusions.length > 0 && (
                <section>
                  <h3>헷갈리기 쉬운 지점</h3>
                  <div className="bridge-confusions">
                    {result.commonConfusions.map((item) => (
                      <div key={item.confusion}>
                        <b>{item.confusion}</b>
                        <p>{item.correction}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {result.readinessCheck.length > 0 && (
                <section>
                  <h3>예습 확인 문항</h3>
                  <div className="bridge-checks">
                    {result.readinessCheck.map((item, index) => (
                      <div className="bridge-question" key={item.question}>
                        <b>Q{index + 1}. {item.question}</b>
                        <small>정답 · {item.answer}</small>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <footer className="bridge-sources">
                <b>검증된 외부 의학자료</b>
                {result.externalSources.map((source, index) => (
                  <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{index + 1}. {source.organization} · {source.title}</a>
                ))}
              </footer>
            </article>
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
                title: "수업 주제 자동 파악",
                description:
                  "강의자료에서 이번 수업의 핵심 주제와 임상 맥락을 찾습니다.",
              },
              {
                number: 3,
                title: "선수지식 선별",
                description:
                  "학생이 이미 배웠지만 다시 떠올려야 할 기초 개념만 고릅니다.",
              },
              {
                number: 4,
                title: "예습자료 생성·검토",
                description:
                  "한 페이지 분량의 초안을 만들고 선택 시 확인 문항 2개를 추가합니다.",
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
                <h2>예습자료 초안</h2>
                <p>설정을 확인하고 생성을 시작하세요.</p>
              </div>
            </div>
            <dl className="summary-list">
              <div className="summary-item">
                <span>저장할 차시</span>
                <strong>{courseTitle || "차시 선택 필요"}</strong>
              </div>
              <div className="summary-item">
                <span>자료</span>
                <strong>{materialName || file?.name || "선택 전"}</strong>
              </div>
              <div className="summary-item">
                <span>학습자</span>
                <strong>
                  {learnerLevel === "기타"
                    ? customLearner || "직접 입력"
                    : learnerLevel}
                </strong>
              </div>
              <div className="summary-item">
                <span>분량</span>
                <strong>{reviewLength}</strong>
              </div>
              <div className="summary-item">
                <span>디자인</span>
                <strong>{DESIGN_STYLES.find((style) => style.value === designStyle)?.label}</strong>
              </div>
              <div className="summary-item">
                <span>확인 문항</span>
                <strong>{includeReadiness ? "선수지식 2문항" : "포함 안 함"}</strong>
              </div>
            </dl>
            <button
              className="generate-button primary-btn"
              type="button"
              disabled={
                !sourceReady ||
                !courseId ||
                loading ||
                (learnerLevel === "기타" && !customLearner.trim())
              }
              onClick={generate}
            >
              {loading ? (
                <>
                  <Loader2 className="spin" size={17} />
                  초안 생성 중
                </>
              ) : (
                <>
                  예습자료 만들기 <ArrowRight size={17} />
                </>
              )}
            </button>
            {result?.artifactId && (
              <Link
                className="workspace-return"
                href={`/professor/courses/${courseId}`}
              >
                저장됨 · 차시로 돌아가기
              </Link>
            )}
            <p className="summary-note note">
              <BookOpenCheck size={14} />
              결과는 차시에 저장되며 학생 공개 전 교수 검토가 필요합니다.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
