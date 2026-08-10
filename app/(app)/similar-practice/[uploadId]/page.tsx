'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { QuestionStem } from '@/components/ui/QuestionStem';
import { BookOpen, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, XCircle } from 'lucide-react';

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

interface AttemptRecord extends AttemptResult {
  selected_index: number;
}

export default function SimilarPracticePage() {
  const { uploadId } = useParams<{ uploadId: string }>();
  const [questions, setQuestions] = useState<PracticeQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [attempts, setAttempts] = useState<Record<string, AttemptRecord>>({});
  const [showQuestionGrid, setShowQuestionGrid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<{ items: PracticeQuestion[] }>(`/api/private-questions?upload_id=${uploadId}&limit=50&mode=quiz`)
      .then((response) => setQuestions(response.items))
      .catch((error) => alert(error instanceof ApiError ? error.message : '문항을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [uploadId]);

  if (loading) return <div className="content py-16 text-center text-[var(--color-muted)]">문항을 불러오는 중입니다...</div>;
  if (!questions.length) return <div className="content py-16 text-center">생성된 문항이 없습니다.</div>;

  const question = questions[index];
  const attempt = attempts[question.id];
  const selected = attempt?.selected_index ?? selections[question.id] ?? null;
  const completedQuestionIds = new Set(Object.keys(attempts));

  function goToQuestion(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= questions.length) return;
    setIndex(nextIndex);
    setShowQuestionGrid(false);
  }

  function selectChoice(choiceIndex: number) {
    if (attempt) return;
    setSelections((previous) => ({ ...previous, [question.id]: choiceIndex }));
  }

  async function submit() {
    if (selected === null || attempt) return;
    setSubmitting(true);
    try {
      const response = await api.post<AttemptResult>('/api/attempts', {
        question_id: question.id,
        selected_index: selected,
        time_spent_seconds: 30,
        track: 'lecture_note',
      });
      setAttempts((previous) => ({ ...previous, [question.id]: { ...response, selected_index: selected } }));
    } catch (error) {
      alert(error instanceof ApiError ? error.message : '제출에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ll-exam-page content max-w-4xl mx-auto">
      <Link href="/wrong-notes" className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-muted)] hover:text-sage-800 transition-colors mb-3">
        <ChevronLeft className="w-4 h-4" /> 오답노트로 돌아가기
      </Link>

      <div className="ll-card p-5 mb-4">
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem' }}><BookOpen className="w-4 h-4" strokeWidth={2} /></span>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-sage-600">{question.subject_name ?? '유사문항'}</div>
              <div className="text-[15px] font-bold text-sage-800 tracking-tight truncate">{question.sub_topic_name ?? '오답 유사문항'}</div>
            </div>
          </div>
          <div className="relative flex items-center gap-1.5">
            <button type="button" onClick={() => goToQuestion(index - 1)} disabled={index === 0} aria-label="이전 문항" className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] bg-white text-sage-700 transition-colors hover:border-sage-400 disabled:cursor-not-allowed disabled:opacity-35"><ChevronLeft className="h-4 w-4" /></button>
            <div className="relative">
              <button type="button" onClick={() => setShowQuestionGrid((open) => !open)} aria-expanded={showQuestionGrid} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-white px-2.5 text-sm font-semibold text-sage-800 transition-colors hover:border-sage-400">문항 <span className="tnum">{index + 1}/{questions.length}</span><ChevronDown className={`h-3.5 w-3.5 text-[var(--color-muted)] transition-transform ${showQuestionGrid ? 'rotate-180' : ''}`} /></button>
              {showQuestionGrid && <div className="absolute right-0 top-10 z-30 w-56 rounded-xl border border-[var(--color-border)] bg-white p-2.5 shadow-[0_16px_36px_rgba(31,46,40,0.16)]">
                <div className="mb-2 flex items-center justify-between text-[11px]"><span className="font-bold text-sage-800">문항 선택</span><span className="inline-flex items-center gap-1.5 text-[var(--color-muted)]"><i className="h-2 w-2 rounded-full bg-sage-200" />풀이 완료</span></div>
                <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
                  {questions.map((item, questionIndex) => {
                    const isCurrent = questionIndex === index;
                    const isCompleted = completedQuestionIds.has(item.id);
                    return <button key={item.id} type="button" onClick={() => goToQuestion(questionIndex)} className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold transition-colors ${isCurrent ? 'border-sage-700 bg-sage-700 text-white' : isCompleted ? 'border-sage-200 bg-[var(--color-sage-100)] text-sage-700 hover:border-sage-400' : 'border-[var(--color-border)] bg-white text-sage-700 hover:border-sage-400'}`}>{questionIndex + 1}</button>;
                  })}
                </div>
              </div>}
            </div>
            <button type="button" onClick={() => goToQuestion(index + 1)} disabled={index === questions.length - 1} aria-label="다음 문항" className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] bg-white text-sage-700 transition-colors hover:border-sage-400 disabled:cursor-not-allowed disabled:opacity-35"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="w-full h-2 bg-[var(--color-sage-200)] rounded-full overflow-hidden"><div className="h-full bg-sage-700 rounded-full transition-all" style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div>
      </div>

      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <div className="flex gap-2 flex-wrap"><Badge>오답 유사문항</Badge><Badge variant="warn">난이도 {'★'.repeat(question.difficulty)}</Badge></div>
          <Badge variant="curated">유사문항</Badge>
        </div>
        <div className="flex gap-1.5 text-[17px] leading-8 text-sage-800 mb-6"><strong className="text-sage-700 shrink-0">{index + 1}.</strong><QuestionStem className="flex-1" text={question.stem} /></div>
        <div className="space-y-2">
          {question.choices.map((choice, choiceIndex) => {
            const isCorrect = attempt && choiceIndex === attempt.correct_index;
            const isWrong = attempt && choiceIndex === selected && !attempt.is_correct;
            const isSelected = !attempt && choiceIndex === selected;
            return <button key={choiceIndex} type="button" disabled={!!attempt} onClick={() => selectChoice(choiceIndex)} className={`w-full text-left p-3.5 px-4 rounded-xl border flex items-center gap-3 transition-all ${isCorrect ? 'bg-[var(--color-curated-bg)] border-sage-600' : isWrong ? 'bg-[var(--color-warn-bg)] border-[var(--color-warn)]' : isSelected ? 'bg-[var(--color-sage-100)] border-sage-600' : 'bg-white border-[var(--color-border)] hover:border-sage-400 hover:bg-[var(--color-sage-50)]'}`}>
              <span className={`w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold flex-shrink-0 ${isCorrect || isSelected ? 'bg-sage-700 text-white border-sage-700' : isWrong ? 'bg-[var(--color-warn)] text-white border-[var(--color-warn)]' : 'border-[var(--color-sage-400)] text-[var(--color-muted)]'}`}>{choiceIndex + 1}</span>
              <span className="text-[15px] text-sage-800 flex-1">{choice}</span>{isCorrect && <CheckCircle2 className="w-5 h-5 text-sage-700 flex-shrink-0" />}{isWrong && <XCircle className="w-5 h-5 text-[var(--color-warn)] flex-shrink-0" />}
            </button>;
          })}
        </div>
        {attempt?.explanation && <div className="mt-5 ll-tint rounded-2xl p-5 border border-[var(--color-border)]"><span className="ll-eyebrow mb-3">해설</span><div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">{attempt.explanation}</div></div>}
      </Card>

      <div className="flex justify-end">
        {!attempt ? <Button variant="accent" onClick={submit} disabled={selected === null} loading={submitting}>제출하고 채점</Button> : index < questions.length - 1 ? <Button onClick={() => goToQuestion(index + 1)}>다음 문항 <ChevronRight className="w-4 h-4" /></Button> : <Link href="/library"><Button>내 문제집에서 보기</Button></Link>}
      </div>
    </div>
  );
}
