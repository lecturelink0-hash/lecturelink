'use client';

import { Clock, Send, Flag } from 'lucide-react';

export interface ScrollQuestion {
  id: string;
  stem: string;
  choices: string[];
  subjectName: string;
  subTopicName: string;
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: string | null;
}

export function ScrollExamView({ title, questions, answers, flagged, remaining, submitting, onChoose, onFlag, onSubmit }: {
  title: string;
  questions: ScrollQuestion[];
  answers: number[];
  flagged: number[];
  remaining: number | null;
  submitting: boolean;
  onChoose: (question: number, choice: number) => void;
  onFlag: (question: number) => void;
  onSubmit: () => void;
}) {
  const answered = answers.filter((answer) => answer >= 0).length;
  const minutes = remaining === null ? null : `${Math.max(0, Math.floor(remaining / 60))}:${String(Math.max(0, remaining % 60)).padStart(2, '0')}`;
  const topics = [...new Set(questions.map((question) => question.subTopicName))];

  return (
    <div className="ll-exam-session-page content">
        <section className="page-head">
          <div><a className="back" href="/mock">← 과목 선택</a><span className="eyebrow">국시 대비 · {questions[0]?.subjectName ?? '모의고사'}</span><h1><span>{questions[0]?.subjectName ?? title}</span> 임상추론</h1><p className="lead">문제를 하나씩 선택하며 아래로 이어서 풀어보세요. 마지막 문항까지 내려가면 결과 보기가 나타납니다.</p></div>
          <aside className="summary-card" aria-label="풀이 진행률"><div className="summary-row"><span>진행도</span><strong>{answered} / {questions.length}</strong></div><div className="bar"><span style={{ width: `${questions.length ? Math.round(answered / questions.length * 100) : 0}%` }} /></div><div className="summary-row"><span>{minutes ? '남은 시간' : '예상 소요'}</span><strong>{minutes ?? `${questions.length + 2}분`}</strong></div></aside>
        </section>
        <div className="layout">
          <aside className="side">
            <div className="side-title">세부 주제</div><div className="topic-list">{topics.map((topic, index) => <button className={`topic ${index === 0 ? 'active' : ''}`} key={topic}><span>{topic}</span><span className="topic-count">{questions.filter((q) => q.subTopicName === topic).length}</span></button>)}</div>
          </aside>

          <section className="question-stack">
            {questions.map((question, qi) => (
              <article className="question-card" id={`question-${qi + 1}`} key={question.id}>
                <div className="question-top"><div className="q-meta"><span className="chip">{question.subTopicName}</span><span className="chip warn">난이도 {'★'.repeat(question.difficulty)}</span></div><span className="q-number">{qi + 1} / {questions.length}</span></div>
                <p className="question-text"><strong>{qi + 1}.</strong> {question.stem}</p>
                {question.imageUrl && <div className="question-image"><img src={question.imageUrl} alt={question.imageType ?? '문항 이미지'} /></div>}
                <div className="options">
                  {question.choices.map((choice, ci) => <button type="button" key={ci} onClick={() => onChoose(qi, ci)} className={answers[qi] === ci ? 'option selected' : 'option'}><span className="bubble">{ci + 1}</span>{choice}</button>)}
                </div>
                <div className="question-foot"><button type="button" className="mark" onClick={() => onFlag(qi)}><Flag className="icon" />{flagged.includes(qi) ? '표시됨' : answers[qi] >= 0 ? '선택됨' : '나중에 보기'}</button>{qi < questions.length - 1 ? <a className="submit-btn" href={`#question-${qi + 2}`}>다음 문제</a> : <span>{answers[qi] >= 0 ? '선택됨' : '미선택'}</span>}</div><div className="explanation" hidden />
              </article>
            ))}
            <section className="result-panel" aria-label="결과 보기"><div><h2>마지막 문제까지 도착했어요</h2><p>선택한 답안을 바탕으로 정답률, 취약 개념, 추천 복습 문항을 확인할 수 있습니다.</p></div><button type="button" className="result-btn" onClick={onSubmit} disabled={submitting}><Send className="icon" />{submitting ? '제출 중...' : '제출 및 채점'}</button></section>
          </section>
        </div>
    </div>
  );
}
