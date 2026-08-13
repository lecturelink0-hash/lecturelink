import fs from 'node:fs/promises';
import path from 'node:path';

const inputPath =
  process.argv[2] ??
  'outputs/nephrology-review/four-unit-review-v15/revision-drafts.json';
const outputPath = process.argv[3];

if (!outputPath) {
  throw new Error('Output HTML fragment path is required.');
}

const document = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const questions = document.revisions.map((item, index) => ({
  number: index + 1,
  id: item.id,
  module: item.module,
  subTopic: item.sub_topic.name,
  source: {
    stem: item.source.stem,
    choices: item.source.choices,
    answerIndex: item.source.answer_index,
  },
  revision: {
    stem: item.revision.stem,
    choices: item.revision.choices,
    answerIndex: item.revision.answer_index,
    explanation: item.revision.explanation,
  },
}));

const serializedQuestions = JSON.stringify(questions).replaceAll(
  '</script>',
  '<\\/script>',
);

const fragment = `<div id="renal-review-v15">
  <div class="viz-grid" aria-label="검수 진행 상황">
    <div class="card viz-stat">
      <div class="text-muted">승인</div>
      <div class="viz-stat-value" data-stat="approved">0</div>
    </div>
    <div class="card viz-stat">
      <div class="text-muted">수정 필요</div>
      <div class="viz-stat-value" data-stat="needs-edit">0</div>
    </div>
    <div class="card viz-stat">
      <div class="text-muted">미검수</div>
      <div class="viz-stat-value" data-stat="unreviewed">85</div>
    </div>
  </div>

  <div class="viz-controls renal-review-nav">
    <button type="button" class="btn" data-action="previous">이전</button>
    <label class="form-label renal-review-jump">
      문항 이동
      <select class="form-select" data-control="jump"></select>
    </label>
    <button type="button" class="btn btn-primary" data-action="next">다음</button>
    <button type="button" class="btn btn-ghost" data-action="next-unreviewed">다음 미검수</button>
  </div>

  <div class="viz-row renal-review-context">
    <span class="viz-badge" data-field="position"></span>
    <span data-field="module"></span>
    <span class="text-muted" data-field="subtopic"></span>
  </div>

  <section class="card renal-review-question" aria-live="polite">
    <div class="text-small text-muted" data-field="id"></div>
    <h2 data-field="stem"></h2>
    <ol data-field="choices" class="renal-review-choices"></ol>

    <h3>정답 근거</h3>
    <div data-field="correct-basis"></div>

    <h3>오답 감별</h3>
    <ol data-field="distractors" class="renal-review-rationales"></ol>

    <details class="renal-review-original">
      <summary>수정 전 원문 비교</summary>
      <div data-field="source-stem"></div>
      <ol data-field="source-choices"></ol>
    </details>
  </section>

  <fieldset class="renal-review-decision">
    <legend>검수 상태</legend>
    <div class="viz-row">
      <div class="form-check">
        <input class="form-check-input" type="radio" name="renal-review-status" id="renal-status-unreviewed" value="unreviewed">
        <label class="form-check-label" for="renal-status-unreviewed">미검수</label>
      </div>
      <div class="form-check">
        <input class="form-check-input" type="radio" name="renal-review-status" id="renal-status-approved" value="approved">
        <label class="form-check-label" for="renal-status-approved">승인</label>
      </div>
      <div class="form-check">
        <input class="form-check-input" type="radio" name="renal-review-status" id="renal-status-needs-edit" value="needs-edit">
        <label class="form-check-label" for="renal-status-needs-edit">수정 필요</label>
      </div>
    </div>
    <label class="form-label" for="renal-review-note">검수 메모</label>
    <textarea id="renal-review-note" class="form-control" rows="4" placeholder="틀린 수치, 어색한 선지, 원하는 수정 방향 등을 적으세요."></textarea>
    <div class="viz-row renal-review-actions">
      <button type="button" class="btn" data-action="send-review">검수 결과 전달</button>
      <span class="text-small text-muted" data-field="save-state">자동 저장됨</span>
    </div>
  </fieldset>
</div>

<style>
  #renal-review-v15 {
    display: grid;
    gap: 1rem;
    color: var(--foreground);
  }
  #renal-review-v15 .renal-review-nav {
    justify-content: space-between;
    align-items: end;
  }
  #renal-review-v15 .renal-review-jump {
    flex: 1 1 18rem;
  }
  #renal-review-v15 .renal-review-context {
    justify-content: flex-start;
  }
  #renal-review-v15 .renal-review-question {
    display: grid;
    gap: 0.75rem;
  }
  #renal-review-v15 .renal-review-question h2,
  #renal-review-v15 .renal-review-question h3 {
    margin: 0;
    white-space: pre-wrap;
  }
  #renal-review-v15 .renal-review-choices,
  #renal-review-v15 .renal-review-rationales,
  #renal-review-v15 [data-field="source-choices"] {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding-inline-start: 1.5rem;
  }
  #renal-review-v15 .renal-review-choices li,
  #renal-review-v15 .renal-review-rationales li,
  #renal-review-v15 [data-field="source-choices"] li {
    white-space: pre-wrap;
  }
  #renal-review-v15 .renal-review-choices li[data-correct="true"] {
    font-weight: 500;
  }
  #renal-review-v15 .renal-review-choices li[data-correct="true"]::after {
    content: "  정답";
    color: var(--foreground);
  }
  #renal-review-v15 [data-field="correct-basis"],
  #renal-review-v15 [data-field="source-stem"] {
    white-space: pre-wrap;
  }
  #renal-review-v15 .renal-review-original {
    margin-top: 0.5rem;
  }
  #renal-review-v15 .renal-review-original[open] {
    display: grid;
    gap: 0.75rem;
  }
  #renal-review-v15 .renal-review-decision {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  #renal-review-v15 .renal-review-actions {
    justify-content: space-between;
  }
  @media (max-width: 520px) {
    #renal-review-v15 .renal-review-nav {
      align-items: stretch;
    }
    #renal-review-v15 .renal-review-nav > * {
      flex: 1 1 100%;
    }
  }
</style>

<script>
(() => {
  const root = document.getElementById('renal-review-v15');
  if (!root) return;

  const questions = ${serializedQuestions};
  const storageKey = 'lecturelink-nephrology-review-v15';
  let currentIndex = 0;
  let reviews = {};

  try {
    reviews = JSON.parse(localStorage.getItem(storageKey) || '{}');
  } catch {
    reviews = {};
  }

  const byField = (name) => root.querySelector('[data-field="' + name + '"]');
  const byStat = (name) => root.querySelector('[data-stat="' + name + '"]');
  const jump = root.querySelector('[data-control="jump"]');
  const note = root.querySelector('#renal-review-note');
  const radios = Array.from(
    root.querySelectorAll('input[name="renal-review-status"]'),
  );

  questions.forEach((question, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent =
      String(question.number) + '. ' + question.subTopic + ' · ' + question.id.slice(0, 8);
    jump.appendChild(option);
  });

  function parseExplanation(explanation) {
    const correctMarker = '[정답 근거]';
    const distractorMarker = '[오답 감별]';
    const distractorStart = explanation.indexOf(distractorMarker);
    const correctRaw =
      distractorStart >= 0 ? explanation.slice(0, distractorStart) : explanation;
    const distractorRaw =
      distractorStart >= 0
        ? explanation.slice(distractorStart + distractorMarker.length)
        : '';
    const correct = correctRaw.replace(correctMarker, '').trim();
    const distractors = distractorRaw
      .trim()
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { correct, distractors };
  }

  function saveReview() {
    localStorage.setItem(storageKey, JSON.stringify(reviews));
    updateStats();
    byField('save-state').textContent = '자동 저장됨';
  }

  function currentReview() {
    const id = questions[currentIndex].id;
    return reviews[id] || { status: 'unreviewed', note: '' };
  }

  function updateStats() {
    let approved = 0;
    let needsEdit = 0;
    questions.forEach((question) => {
      const status = reviews[question.id]?.status || 'unreviewed';
      if (status === 'approved') approved += 1;
      if (status === 'needs-edit') needsEdit += 1;
    });
    byStat('approved').textContent = String(approved);
    byStat('needs-edit').textContent = String(needsEdit);
    byStat('unreviewed').textContent = String(
      questions.length - approved - needsEdit,
    );
  }

  function renderChoices(list, choices, answerIndex, markCorrect) {
    list.replaceChildren();
    choices.forEach((choice, index) => {
      const item = document.createElement('li');
      item.textContent = choice;
      if (markCorrect && index === answerIndex) {
        item.dataset.correct = 'true';
      }
      list.appendChild(item);
    });
  }

  function render() {
    const question = questions[currentIndex];
    const review = currentReview();
    const explanation = parseExplanation(question.revision.explanation);

    jump.value = String(currentIndex);
    byField('position').textContent =
      String(question.number) + ' / ' + String(questions.length);
    byField('module').textContent = question.module;
    byField('subtopic').textContent = question.subTopic;
    byField('id').textContent = question.id;
    byField('stem').textContent = question.revision.stem;
    renderChoices(
      byField('choices'),
      question.revision.choices,
      question.revision.answerIndex,
      true,
    );
    byField('correct-basis').textContent = explanation.correct;

    const distractorList = byField('distractors');
    distractorList.replaceChildren();
    explanation.distractors.forEach((reason) => {
      const item = document.createElement('li');
      item.textContent = reason;
      distractorList.appendChild(item);
    });

    byField('source-stem').textContent = question.source.stem;
    renderChoices(
      byField('source-choices'),
      question.source.choices,
      question.source.answerIndex,
      true,
    );

    radios.forEach((radio) => {
      radio.checked = radio.value === review.status;
    });
    note.value = review.note || '';
    root.querySelector('[data-action="previous"]').disabled = currentIndex === 0;
    root.querySelector('[data-action="next"]').disabled =
      currentIndex === questions.length - 1;
  }

  function moveTo(index) {
    currentIndex = Math.max(0, Math.min(questions.length - 1, index));
    render();
  }

  function moveToNextUnreviewed() {
    const next = questions.findIndex((question, index) => {
      if (index <= currentIndex) return false;
      return (reviews[question.id]?.status || 'unreviewed') === 'unreviewed';
    });
    if (next >= 0) {
      moveTo(next);
      return;
    }
    const wrapped = questions.findIndex(
      (question) =>
        (reviews[question.id]?.status || 'unreviewed') === 'unreviewed',
    );
    if (wrapped >= 0) moveTo(wrapped);
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'previous') moveTo(currentIndex - 1);
    if (action === 'next') moveTo(currentIndex + 1);
    if (action === 'next-unreviewed') moveToNextUnreviewed();
    if (action === 'send-review') {
      const reviewed = questions
        .map((question) => ({
          id: question.id,
          number: question.number,
          status: reviews[question.id]?.status || 'unreviewed',
          note: reviews[question.id]?.note || '',
        }))
        .filter((item) => item.status !== 'unreviewed' || item.note);
      const payload = JSON.stringify(reviewed, null, 2);
      const prompt =
        '신장 문항 검수 결과입니다. 승인 문항은 유지하고, 수정 필요 문항은 메모대로 고쳐 주세요.\\n\\n' +
        payload;
      if (window.openai?.sendFollowUpMessage) {
        await window.openai.sendFollowUpMessage({
          title: '검수 결과 전달',
          prompt,
        });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(prompt);
        byField('save-state').textContent = '검수 결과가 복사됨';
      }
    }
  });

  jump.addEventListener('change', () => moveTo(Number(jump.value)));

  radios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const question = questions[currentIndex];
      reviews[question.id] = {
        status: radio.value,
        note: note.value,
      };
      saveReview();
    });
  });

  note.addEventListener('input', () => {
    const question = questions[currentIndex];
    const previous = currentReview();
    reviews[question.id] = {
      status: previous.status,
      note: note.value,
    };
    byField('save-state').textContent = '저장 중';
    saveReview();
  });

  updateStats();
  render();
})();
</script>
`;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, fragment, 'utf8');
console.log(
  JSON.stringify(
    {
      output: outputPath,
      question_count: questions.length,
      bytes: Buffer.byteLength(fragment, 'utf8'),
    },
    null,
    2,
  ),
);
