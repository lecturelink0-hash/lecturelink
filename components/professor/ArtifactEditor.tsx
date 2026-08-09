"use client";

import { Plus, QrCode, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import "./artifact-editor-extra.css";

export function ArtifactEditor({ artifactId }: { artifactId: string }) {
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  const router = useRouter();

  useEffect(() => {
    fetch(`/api/professor/artifacts/${artifactId}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.ok) return;
        setData({
          ...payload.data,
          formative_items: [...payload.data.formative_items].sort(
            (a: any, b: any) => a.position - b.position,
          ),
        });
      });
  }, [artifactId]);

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
    setMessage(response.ok ? "수정사항을 저장했습니다." : "저장하지 못했습니다.");
    return response.ok;
  }

  async function createLiveSession() {
    if (!(await save())) return;
    const response=await fetch(`/api/professor/artifacts/${artifactId}/sessions`,{method:'POST'});
    const payload=await response.json();
    if(payload.ok) router.push(`/professor/live/${payload.data.id}`);
    else setMessage(payload.error?.message ?? '평가 세션을 만들지 못했습니다.');
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
  return (
    <div className="professor-dashboard">
      <header className="professor-welcome">
        <div>
          <p>형성평가 검토 · {data.status}</p>
          <input
            className="artifact-title"
            value={data.title}
            onChange={(event) => setData({ ...data, title: event.target.value })}
          />
        </div>
        <div className="editor-actions">
          <button className="professor-primary" onClick={save}>
            <Save size={16} /> 저장
          </button>
          <button className="professor-primary" disabled={!canDistribute} onClick={createLiveSession}>
            <QrCode size={16} /> 학생에게 QR로 배포하기
          </button>
        </div>
      </header>

      <section className="analytics-grid" aria-label="이 형성평가의 학생 결과">
        <div>
          <small>제출 학생</small>
          <b>{data.analytics?.submittedCount ?? 0}명</b>
        </div>
        <div>
          <small>평균 정답률</small>
          <b>
            {data.analytics?.averagePercent === null ||
            data.analytics?.averagePercent === undefined
              ? "—"
              : `${data.analytics.averagePercent}%`}
          </b>
        </div>
      </section>

      {message && <div className="editor-message">{message}</div>}
      <div className="editor-list">
        {data.formative_items.map((item: any, index: number) => (
          <article className="editor-card" key={item.id}>
            <div className="editor-card-head">
              <b>문항 {index + 1}</b>
              <button className="editor-delete" type="button" onClick={() => deleteQuestion(item.id)}>
                <Trash2 size={15} /> 문항 삭제
              </button>
            </div>
            <textarea
              value={item.stem}
              onChange={(event) => change(index, "stem", event.target.value)}
            />
            {item.image_data_url && (
              <div className="formative-question-image">
                <img src={item.image_data_url} alt={`문항 ${index + 1} 참고 이미지`} />
              </div>
            )}
            {item.choices.map((choice: string, choiceIndex: number) => (
              <div className="choice-edit" key={choiceIndex}>
                <input
                  type="radio"
                  checked={item.answer_index === choiceIndex}
                  onChange={() => change(index, "answer_index", choiceIndex)}
                />
                <input
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
              </div>
            ))}
            <label className="editor-field">
              해설
              <textarea
                rows={8}
                value={item.explanation}
                onChange={(event) => change(index, "explanation", event.target.value)}
              />
            </label>
          </article>
        ))}
        <button className="editor-add" type="button" onClick={addQuestion}>
          <Plus size={17} /> 직접 문항 추가하기
        </button>
      </div>
    </div>
  );
}
