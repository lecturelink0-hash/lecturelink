"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  Loader2,
  Printer,
  RefreshCw,
} from "lucide-react";
import "./bridge-artifact-viewer.css";

type BridgeConcept = {
  name: string;
  whyNeeded: string;
  quickReview: string;
  visualCue?: string;
};

type BridgeContent = {
  title?: string;
  topic?: string;
  designStyle?: string;
  courseConnection?: string;
  lectureMap?: string[];
  estimatedMinutes?: number;
  prerequisiteConcepts?: BridgeConcept[];
  coreFlow?: string[];
  commonConfusions?: Array<{ confusion: string; correction: string }>;
  readinessCheck?: Array<{ question: string; answer: string }>;
  visualDataUrl?: string | null;
};

type BridgeArtifact = {
  id: string;
  course_id: string | null;
  type: string;
  title: string;
  source_name: string | null;
  content: BridgeContent | null;
};

const LOCAL_PREVIEW_ARTIFACT: BridgeArtifact = {
  id: "preview-artifact-2",
  course_id: "preview-cardiology",
  type: "preview",
  title: "부정맥 수업 전 핵심 정리",
  source_name: "순환기학_부정맥_강의자료.pdf",
  content: {
    title: "부정맥 수업 전 핵심 정리",
    topic: "부정맥의 분류와 초기 접근",
    designStyle: "medical-clean",
    courseConnection: "심전도 리듬을 해석하기 전에 정상 전도계와 빈맥 분류 기준을 먼저 정리합니다.",
    estimatedMinutes: 10,
    lectureMap: ["정상 전도계", "빈맥 분류", "심전도 접근", "초기 처치"],
    prerequisiteConcepts: [
      {
        name: "심장 전도계",
        quickReview: "동방결절에서 시작된 자극이 방실결절과 히스속을 거쳐 심실로 전달됩니다.",
        whyNeeded: "리듬 이상이 시작된 위치를 추론하는 기준이 됩니다.",
      },
      {
        name: "QRS 폭과 규칙성",
        quickReview: "빈맥은 QRS 폭과 RR 간격의 규칙성을 함께 확인해 분류합니다.",
        whyNeeded: "응급 처치가 필요한 리듬을 빠르게 구분하는 핵심 기준입니다.",
      },
    ],
    coreFlow: ["혈역학적 안정성 확인", "QRS 폭 확인", "리듬 규칙성 확인", "원인과 치료 연결"],
    commonConfusions: [],
    readinessCheck: [
      { question: "넓은 QRS 빈맥에서 먼저 확인할 사항은?", answer: "혈역학적 안정성" },
    ],
    visualDataUrl: null,
  },
};

export function BridgeArtifactViewer({ artifactId }: { artifactId: string }) {
  const localPreview =
    process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === "true";
  const [artifact, setArtifact] = useState<BridgeArtifact | null>(
    localPreview && artifactId === LOCAL_PREVIEW_ARTIFACT.id
      ? LOCAL_PREVIEW_ARTIFACT
      : null,
  );
  const [loading, setLoading] = useState(!artifact);
  const [error, setError] = useState("");

  const loadArtifact = useCallback(async () => {
    if (localPreview && artifactId === LOCAL_PREVIEW_ARTIFACT.id) {
      setArtifact(LOCAL_PREVIEW_ARTIFACT);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/professor/artifacts/${artifactId}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message ?? "예습자료를 불러오지 못했습니다.");
      }
      if (payload.data?.type !== "preview" || !payload.data?.content) {
        throw new Error("열람할 수 있는 예습자료가 아닙니다.");
      }
      setArtifact(payload.data as BridgeArtifact);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "예습자료를 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [artifactId, localPreview]);

  useEffect(() => {
    void loadArtifact();
  }, [loadArtifact]);

  if (loading) {
    return (
      <div className="bridge-viewer-state" role="status">
        <Loader2 className="is-spinning" size={22} aria-hidden="true" />
        저장된 예습자료를 불러오는 중입니다.
      </div>
    );
  }

  if (error || !artifact?.content) {
    return (
      <div className="bridge-viewer-state is-error" role="alert">
        <AlertCircle size={24} aria-hidden="true" />
        <strong>예습자료를 열지 못했습니다.</strong>
        <p>{error || "저장된 결과를 찾을 수 없습니다."}</p>
        <button type="button" onClick={() => void loadArtifact()}>
          <RefreshCw size={16} aria-hidden="true" /> 다시 시도
        </button>
      </div>
    );
  }

  const content = artifact.content;
  const backHref = artifact.course_id
    ? `/professor/courses/${artifact.course_id}`
    : "/professor/courses";

  return (
    <div className="bridge-artifact-viewer ll-upload-page">
      <Link href={backHref} className="back">
        <ArrowLeft size={16} />차시로 돌아가기
      </Link>

      <header className="page-head bridge-viewer-head">
        <div>
          <p className="eyebrow">예습자료 · 열람</p>
          <h1><span className="headline-accent">{content.topic || artifact.title}</span></h1>
          <p className="lead">{content.courseConnection || artifact.title}</p>
        </div>
        <div className="bridge-viewer-actions">
          <button type="button" onClick={() => window.print()}>
            <Printer size={17} aria-hidden="true" />인쇄하기
          </button>
          {content.visualDataUrl && (
            <a href={content.visualDataUrl} download={`${artifact.title}.png`}>
              <Download size={17} aria-hidden="true" />이미지 저장
            </a>
          )}
        </div>
      </header>

      <section className="bridge-viewer-content" aria-label="예습자료 내용">
        {content.visualDataUrl ? (
          <figure className="bridge-viewer-visual">
            {/* Generated data URLs cannot use the optimized image pipeline. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={content.visualDataUrl} alt={`${content.topic || artifact.title} 예습 인포그래픽`} />
          </figure>
        ) : (
          <article className="bridge-viewer-document">
            <header>
              <div>
                <span>PRE-CLASS MAP</span>
                {content.estimatedMinutes && <b>{content.estimatedMinutes}분 복습</b>}
              </div>
              <h2>{content.title || artifact.title}</h2>
            </header>

            {!!content.lectureMap?.length && (
              <section>
                <h3>오늘 수업 한눈에 보기</h3>
                <ol className="bridge-viewer-map">
                  {content.lectureMap.map((item, index) => (
                    <li key={`${item}-${index}`}><span>{index + 1}</span>{item}</li>
                  ))}
                </ol>
              </section>
            )}

            {!!content.prerequisiteConcepts?.length && (
              <section>
                <h3>먼저 떠올릴 개념</h3>
                <div className="bridge-viewer-concepts">
                  {content.prerequisiteConcepts.map((item) => (
                    <div key={item.name}>
                      <h4>{item.name}</h4>
                      <p>{item.quickReview}</p>
                      <small><b>이번 수업에 필요한 이유</b>{item.whyNeeded}</small>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!!content.coreFlow?.length && (
              <section>
                <h3>이번 수업으로 이어지는 흐름</h3>
                <ol className="bridge-viewer-flow">
                  {content.coreFlow.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ol>
              </section>
            )}

            {!!content.readinessCheck?.length && (
              <section>
                <h3>예습 확인 문항</h3>
                <div className="bridge-viewer-checks">
                  {content.readinessCheck.map((item, index) => (
                    <div key={`${item.question}-${index}`}>
                      <b>Q{index + 1}. {item.question}</b>
                      <span>정답 · {item.answer}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </article>
        )}
      </section>
    </div>
  );
}
