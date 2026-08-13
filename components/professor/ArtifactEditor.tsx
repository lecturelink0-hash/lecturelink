"use client";

import { ClipboardList, Info, Pencil, Plus, QrCode, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { readApiResponse } from "@/lib/utils/read-api-response";
import "./artifact-editor-extra.css";
import "../formative/formative-flow.css";

const DEFAULT_PREVIEW_ARTIFACT = {
  id: "preview",
  title: "형성평가 검토하기",
  source_name: "순환기학_부정맥_강의자료.pdf",
  status: "교수 검토 중",
  analytics: { submittedCount: 0, averagePercent: null },
  formative_items: [
    {
      id: "preview-1",
      position: 0,
      stem: "다음 중 이 강의에서 설명한 핵심 개념으로 가장 적절한 것은?",
      choices: ["핵심 개념에 대한 첫 번째 설명", "서로 관련이 적은 두 번째 설명", "강의 범위를 벗어난 세 번째 설명", "반대 의미를 가진 네 번째 설명", "추가 확인이 필요한 다섯 번째 설명"],
      answer_index: 0,
      explanation: "첫 번째 선택지는 강의자료의 핵심 내용을 정확하게 요약합니다. 나머지 선택지는 범위가 다르거나 핵심 개념과 일치하지 않습니다.",
      objective: "강의의 핵심 개념을 구분하고 설명할 수 있다.",
      approved: true,
      image_data_url: null,
    },
    {
      id: "preview-2",
      position: 1,
      stem: "강의에서 제시한 내용을 실제 상황에 적용한 예로 가장 적절한 것은?",
      choices: ["조건을 일부만 반영한 사례", "핵심 조건을 모두 반영한 사례", "결과와 원인을 반대로 연결한 사례", "자료에서 다루지 않은 사례", "판단에 필요한 정보가 부족한 사례"],
      answer_index: 1,
      explanation: "두 번째 사례는 강의에서 제시한 조건과 판단 순서를 모두 반영하고 있어 가장 적절합니다.",
      objective: "학습한 원리를 간단한 상황에 적용할 수 있다.",
      approved: true,
      image_data_url: null,
    },
    {
      id: "preview-3",
      position: 2,
      stem: "다음 설명 중 강의자료의 내용과 일치하지 않는 것은?",
      choices: ["주요 정의에 관한 설명", "기본 원리에 관한 설명", "판단 순서에 관한 설명", "강의 내용과 반대되는 설명", "주의사항에 관한 설명"],
      answer_index: 3,
      explanation: "네 번째 선택지는 강의에서 설명한 방향과 반대이므로 옳지 않습니다.",
      objective: "핵심 설명과 잘못된 설명을 구분할 수 있다.",
      approved: true,
      image_data_url: null,
    },
  ],
};

export function ArtifactEditor({ artifactId }: { artifactId: string }) {
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const reviewLayoutRef = useRef<HTMLDivElement>(null);
  const reviewHelperRef = useRef<HTMLElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (artifactId === "preview" && process.env.NODE_ENV === "development") {
      const stored = sessionStorage.getItem("lecturelink-formative-preview");
      if (stored) {
        try {
          const generated = JSON.parse(stored);
          setData({
            ...DEFAULT_PREVIEW_ARTIFACT,
            title: generated.title ?? DEFAULT_PREVIEW_ARTIFACT.title,
            formative_items: (generated.questions ?? []).map((item: any, index: number) => ({
              id: item.id ?? `preview-${index + 1}`,
              position: index,
              stem: item.stem,
              choices: item.choices,
              answer_index: item.answerIndex,
              explanation: item.explanation,
              objective: item.objective,
              approved: true,
              image_data_url: item.imageDataUrl ?? null,
            })),
          });
          return;
        } catch {
          sessionStorage.removeItem("lecturelink-formative-preview");
        }
      }
      setData(DEFAULT_PREVIEW_ARTIFACT);
      return;
    }
    setLoadError("");
    fetch(`/api/professor/artifacts/${artifactId}`)
      .then(async (response) => ({ response, payload: await readApiResponse<any>(response, "문항을 불러오지 못했습니다.") }))
      .then(({ response, payload }) => {
        if (!response.ok || !payload.ok || !payload.data) {
          setLoadError(payload.error?.message ?? "문항을 불러오지 못했습니다.");
          return;
        }
        setData({
          ...payload.data,
          formative_items: [...payload.data.formative_items].sort(
            (a: any, b: any) => a.position - b.position,
          ),
        });
      })
      .catch((cause) => setLoadError(cause instanceof Error ? cause.message : "문항을 불러오지 못했습니다."));
  }, [artifactId]);

  useEffect(() => {
    const layout = reviewLayoutRef.current;
    const helper = reviewHelperRef.current;
    if (!layout || !helper) return;

    const compactLayout = window.matchMedia("(max-width: 900px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let targetPosition = 0;
    let currentPosition = 0;
    let animationFrame = 0;

    const renderPosition = () => {
      const distance = targetPosition - currentPosition;
      currentPosition = reducedMotion.matches
        ? targetPosition
        : currentPosition + distance * 0.16;
      if (Math.abs(targetPosition - currentPosition) < 0.15) {
        currentPosition = targetPosition;
      }
      helper.style.transform = `translate3d(0, ${currentPosition.toFixed(2)}px, 0)`;
      helper.classList.toggle("is-following", currentPosition > 4);
      if (Math.abs(targetPosition - currentPosition) >= 0.15) {
        animationFrame = window.requestAnimationFrame(renderPosition);
      } else {
        animationFrame = 0;
      }
    };

    const updateTarget = () => {
      if (compactLayout.matches) {
        targetPosition = 0;
        currentPosition = 0;
        helper.style.transform = "";
        helper.classList.remove("is-following");
        return;
      }
      const layoutTop = layout.getBoundingClientRect().top + window.scrollY;
      const availableTravel = Math.max(0, layout.offsetHeight - helper.offsetHeight);
      targetPosition = Math.min(
        availableTravel,
        Math.max(0, window.scrollY + 84 - layoutTop),
      );
      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(renderPosition);
      }
    };

    const resizeObserver = new ResizeObserver(updateTarget);
    resizeObserver.observe(layout);
    resizeObserver.observe(helper);
    window.addEventListener("scroll", updateTarget, { passive: true });
    window.addEventListener("resize", updateTarget, { passive: true });
    compactLayout.addEventListener("change", updateTarget);
    reducedMotion.addEventListener("change", updateTarget);
    updateTarget();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", updateTarget);
      window.removeEventListener("resize", updateTarget);
      compactLayout.removeEventListener("change", updateTarget);
      reducedMotion.removeEventListener("change", updateTarget);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [data?.formative_items?.length]);

  if (loadError) {
    return <div className="professor-empty" role="alert"><p>{loadError}</p><button type="button" className="professor-secondary" onClick={() => window.location.reload()}>다시 시도</button></div>;
  }
  if (!data) {
    return <div className="professor-empty">문항을 불러오는 중입니다.</div>;
  }

  function change(index: number, key: string, value: any) {
    setData((current: any) => ({
      ...current,
      formative_items: current.formative_items.map((item: any, itemIndex: number) =>
        itemIndex === index ? { ...item, [key]: value } : item,
      ),
    }));
  }

  async function save() {
    if (saving) return false;
    if (artifactId === "preview" && process.env.NODE_ENV === "development") {
      setMessage("미리보기 초안의 수정사항을 임시로 반영했습니다.");
      return true;
    }
    setSaving(true);
    setMessage("");
    try {
    const response = await fetch(`/api/professor/artifacts/${artifactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: data.title,
        items: data.formative_items.map((item: any) => ({
          id: item.id,
          stem: item.stem,
          choices: item.choices,
          answerIndex: item.answer_index,
          explanation: item.explanation,
          objective: item.objective,
        })),
      }),
    });
    const payload = await readApiResponse<{ saved: boolean }>(response, "수정사항을 저장하지 못했습니다.");
    if (!response.ok || !payload.ok) {
      setMessage(payload.error?.message ?? "수정사항을 저장하지 못했습니다.");
      return false;
    }
    setMessage("수정사항을 저장했습니다.");
    return true;
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "수정사항을 저장하지 못했습니다.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function createLiveSession() {
    if (creatingSession) return;
    setCreatingSession(true);
    try {
    if (!(await save())) return;
    if (artifactId === "preview" && process.env.NODE_ENV === "development") {
      window.location.href = "/professor/live/preview";
      return;
    }
    const response=await fetch(`/api/professor/artifacts/${artifactId}/sessions`,{method:'POST'});
    const payload=await readApiResponse<{id:string}>(response,'평가 세션을 만들지 못했습니다.');
    if(response.ok && payload.ok && payload.data) router.push(`/professor/live/${payload.data.id}`);
    else setMessage(payload.error?.message ?? '평가 세션을 만들지 못했습니다.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '평가 세션을 만들지 못했습니다.');
    } finally {
      setCreatingSession(false);
    }
  }

  function addQuestion() {
    setData((current: any) => ({
      ...current,
      formative_items: [...current.formative_items, {
        id: crypto.randomUUID(), position: current.formative_items.length,
        stem: "새 문항의 질문을 입력하세요.",
        choices: ["선택지 1", "선택지 2", "선택지 3", "선택지 4", "선택지 5"],
        answer_index: 0, explanation: "정답의 근거와 핵심 해설을 입력하세요.",
        objective: "학습목표를 입력하세요.", approved: true,
      }],
    }));
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
  }

  function deleteQuestion(id: string) {
    if (data.formative_items.length === 1) {
      setMessage("형성평가에는 문항이 한 개 이상 필요합니다.");
      return;
    }
    if (!confirm("이 문항을 삭제할까요? 저장하면 되돌릴 수 없습니다.")) return;
    setData((current: any) => ({
      ...current,
      formative_items: current.formative_items.filter((item: any) => item.id !== id),
    }));
  }

  const canDistribute = data.formative_items.length > 0;
  const answerCounts = data.formative_items.reduce((counts: number[], item: any) => {
    counts[item.answer_index] = (counts[item.answer_index] ?? 0) + 1;
    return counts;
  }, []);
  const [mostCommonAnswerIndex, mostCommonAnswerCount] = answerCounts.reduce(
    (mostCommon: [number, number], count: number, index: number) =>
      count > mostCommon[1] ? [index, count] : mostCommon,
    [0, 0],
  );
  const isAnswerSkewed =
    mostCommonAnswerCount >= 2 &&
    mostCommonAnswerCount / data.formative_items.length >= 0.5;
  const answerBalanceLabel = isAnswerSkewed
    ? `불균형함 (${mostCommonAnswerIndex + 1}번 편중)`
    : "고르게 분포";
  return (
    <div className="professor-dashboard ll-formative-flow ll-formative-review">
      <header className="professor-welcome">
        <div>
          <p className="flow-eyebrow">교수 도구 · 검토 후 배포</p>
          {artifactId === "preview" && data.title === DEFAULT_PREVIEW_ARTIFACT.title ? (
            <h1 className="artifact-title artifact-preview-title">
              <span>형성평가</span> 검토하기
            </h1>
          ) : (
            <div className="artifact-title-composite">
              <input
                aria-label="형성평가 제목"
                className="artifact-title"
                value={data.title}
                onChange={(event) => setData({ ...data, title: event.target.value })}
              />
              <span className="artifact-title-suffix">형성평가</span>
            </div>
          )}
          <p className="flow-lead">
            생성된 문항과 정답·해설을 확인하고 필요한 내용을 수정한 뒤 학생에게
            배포하세요.
          </p>
        </div>
        <div className="flow-header-tools">
          <div className="formative-guide">
            <button type="button" className="formative-guide-trigger">
              <span className="formative-guide-icon">?</span>
              사용 설명서
            </button>
            <div className="formative-guide-panel">
              <h2>어떻게 사용하나요?</h2>
              <ol>
                <li><strong>문항 검토</strong>: 지문, 정답과 해설을 확인하고 필요한 부분을 수정합니다.</li>
                <li><strong>수정사항 저장</strong>: 검토가 끝난 내용을 먼저 저장합니다.</li>
                <li><strong>학생 배포</strong>: QR 평가실을 열어 학생에게 공유합니다.</li>
              </ol>
            </div>
          </div>
          <div className="editor-actions">
            <button className="professor-primary" disabled={saving || creatingSession} onClick={save}>
              <Save size={16} /> {saving ? "저장 중" : "저장"}
            </button>
            <button className="professor-primary" disabled={!canDistribute || saving || creatingSession} onClick={createLiveSession}>
              <QrCode size={16} /> {creatingSession ? "평가실 만드는 중" : "학생에게 QR로 배포하기"}
            </button>
          </div>
        </div>
      </header>

      {message && <div className="editor-message" role="status" aria-live="polite">{message}</div>}
      <div className="artifact-review-layout" ref={reviewLayoutRef}>
        <div className="editor-list">
          {data.formative_items.map((item: any, index: number) => (
          <article className="editor-card" key={item.id}>
            <div className="editor-card-head">
              <b>문항 {index + 1}</b>
              <button
                className="editor-delete"
                type="button"
                aria-label={`문항 ${index + 1} 삭제`}
                onClick={() => deleteQuestion(item.id)}
              >
                <Trash2 size={15} /> 문항 삭제
              </button>
            </div>
            <div className="editable-field editable-stem">
              <textarea
                aria-label={`문항 ${index + 1} 지문`}
                value={item.stem}
                onChange={(event) => change(index, "stem", event.target.value)}
              />
              <Pencil className="edit-cue" aria-hidden="true" />
            </div>
            {item.image_data_url && (
              <div className="formative-question-image">
                <img src={item.image_data_url} alt={`문항 ${index + 1} 참고 이미지`} />
              </div>
            )}
            {item.choices.map((choice: string, choiceIndex: number) => (
              <div className="choice-edit" key={choiceIndex}>
                <input
                  type="radio"
                  name={`question-${item.id}-answer`}
                  aria-label={`문항 ${index + 1}의 ${choiceIndex + 1}번 선택지를 정답으로 지정`}
                  checked={item.answer_index === choiceIndex}
                  onChange={() => change(index, "answer_index", choiceIndex)}
                />
                <input
                  aria-label={`문항 ${index + 1} 선택지 ${choiceIndex + 1}`}
                  value={choice}
                  onChange={(event) =>
                    change(
                      index,
                      "choices",
                      item.choices.map((value: string, valueIndex: number) =>
                        valueIndex === choiceIndex ? event.target.value : value,
                      ),
                    )
                  }
                />
                <Pencil className="edit-cue" aria-hidden="true" />
              </div>
            ))}
            <label className="editor-field">
              <span className="editor-field-label">해설</span>
              <div className="editable-field">
                <textarea
                  rows={8}
                  value={item.explanation}
                  onChange={(event) => change(index, "explanation", event.target.value)}
                />
                <Pencil className="edit-cue" aria-hidden="true" />
              </div>
            </label>
          </article>
          ))}
          <button className="editor-add" type="button" onClick={addQuestion}>
            <Plus size={17} /> 직접 문항 추가하기
          </button>
        </div>

        <aside
          className="artifact-review-helper"
          aria-labelledby="artifact-review-helper-title"
          ref={reviewHelperRef}
        >
          <header>
            <div>
              <h2 id="artifact-review-helper-title">검토 도우미</h2>
              <p>배포 전 전체 구성을 한눈에 확인하세요.</p>
            </div>
            <ClipboardList size={21} aria-hidden="true" />
          </header>
          <dl>
            <div>
              <dt>문항 수</dt>
              <dd>{data.formative_items.length}문항</dd>
            </div>
            <div>
              <dt>사용한 자료</dt>
              <dd>{data.source_name || "직접 입력"}</dd>
            </div>
            <div>
              <dt>정답 위치 분포</dt>
              <dd className={isAnswerSkewed ? "is-skewed" : "is-balanced"} aria-live="polite">
                <span aria-hidden="true" />
                {answerBalanceLabel}
              </dd>
            </div>
          </dl>
          <p className="artifact-review-helper-note">
            <Info size={15} aria-hidden="true" />
            정답이 특정 번호에 몰리면 배포 전에 알려드립니다.
          </p>
          <div className="artifact-review-helper-actions">
            <button type="button" disabled={saving || creatingSession} onClick={save}>
              <Save size={16} /> {saving ? "저장 중" : "수정사항 저장"}
            </button>
            <button type="button" disabled={!canDistribute || saving || creatingSession} onClick={createLiveSession}>
              <QrCode size={16} /> {creatingSession ? "평가실 만드는 중" : "학생에게 QR로 배포하기"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
