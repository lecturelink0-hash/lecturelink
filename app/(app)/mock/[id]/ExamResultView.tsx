'use client';

import { ArrowLeft, BookmarkPlus, CheckCircle2, RotateCcw } from 'lucide-react';
import type { ScrollQuestion } from './ScrollExamView';

interface ResultQuestion extends ScrollQuestion { answerIndex?: number; explanation?: string | null }

export function ExamResultView({ title, score, answers, questions, saved, onBack, onRetry, onSave }: {
  title: string; score: number; answers: number[]; questions: ResultQuestion[]; saved: Set<string>;
  onBack: () => void; onRetry: () => void; onSave: (question: ResultQuestion, selected: number) => void;
}) {
  const pct = questions.length ? Math.round(score / questions.length * 100) : 0;
  const wrong = questions.map((question, index) => ({ question, index, selected: answers[index] ?? -1 })).filter(({ question, selected }) => selected !== (question.answerIndex ?? -1));
  const topics = [...new Set(questions.map((question) => question.subTopicName))];
  return <div className="ll-exam-result-page pb-10">
    <section className="page-head"><div className="head-main"><div className="head-meta"><button className="back" onClick={onBack}><ArrowLeft className="w-4 h-4" /> 과목 선택</button><div className="eyebrow">국시 대비 · {questions[0]?.subjectName ?? '모의고사'}</div></div><h1><span className="h1-accent">{questions[0]?.subjectName ?? title}</span> <span className="h1-tail">임상추론 결과</span></h1></div><button className="cta" onClick={onRetry}><RotateCcw className="w-4 h-4" /> 다시 풀기</button></section>
    <div className="layout">
      <aside className="card sidebar"><div className="side-title">세부 주제</div><div className="topic-list"><div className="topic active"><span>전체</span><small>{questions.length}</small></div>{topics.map((topic) => <div className="topic" key={topic}><span>{topic}</span><small>{questions.filter((q) => q.subTopicName === topic).length}</small></div>)}</div></aside>
      <section><article className="result-hero card"><div className="result-left"><span className="status-pill"><CheckCircle2 className="w-4 h-4" /> {title} · 완료</span></div><div className="score-panel"><div className="score">{score}<span> / {questions.length}</span></div><div className="score-label">정답률 {pct}%</div></div></article>
        <div className="section-grid"><article className="card panel"><div className="panel-head"><h2 className="panel-title"><span className="title-line">오답 확인 <span className="help-wrap"><button className="help-button" type="button" aria-label="오답노트 설명">?</button><span className="help-pop">오답 문제 중 담은 문제는 오답노트 탭에서 다시 풀어볼 수 있습니다.</span></span></span></h2></div>{wrong.length === 0 ? <div className="explain"><strong>모든 문항을 맞혔습니다.</strong><p>현재 학습 흐름을 이어가세요.</p></div> : wrong.map(({ question, index, selected }, wi) => <div className="wrong-card" key={question.id}><div className="wrong-top"><div className="wrong-index">오답 {wi + 1}</div><label className="save-check"><input type="checkbox" checked={saved.has(question.id)} readOnly/><button className="save-surface" disabled={saved.has(question.id)} onClick={() => onSave(question, selected)}><span className="save-icon"><BookmarkPlus className="w-4 h-4" /></span><span className="save-text"><strong>{saved.has(question.id) ? '오답노트 담음' : '오답노트 담기'}</strong></span></button></label></div><p className="question">{question.stem}</p><div className="answer-grid">{question.choices.map((choice, ci) => <div className={`answer ${ci === question.answerIndex ? 'correct' : ''} ${ci === selected ? 'wrong' : ''}`} key={ci}><span className="num">{ci + 1}</span><span>{choice}</span><span className="answer-label">{ci === question.answerIndex ? '정답' : ci === selected ? '내 선택' : ''}</span></div>)}</div>{question.explanation && <div className="explain"><strong>해설</strong><p>{question.explanation}</p></div>}</div>)}{wrong.length > 0 && <div className="action-dock"><button className="primary-wide" type="button" onClick={() => wrong.filter(({question}) => !saved.has(question.id)).forEach(({question, selected}) => onSave(question, selected))}><BookmarkPlus className="w-4 h-4"/>선택한 오답 담기</button></div>}</article></div>
      </section>
    </div>
  </div>;
}
