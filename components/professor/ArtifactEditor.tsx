"use client";

import { Check, QrCode, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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
          approved: item.approved,
        })),
      }),
    });
    setMessage(response.ok ? "수정사항을 저장했습니다." : "저장하지 못했습니다.");
  }

  async function createLiveSession() {
    await save();
    const response=await fetch(`/api/professor/artifacts/${artifactId}/sessions`,{method:'POST'});
    const payload=await response.json();
    if(payload.ok) router.push(`/professor/live/${payload.data.id}`);
    else setMessage(payload.error?.message ?? '평가 세션을 만들지 못했습니다.');
  }

  const allApproved = data.formative_items.every((item: any) => item.approved);
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
          <button className="professor-primary" disabled={!allApproved} onClick={createLiveSession}>
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
              <label>
                <input
                  type="checkbox"
                  checked={item.approved}
                  onChange={(event) => change(index, "approved", event.target.checked)}
                />
                <Check size={14} /> 교수 승인
              </label>
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
                value={item.explanation}
                onChange={(event) => change(index, "explanation", event.target.value)}
              />
            </label>
            <label className="editor-field">
              학습목표
              <input
                value={item.objective}
                onChange={(event) => change(index, "objective", event.target.value)}
              />
            </label>
          </article>
        ))}
      </div>
    </div>
  );
}
