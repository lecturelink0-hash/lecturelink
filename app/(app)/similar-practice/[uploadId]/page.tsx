'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';

interface PracticeQuestion {
  id: string;
  stem: string;
  choices: string[];
  difficulty: 1 | 2 | 3;
  sub_topic_name: string | null;
  subject_name: string | null;
}

interface AttemptResult {
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}

export default function SimilarPracticePage() {
  const { uploadId } = useParams<{ uploadId: string }>();
  const [questions, setQuestions] = useState<PracticeQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ items: PracticeQuestion[] }>(`/api/private-questions?upload_id=${uploadId}&limit=3&mode=quiz`)
      .then((response) => setQuestions(response.items))
      .catch((error) => alert(error instanceof ApiError ? error.message : '문항을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [uploadId]);

  async function submit() {
    if (selected === null) return;
    const response = await api.post<AttemptResult>('/api/attempts', {
      question_id: questions[index].id,
      selected_index: selected,
      time_spent_seconds: 30,
      track: 'lecture_note',
    });
    setResult(response);
  }

  function next() {
    setIndex((value) => value + 1);
    setSelected(null);
    setResult(null);
  }

  if (loading) return <div className="content py-16 text-center text-[var(--color-muted)]">문제집을 불러오는 중입니다...</div>;
  if (!questions.length) return <div className="content py-16 text-center">생성된 문항이 없습니다.</div>;

  const question = questions[index];
  const finished = index >= questions.length - 1 && result;
  return (
    <div className="content max-w-3xl mx-auto">
      <section className="page-head">
        <div>
          <span className="eyebrow">오답 유사문항 · {index + 1}/{questions.length}</span>
          <h1><span className="headline-accent">유사문항 3제</span>를 풀어보세요</h1>
          <p className="lead">생성된 문제는 이미 내 문제집에 저장되었습니다.</p>
        </div>
      </section>
      <article className="ll-card p-6">
        <div className="text-sm font-semibold text-[var(--color-muted)] mb-3">{question.subject_name} · {question.sub_topic_name}</div>
        <p className="text-[16px] leading-7 font-semibold mb-5">{question.stem}</p>
        <div className="space-y-2">
          {question.choices.map((choice, choiceIndex) => {
            const correct = result && choiceIndex === result.correct_index;
            const wrong = result && choiceIndex === selected && !result.is_correct;
            return (
              <button key={choiceIndex} type="button" disabled={!!result} onClick={() => setSelected(choiceIndex)}
                className={`w-full rounded-lg border p-3 text-left ${correct ? 'border-sage-600 bg-[var(--color-curated-bg)]' : wrong ? 'border-[var(--color-warn)] bg-[var(--color-warn-bg)]' : selected === choiceIndex ? 'border-sage-600 bg-[var(--color-sage-100)]' : 'border-[var(--color-border)] bg-white'}`}>
                {choiceIndex + 1}. {choice}
              </button>
            );
          })}
        </div>
        {result?.explanation && <div className="mt-5 rounded-lg bg-[var(--color-sage-100)] p-4 text-sm leading-6"><strong>해설</strong><p className="mt-1">{result.explanation}</p></div>}
        <div className="mt-5 flex gap-2">
          {!result && <Button onClick={submit} disabled={selected === null}>정답 확인</Button>}
          {result && !finished && <Button onClick={next}>다음 문항</Button>}
          {finished && <Link href="/library"><Button>내 문제집에서 보기</Button></Link>}
        </div>
      </article>
    </div>
  );
}
