import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE =
  'outputs/nephrology-review/original-questions.json';
const OUT_DIR =
  'outputs/nephrology-review/four-unit-review-v15';
const SECOND_PASS_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v3-overrides.json';
const DECISION_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v4-clinical-decision-overrides.json';
const WORDING_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v6-question-wording-overrides.json';
const RAW_DATA_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v7-raw-clinical-data-overrides.json';
const URINE_PANEL_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v8-urine-panel-overrides.json';
const FREE_WATER_TERMINOLOGY_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v9-free-water-terminology-overrides.json';
const CLINICAL_LANGUAGE_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v10-clinical-language-overrides.json';
const TUBULAR_PANEL_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v11-tubular-panel-overrides.json';
const KMLE_WATER_TERMINOLOGY_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v12-kmle-water-terminology-overrides.json';
const SIMPLE_RENAL_FUNCTION_BUNCR_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v13-simple-renal-function-buncr-overrides.json';
const URINE_TEST_TERMINOLOGY_OVERRIDES =
  'outputs/nephrology-review/drafts/four-unit-v14-urine-test-terminology-overrides.json';
const RATIONALE_FILES = [
  'outputs/nephrology-review/drafts/explanation-rationales-m1-m2.json',
  'outputs/nephrology-review/drafts/explanation-rationales-m3.json',
  'outputs/nephrology-review/drafts/explanation-rationales-m5.json',
];
const DRAFT_FILES = [
  'outputs/nephrology-review/drafts/fluid-electrolyte-general-clinical-rewrite-v2.json',
  'outputs/nephrology-review/drafts/renal-tubular-acidosis-clinical-rewrite-v2.json',
  'outputs/nephrology-review/drafts/m1-m2-additional-clinical-rewrite-v2.json',
  'outputs/nephrology-review/drafts/m3-fluid-electrolyte-disorders-clinical-rewrite-v2.json',
  'outputs/nephrology-review/drafts/m5-kidney-approach-part1-clinical-rewrite-v2.json',
  'outputs/nephrology-review/drafts/m5-kidney-approach-part2-clinical-rewrite-v2.json',
];
const RAW_DATA_SUMMARY_PATTERN =
  /(혈압(?:과|·).*정상|콩팥기능.*정상|소변 단백질.*정상|갑상샘기능.*정상|심장·간·콩팥·갑상샘 검사.*정상|간기능과 심초음파.*정상|심전도:\s*정상|혈압과 소변량은 정상|소변량, 혈압, 전해질은 변하지 않았|cystatin C 기반 사구체여과율도 이전과 같|콩팥 크기는 정상이지만)/;
const URINE_PANEL_SUBTOPICS = new Set([
  'nephrology_m5_l3',
  'nephrology_m5_l4',
]);
const RENAL_FUNCTION_BUNCR_SUBTOPICS = new Set([
  'nephrology_m5_l1',
  'nephrology_m5_l2',
]);

const TARGET_MODULES = new Map([
  ['m1', '수분 및 전해질대사'],
  ['m2', '세관기능장애'],
  ['m3', '수분 및 전해질 대사장애'],
  ['m5', '콩팥질환의 접근'],
]);

function hashContent(question) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        stem: question.stem,
        choices: question.choices,
        answer_index: question.answer_index,
        explanation: question.explanation,
      }),
    )
    .digest('hex');
}

function moduleCode(subTopicCode) {
  return subTopicCode.match(/^nephrology_(m\d+)_/)?.[1] ?? null;
}

function formatChoices(choices, answerIndex) {
  return choices
    .map(
      (choice, index) =>
        `${index + 1}. ${choice}${index === answerIndex ? '  ← 정답' : ''}`,
    )
    .join('\n');
}

function removeFreeWaterTerm(text) {
  return text
    .replaceAll('순수한 자유수 과다', '과도한 수분 섭취')
    .replaceAll('순수 자유수 소실', '수분 소실')
    .replaceAll('자유수 결핍량', '수분 부족량')
    .replaceAll('자유수 결핍', '수분 부족')
    .replaceAll('자유수청소율', '묽은 소변을 통한 수분 배설량')
    .replaceAll('자유수 청소율', '묽은 소변을 통한 수분 배설량')
    .replaceAll('자유수 배설', '묽은 소변을 통한 수분 배설')
    .replaceAll('자유수 소실', '수분 소실')
    .replaceAll('자유수처럼', '전해질이 거의 없는 수분처럼')
    .replaceAll('자유수', '수분');
}

function moveQuestionBeforeTestPanel(stem) {
  const paragraphs = stem.split(/\n\n+/);
  if (paragraphs.length < 3) return { stem, moved: false };

  const introduction = paragraphs[0].trim();
  const finalParagraph = paragraphs.at(-1).trim();
  const markerMatch = [
    ...introduction.matchAll(/검사(?:한)? 결과는 다음과 같다\./g),
  ].at(-1);
  const questionMatch = finalParagraph.match(/([^.!?]+\?)$/);

  if (!markerMatch || !questionMatch) return { stem, moved: false };

  const marker = markerMatch[0];
  const markerIndex = markerMatch.index;
  const question = questionMatch[1].trim();
  const additionalContext = finalParagraph
    .slice(0, questionMatch.index)
    .trim();
  const introductionBeforeMarker = introduction
    .slice(0, markerIndex)
    .trim();
  const introductionAfterMarker = introduction
    .slice(markerIndex + marker.length)
    .trim();
  const relocatedIntroduction = [
    introductionBeforeMarker,
    additionalContext,
    marker,
    introductionAfterMarker,
    question,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    stem: [
      relocatedIntroduction,
      ...paragraphs.slice(1, -1).map((paragraph) => paragraph.trim()),
    ].join('\n\n'),
    moved: true,
  };
}

function hasQuestionAfterTestPanel(stem) {
  const paragraphs = stem.split(/\n\n+/);
  return (
    paragraphs.length >= 3 &&
    /검사(?:한)? 결과는 다음과 같다\./.test(paragraphs[0]) &&
    paragraphs.at(-1).trim().endsWith('?')
  );
}

async function main() {
  const source = JSON.parse(await fs.readFile(SOURCE, 'utf8'));
  const originals = new Map(source.questions.map((question) => [question.id, question]));
  const targetOriginals = source.questions.filter((question) =>
    TARGET_MODULES.has(moduleCode(question.sub_topic.code)),
  );

  const draftDocuments = await Promise.all(
    DRAFT_FILES.map(async (file) => ({
      file,
      data: JSON.parse(await fs.readFile(file, 'utf8')),
    })),
  );
  const firstPassRevisions = draftDocuments.flatMap(({ file, data }) =>
    data.drafts.map((draft) => ({ ...draft, _draft_file: file })),
  );
  const overrideDocument = JSON.parse(
    await fs.readFile(SECOND_PASS_OVERRIDES, 'utf8'),
  );
  const overrideMap = new Map(
    overrideDocument.overrides.map((override) => [override.id, override]),
  );
  const secondPassRevisions = firstPassRevisions.map((revision) => {
    const override = overrideMap.get(revision.id);
    if (!override) return revision;
    return {
      ...revision,
      ...override,
      _draft_file: revision._draft_file,
      _second_pass_file: SECOND_PASS_OVERRIDES,
    };
  });
  const decisionDocument = JSON.parse(
    await fs.readFile(DECISION_OVERRIDES, 'utf8'),
  );
  const decisionOverrideMap = new Map(
    decisionDocument.overrides.map((override) => [override.id, override]),
  );
  const decisionPassRevisions = secondPassRevisions.map((revision) => {
    const override = decisionOverrideMap.get(revision.id);
    if (!override) return revision;
    return {
      ...revision,
      ...override,
      _draft_file: revision._draft_file,
      _second_pass_file: revision._second_pass_file ?? null,
      _decision_pass_file: DECISION_OVERRIDES,
    };
  });
  const wordingDocument = JSON.parse(
    await fs.readFile(WORDING_OVERRIDES, 'utf8'),
  );
  const wordingOverrideMap = new Map(
    wordingDocument.overrides.map((override) => [override.id, override]),
  );
  const wordingPassRevisions = decisionPassRevisions.map((revision) => {
    const override = wordingOverrideMap.get(revision.id);
    if (!override) return revision;
    if (!revision.stem.endsWith(override.from)) {
      throw new Error(`${revision.id}: question wording source mismatch`);
    }
    return {
      ...revision,
      stem: `${revision.stem.slice(0, -override.from.length)}${override.to}`,
      _wording_pass_file: WORDING_OVERRIDES,
    };
  });
  const rawDataDocument = JSON.parse(
    await fs.readFile(RAW_DATA_OVERRIDES, 'utf8'),
  );
  const rawDataOverrideMap = new Map(
    rawDataDocument.overrides.map((override) => [override.id, override]),
  );
  const rawDataPassRevisions = wordingPassRevisions.map((revision) => {
    const override = rawDataOverrideMap.get(revision.id);
    if (!override) return revision;
    return {
      ...revision,
      stem: override.stem,
      _raw_data_pass_file: RAW_DATA_OVERRIDES,
    };
  });
  const urinePanelDocument = JSON.parse(
    await fs.readFile(URINE_PANEL_OVERRIDES, 'utf8'),
  );
  const urinePanelOverrideMap = new Map(
    urinePanelDocument.overrides.map((override) => [override.id, override]),
  );
  const urinePanelPassRevisions = rawDataPassRevisions.map((revision) => {
    const override = urinePanelOverrideMap.get(revision.id);
    if (!override) return revision;
    return {
      ...revision,
      ...override,
      _urine_panel_pass_file: URINE_PANEL_OVERRIDES,
    };
  });
  const freeWaterTerminologyDocument = JSON.parse(
    await fs.readFile(FREE_WATER_TERMINOLOGY_OVERRIDES, 'utf8'),
  );
  const freeWaterTerminologyOverrideMap = new Map(
    freeWaterTerminologyDocument.overrides.map((override) => [
      override.id,
      override,
    ]),
  );
  const freeWaterTerminologyPassRevisions = urinePanelPassRevisions.map(
    (revision) => {
      const override = freeWaterTerminologyOverrideMap.get(revision.id);
      if (!override) return revision;
      return {
        ...revision,
        ...override,
        _free_water_terminology_pass_file: FREE_WATER_TERMINOLOGY_OVERRIDES,
      };
    },
  );
  const clinicalLanguageDocument = JSON.parse(
    await fs.readFile(CLINICAL_LANGUAGE_OVERRIDES, 'utf8'),
  );
  const clinicalLanguageOverrideMap = new Map(
    clinicalLanguageDocument.overrides.map((override) => [
      override.id,
      override,
    ]),
  );
  const clinicalLanguagePassRevisions =
    freeWaterTerminologyPassRevisions.map((revision) => {
      const override = clinicalLanguageOverrideMap.get(revision.id);
      if (!override) return revision;
      let stem = revision.stem;
      if (override.stem_from) {
        if (!stem.includes(override.stem_from)) {
          throw new Error(`${revision.id}: clinical language source mismatch`);
        }
        stem = stem.replace(override.stem_from, override.stem_to);
      }
      const {
        stem_from: _stemFrom,
        stem_to: _stemTo,
        ...revisionOverride
      } = override;
      return {
        ...revision,
        ...revisionOverride,
        stem,
        _clinical_language_pass_file: CLINICAL_LANGUAGE_OVERRIDES,
      };
    });
  const tubularPanelDocument = JSON.parse(
    await fs.readFile(TUBULAR_PANEL_OVERRIDES, 'utf8'),
  );
  const tubularPanelOverrideMap = new Map(
    tubularPanelDocument.overrides.map((override) => [override.id, override]),
  );
  const tubularPanelPassRevisions = clinicalLanguagePassRevisions.map(
    (revision) => {
      const override = tubularPanelOverrideMap.get(revision.id);
      if (!override) return revision;
      return {
        ...revision,
        ...override,
        _tubular_panel_pass_file: TUBULAR_PANEL_OVERRIDES,
      };
    },
  );
  const kmleWaterTerminologyDocument = JSON.parse(
    await fs.readFile(KMLE_WATER_TERMINOLOGY_OVERRIDES, 'utf8'),
  );
  const kmleWaterTerminologyOverrideMap = new Map(
    kmleWaterTerminologyDocument.overrides.map((override) => [
      override.id,
      override,
    ]),
  );
  const kmleWaterTerminologyPassRevisions = tubularPanelPassRevisions.map(
    (revision) => {
      const override = kmleWaterTerminologyOverrideMap.get(revision.id);
      if (!override) return revision;
      return {
        ...revision,
        ...override,
        _kmle_water_terminology_pass_file: KMLE_WATER_TERMINOLOGY_OVERRIDES,
      };
    },
  );
  const simpleRenalFunctionBunCrDocument = JSON.parse(
    await fs.readFile(SIMPLE_RENAL_FUNCTION_BUNCR_OVERRIDES, 'utf8'),
  );
  const simpleRenalFunctionBunCrOverrideMap = new Map(
    simpleRenalFunctionBunCrDocument.overrides.map((override) => [
      override.id,
      override,
    ]),
  );
  const simpleRenalFunctionBunCrPassRevisions =
    kmleWaterTerminologyPassRevisions.map((revision) => {
      const override = simpleRenalFunctionBunCrOverrideMap.get(revision.id);
      if (!override) return revision;
      return {
        ...revision,
        ...override,
        _simple_renal_function_buncr_pass_file:
          SIMPLE_RENAL_FUNCTION_BUNCR_OVERRIDES,
      };
    });
  const urineTestTerminologyDocument = JSON.parse(
    await fs.readFile(URINE_TEST_TERMINOLOGY_OVERRIDES, 'utf8'),
  );
  const urineTestTerminologyOverrideMap = new Map(
    urineTestTerminologyDocument.overrides.map((override) => [
      override.id,
      override,
    ]),
  );
  const urineTestTerminologyPassRevisions =
    simpleRenalFunctionBunCrPassRevisions.map((revision) => {
      const override = urineTestTerminologyOverrideMap.get(revision.id);
      if (!override) return revision;
      return {
        ...revision,
        ...override,
        _urine_test_terminology_pass_file: URINE_TEST_TERMINOLOGY_OVERRIDES,
      };
    });
  const questionPositionPassRevisions = urineTestTerminologyPassRevisions.map(
    (revision) => {
      const relocated = moveQuestionBeforeTestPanel(revision.stem);
      if (!relocated.moved) return revision;
      return {
        ...revision,
        stem: relocated.stem,
        _question_position_pass: 'v15_question_before_test_panel',
      };
    },
  );
  const rationaleDocuments = await Promise.all(
    RATIONALE_FILES.map(async (file) => ({
      file,
      data: JSON.parse(await fs.readFile(file, 'utf8')),
    })),
  );
  const rationaleItems = rationaleDocuments.flatMap(({ file, data }) =>
    data.items.map((item) => ({ ...item, _rationale_file: file })),
  );
  const rationaleMap = new Map(
    rationaleItems.map((item) => [item.id, item]),
  );
  const revisions = questionPositionPassRevisions.map((revision) => {
    const rationale = rationaleMap.get(revision.id);
    const correctBasis = rationale
      ? revision.explanation.split(/\n+\[오답 감별\]/)[0].trim()
      : revision.explanation;
    const distractorLines = rationale
      ? Object.entries(rationale.distractors)
          .map(([index, reason]) => [Number(index), reason])
          .sort(([a], [b]) => a - b)
          .map(([index, reason]) => `${index + 1}번: ${reason}`)
      : [];
    const explanation = rationale
      ? `${correctBasis}\n\n[오답 감별]\n${distractorLines.join('\n')}`
      : correctBasis;
    return {
      ...revision,
      stem: removeFreeWaterTerm(revision.stem),
      choices: revision.choices.map(removeFreeWaterTerm),
      explanation: removeFreeWaterTerm(explanation),
      _explanation_file: rationale?._rationale_file ?? null,
    };
  });

  const errors = [];
  const warnings = [];
  const seen = new Set();

  if (overrideMap.size !== overrideDocument.overrides.length) {
    errors.push('second-pass override ID duplicated');
  }
  for (const overrideId of overrideMap.keys()) {
    if (!firstPassRevisions.some((revision) => revision.id === overrideId)) {
      errors.push(`${overrideId}: second-pass target missing`);
    }
  }
  if (decisionOverrideMap.size !== decisionDocument.overrides.length) {
    errors.push('clinical-decision override ID duplicated');
  }
  for (const overrideId of decisionOverrideMap.keys()) {
    if (!secondPassRevisions.some((revision) => revision.id === overrideId)) {
      errors.push(`${overrideId}: clinical-decision target missing`);
    }
  }
  if (wordingOverrideMap.size !== wordingDocument.overrides.length) {
    errors.push('question-wording override ID duplicated');
  }
  for (const overrideId of wordingOverrideMap.keys()) {
    if (!decisionPassRevisions.some((revision) => revision.id === overrideId)) {
      errors.push(`${overrideId}: question-wording target missing`);
    }
  }
  if (rawDataOverrideMap.size !== rawDataDocument.overrides.length) {
    errors.push('raw-clinical-data override ID duplicated');
  }
  for (const overrideId of rawDataOverrideMap.keys()) {
    if (!wordingPassRevisions.some((revision) => revision.id === overrideId)) {
      errors.push(`${overrideId}: raw-clinical-data target missing`);
    }
  }
  if (urinePanelOverrideMap.size !== urinePanelDocument.overrides.length) {
    errors.push('urine-panel override ID duplicated');
  }
  for (const overrideId of urinePanelOverrideMap.keys()) {
    if (!rawDataPassRevisions.some((revision) => revision.id === overrideId)) {
      errors.push(`${overrideId}: urine-panel target missing`);
    }
  }
  if (
    freeWaterTerminologyOverrideMap.size !==
    freeWaterTerminologyDocument.overrides.length
  ) {
    errors.push('free-water terminology override ID duplicated');
  }
  for (const overrideId of freeWaterTerminologyOverrideMap.keys()) {
    if (
      !urinePanelPassRevisions.some((revision) => revision.id === overrideId)
    ) {
      errors.push(`${overrideId}: free-water terminology target missing`);
    }
  }
  if (
    clinicalLanguageOverrideMap.size !==
    clinicalLanguageDocument.overrides.length
  ) {
    errors.push('clinical-language override ID duplicated');
  }
  for (const overrideId of clinicalLanguageOverrideMap.keys()) {
    if (
      !freeWaterTerminologyPassRevisions.some(
        (revision) => revision.id === overrideId,
      )
    ) {
      errors.push(`${overrideId}: clinical-language target missing`);
    }
  }
  if (tubularPanelOverrideMap.size !== tubularPanelDocument.overrides.length) {
    errors.push('tubular-panel override ID duplicated');
  }
  for (const overrideId of tubularPanelOverrideMap.keys()) {
    if (
      !clinicalLanguagePassRevisions.some(
        (revision) => revision.id === overrideId,
      )
    ) {
      errors.push(`${overrideId}: tubular-panel target missing`);
    }
  }
  if (
    kmleWaterTerminologyOverrideMap.size !==
    kmleWaterTerminologyDocument.overrides.length
  ) {
    errors.push('KMLE water-terminology override ID duplicated');
  }
  for (const overrideId of kmleWaterTerminologyOverrideMap.keys()) {
    if (
      !tubularPanelPassRevisions.some(
        (revision) => revision.id === overrideId,
      )
    ) {
      errors.push(`${overrideId}: KMLE water-terminology target missing`);
    }
  }
  if (
    simpleRenalFunctionBunCrOverrideMap.size !==
    simpleRenalFunctionBunCrDocument.overrides.length
  ) {
    errors.push('simple renal-function/BUN-Cr override ID duplicated');
  }
  for (const overrideId of simpleRenalFunctionBunCrOverrideMap.keys()) {
    if (
      !kmleWaterTerminologyPassRevisions.some(
        (revision) => revision.id === overrideId,
      )
    ) {
      errors.push(`${overrideId}: simple renal-function/BUN-Cr target missing`);
    }
  }
  if (
    urineTestTerminologyOverrideMap.size !==
    urineTestTerminologyDocument.overrides.length
  ) {
    errors.push('urine-test terminology override ID duplicated');
  }
  for (const overrideId of urineTestTerminologyOverrideMap.keys()) {
    if (
      !simpleRenalFunctionBunCrPassRevisions.some(
        (revision) => revision.id === overrideId,
      )
    ) {
      errors.push(`${overrideId}: urine-test terminology target missing`);
    }
  }
  if (rationaleMap.size !== rationaleItems.length) {
    errors.push('explanation rationale ID duplicated');
  }
  for (const revision of questionPositionPassRevisions) {
    const rationale = rationaleMap.get(revision.id);
    if (!rationale) {
      errors.push(`${revision.id}: explanation rationale missing`);
      continue;
    }
    const distractorIndexes = Object.keys(rationale.distractors)
      .map(Number)
      .sort((a, b) => a - b);
    const expectedIndexes = [0, 1, 2, 3, 4].filter(
      (index) => index !== revision.answer_index,
    );
    if (
      JSON.stringify(distractorIndexes) !== JSON.stringify(expectedIndexes)
    ) {
      errors.push(`${revision.id}: distractor rationale indexes mismatch`);
    }
    if (
      distractorIndexes.some(
        (index) => !String(rationale.distractors[index] ?? '').trim(),
      )
    ) {
      errors.push(`${revision.id}: empty distractor rationale`);
    }
  }
  for (const rationaleId of rationaleMap.keys()) {
    if (
      !questionPositionPassRevisions.some(
        (revision) => revision.id === rationaleId,
      )
    ) {
      errors.push(`${rationaleId}: explanation target missing`);
    }
  }

  for (const revision of revisions) {
    const original = originals.get(revision.id);
    if (!original) {
      errors.push(`${revision.id}: 원문 ID 없음`);
      continue;
    }
    if (seen.has(revision.id)) errors.push(`${revision.id}: 중복 수정안`);
    seen.add(revision.id);
    if (!Array.isArray(revision.choices) || revision.choices.length !== 5) {
      errors.push(`${revision.id}: 선지 5개 아님`);
    }
    if (
      !Number.isInteger(revision.answer_index) ||
      revision.answer_index < 0 ||
      revision.answer_index > 4
    ) {
      errors.push(`${revision.id}: 정답 인덱스 오류`);
    }
    if (new Set(revision.choices).size !== revision.choices.length) {
      errors.push(`${revision.id}: 중복 선지`);
    }
    if (!revision.stem?.trim() || !revision.explanation?.trim()) {
      errors.push(`${revision.id}: 본문 또는 해설 누락`);
    }
    const answerText = revision.choices[revision.answer_index];
    if (answerText && revision.stem.includes(answerText)) {
      warnings.push(`${revision.id}: 정답 선지 전체 문구가 지문에 포함됨`);
    }
    const questionLine = revision.stem.trim().split(/\n+/).at(-1) ?? '';
    if (
      /(초기 수액은|가장 적절한 초기 수액은|가장 적절한 초기 처치는|가장 먼저 투여할 약물은|재발 예방을 위한 초기 치료는|장기 치료는|치료 순서는)\?/.test(
        questionLine,
      )
    ) {
      errors.push(`${revision.id}: treatment prompt reveals answer category`);
    }
    if (RAW_DATA_SUMMARY_PATTERN.test(revision.stem)) {
      errors.push(`${revision.id}: interpretable clinical data summarized`);
    }
    if (revision.choices.some((choice) => /^자유수(?:$|\s|만)/.test(choice))) {
      errors.push(`${revision.id}: free water used as a treatment product`);
    }
    if (
      revision.stem.includes('자유수') ||
      revision.choices.some((choice) => choice.includes('자유수')) ||
      revision.explanation.includes('자유수')
    ) {
      errors.push(`${revision.id}: free water term remains in learner content`);
    }
    if (
      revision.stem.includes('시험지봉') ||
      revision.choices.some((choice) => choice.includes('시험지봉')) ||
      revision.explanation.includes('시험지봉')
    ) {
      errors.push(`${revision.id}: awkward urine dipstick term remains`);
    }
    if (hasQuestionAfterTestPanel(revision.stem)) {
      errors.push(`${revision.id}: question remains after test panel`);
    }
    if (/(무력감|전신쇠약)/.test(revision.stem)) {
      errors.push(`${revision.id}: unnatural subjective symptom wording`);
    }
    if (URINE_PANEL_SUBTOPICS.has(original.sub_topic.code)) {
      if (
        !/\n혈액:/.test(revision.stem) ||
        !/\n(?:소변|첫 아침 소변):/.test(revision.stem)
      ) {
        errors.push(`${revision.id}: blood or urine panel missing`);
      }
      const numericTokens = revision.stem.match(/\d+(?:\.\d+)?/g) ?? [];
      if (numericTokens.length < 8) {
        errors.push(`${revision.id}: urine-panel clinical data too sparse`);
      }
    }
    if (original.sub_topic.code === 'nephrology_m2_l2') {
      if (
        !/\n혈액\(참고치\):/.test(revision.stem) ||
        !/\n소변/.test(revision.stem)
      ) {
        errors.push(`${revision.id}: tubular blood or urine panel missing`);
      }
      const numericTokens = revision.stem.match(/\d+(?:\.\d+)?/g) ?? [];
      if (numericTokens.length < 15) {
        errors.push(`${revision.id}: tubular clinical data too sparse`);
      }
    }
    if (
      RENAL_FUNCTION_BUNCR_SUBTOPICS.has(original.sub_topic.code) &&
      /검사 결과는 다음과 같다|\n혈액:|\n소변:/.test(revision.stem)
    ) {
      errors.push(`${revision.id}: unnecessary renal-function/BUN-Cr panel`);
    }
    if (
      /(기전|작용 부위|표적|목적|기능 장애 부위|유발한 반응)/.test(
        questionLine,
      )
    ) {
      errors.push(`${revision.id}: 기전·작용 중심 발문 잔존`);
    }
  }

  for (const original of targetOriginals) {
    if (!seen.has(original.id)) errors.push(`${original.id}: 수정안 누락`);
  }
  for (const revision of revisions) {
    const original = originals.get(revision.id);
    if (
      original &&
      !TARGET_MODULES.has(moduleCode(original.sub_topic.code))
    ) {
      errors.push(`${revision.id}: 요청 범위 밖 문항`);
    }
  }

  const byModule = {};
  const bySubTopic = {};
  for (const revision of revisions) {
    const original = originals.get(revision.id);
    if (!original) continue;
    const code = moduleCode(original.sub_topic.code);
    const moduleName = TARGET_MODULES.get(code);
    byModule[moduleName] = (byModule[moduleName] ?? 0) + 1;
    const subTopicKey = `${original.sub_topic.code} | ${original.sub_topic.name}`;
    bySubTopic[subTopicKey] = (bySubTopic[subTopicKey] ?? 0) + 1;
  }

  const merged = revisions
    .map((revision) => {
      const original = originals.get(revision.id);
      return {
        id: revision.id,
        module: TARGET_MODULES.get(moduleCode(original.sub_topic.code)),
        sub_topic: original.sub_topic,
        source_updated_at: original.source_updated_at,
        source_content_hash: original.source_content_hash,
        source: {
          stem: original.stem,
          choices: original.choices,
          answer_index: original.answer_index,
          explanation: original.explanation,
          concepts: original.concepts,
          difficulty: original.difficulty,
        },
        revision: {
          stem: revision.stem,
          choices: revision.choices,
          answer_index: revision.answer_index,
          explanation: revision.explanation,
          concepts: revision.concepts ?? original.concepts,
          difficulty: revision.difficulty ?? original.difficulty,
          answer_meaning_changed: revision.answer_meaning_changed ?? false,
          draft_file: revision._draft_file,
          second_pass_file: revision._second_pass_file ?? null,
          decision_pass_file: revision._decision_pass_file ?? null,
          wording_pass_file: revision._wording_pass_file ?? null,
          raw_data_pass_file: revision._raw_data_pass_file ?? null,
          urine_panel_pass_file: revision._urine_panel_pass_file ?? null,
          free_water_terminology_pass_file:
            revision._free_water_terminology_pass_file ?? null,
          clinical_language_pass_file:
            revision._clinical_language_pass_file ?? null,
          tubular_panel_pass_file:
            revision._tubular_panel_pass_file ?? null,
          kmle_water_terminology_pass_file:
            revision._kmle_water_terminology_pass_file ?? null,
          simple_renal_function_buncr_pass_file:
            revision._simple_renal_function_buncr_pass_file ?? null,
          urine_test_terminology_pass_file:
            revision._urine_test_terminology_pass_file ?? null,
          question_position_pass:
            revision._question_position_pass ?? null,
          explanation_file: revision._explanation_file ?? null,
          content_hash: hashContent(revision),
        },
      };
    })
    .sort(
      (a, b) =>
        a.sub_topic.code.localeCompare(b.sub_topic.code, undefined, {
          numeric: true,
        }) || a.id.localeCompare(b.id),
    );

  const report = [
    '# 신장 4개 단원 문항 전후 비교',
    '',
    '> 검토용 초안입니다. Supabase 및 실제 서비스 문제는 변경하지 않았습니다.',
    '>',
    '> 실제 국시·KMLE 문제는 형식과 임상 추론 구조만 참고했으며 문구·수치·선지를 복제하지 않았습니다.',
    '',
    `- 총 문항: ${merged.length}`,
    ...Object.entries(byModule).map(([name, count]) => `- ${name}: ${count}문항`),
    '',
  ];

  let currentSubTopic = null;
  for (const item of merged) {
    const subTopicTitle = `${item.sub_topic.code} · ${item.sub_topic.name}`;
    if (subTopicTitle !== currentSubTopic) {
      currentSubTopic = subTopicTitle;
      report.push(`## ${subTopicTitle}`, '');
    }
    report.push(
      `### ${item.id}`,
      '',
      '#### 기존',
      '',
      item.source.stem,
      '',
      formatChoices(item.source.choices, item.source.answer_index),
      '',
      '#### 수정안',
      '',
      item.revision.stem,
      '',
      formatChoices(item.revision.choices, item.revision.answer_index),
      '',
      `정답 의미 변경: ${item.revision.answer_meaning_changed ? '예 — 별도 승인 필요' : '아니오'}`,
      '',
    );
  }

  const firstPassById = new Map(
    firstPassRevisions.map((revision) => [revision.id, revision]),
  );
  const secondPassById = new Map(
    secondPassRevisions.map((revision) => [revision.id, revision]),
  );
  const secondPassReport = [
    '# 2차 교정 전후 비교',
    '',
    '> 1차 수정안 가운데 정답 노출 또는 비경쟁 오답 문제가 확인된 문항만 다시 교정했습니다.',
    '>',
    '> 실제 국시·KMLE 문제는 임상정보 배열과 추론 단계만 참고했으며 문구·수치·선지를 복제하지 않았습니다.',
    '',
    `- 전체 재검토: ${revisions.length}문항`,
    `- 2차 재작성: ${overrideMap.size}문항`,
    `- 유지: ${revisions.length - overrideMap.size}문항`,
    '',
  ];

  for (const item of merged.filter((entry) => entry.revision.second_pass_file)) {
    const firstPass = firstPassById.get(item.id);
    const secondPass = secondPassById.get(item.id);
    secondPassReport.push(
      `## ${item.sub_topic.code} · ${item.sub_topic.name}`,
      '',
      `### ${item.id}`,
      '',
      '#### 1차 수정안',
      '',
      firstPass.stem,
      '',
      formatChoices(firstPass.choices, firstPass.answer_index),
      '',
      '#### 2차 수정안',
      '',
      secondPass.stem,
      '',
      formatChoices(secondPass.choices, secondPass.answer_index),
      '',
    );
  }

  const decisionPassReport = [
    '# 기전형 문항 → 임상 의사결정형 문항 비교',
    '',
    '> 기전·작용·목적을 직접 묻던 문항을 진단·검사·처치·약물 선택·검사 해석형으로 바꿨습니다.',
    '>',
    '> 실제 국시·KMLE 문구나 수치를 복제하지 않고 발문 유형과 추론 구조만 참고했습니다.',
    '',
    `- 전체 재검토: ${revisions.length}문항`,
    `- 임상 의사결정형으로 전환: ${decisionOverrideMap.size}문항`,
    '',
  ];

  for (const item of merged.filter((entry) => entry.revision.decision_pass_file)) {
    const before = secondPassById.get(item.id);
    decisionPassReport.push(
      `## ${item.sub_topic.code} · ${item.sub_topic.name}`,
      '',
      `### ${item.id}`,
      '',
      '#### 변경 전',
      '',
      before.stem,
      '',
      formatChoices(before.choices, before.answer_index),
      '',
      '#### 변경 후',
      '',
      item.revision.stem,
      '',
      formatChoices(item.revision.choices, item.revision.answer_index),
      '',
    );
  }

  const summary = {
    status: errors.length === 0 ? 'passed' : 'failed',
    generated_at: new Date().toISOString(),
    source: SOURCE,
    target_question_count: targetOriginals.length,
    revision_count: revisions.length,
    unique_revision_count: seen.size,
    second_pass_rewrite_count: overrideMap.size,
    clinical_decision_rewrite_count: decisionOverrideMap.size,
    question_wording_rewrite_count: wordingOverrideMap.size,
    raw_clinical_data_rewrite_count: rawDataOverrideMap.size,
    urine_panel_rewrite_count: urinePanelOverrideMap.size,
    free_water_terminology_rewrite_count:
      freeWaterTerminologyOverrideMap.size,
    clinical_language_rewrite_count: clinicalLanguageOverrideMap.size,
    tubular_panel_rewrite_count: tubularPanelOverrideMap.size,
    kmle_water_terminology_rewrite_count:
      kmleWaterTerminologyOverrideMap.size,
    simple_renal_function_buncr_rewrite_count:
      simpleRenalFunctionBunCrOverrideMap.size,
    urine_test_terminology_rewrite_count:
      urineTestTerminologyOverrideMap.size,
    question_before_test_panel_rewrite_count:
      revisions.filter((revision) => revision._question_position_pass).length,
    full_explanation_count: revisions.filter(
      (revision) =>
        revision.explanation.includes('[정답 근거]') &&
        revision.explanation.includes('[오답 감별]'),
    ).length,
    distractor_rationale_count: rationaleItems.reduce(
      (sum, item) => sum + Object.keys(item.distractors).length,
      0,
    ),
    quality_gates: {
      exact_answer_text_in_stem_warnings: warnings.length,
      choice_count_and_answer_index: errors.length === 0 ? 'passed' : 'failed',
      mechanism_question_stems_remaining: revisions.filter((revision) => {
        const questionLine = revision.stem.trim().split(/\n+/).at(-1) ?? '';
        return /(기전|작용 부위|표적|목적|기능 장애 부위|유발한 반응)/.test(
          questionLine,
        );
      }).length,
      answer_category_leaking_treatment_stems_remaining: revisions.filter(
        (revision) => {
          const questionLine =
            revision.stem.trim().split(/\n+/).at(-1) ?? '';
          return /(초기 수액은|가장 적절한 초기 수액은|가장 적절한 초기 처치는|가장 먼저 투여할 약물은|재발 예방을 위한 초기 치료는|장기 치료는|치료 순서는)\?/.test(
            questionLine,
          );
        },
      ).length,
      summarized_interpretable_clinical_data_remaining: revisions.filter(
        (revision) => RAW_DATA_SUMMARY_PATTERN.test(revision.stem),
      ).length,
      proteinuria_pyuria_panel_completeness:
        revisions
          .filter((revision) => {
            const original = originals.get(revision.id);
            return URINE_PANEL_SUBTOPICS.has(original?.sub_topic.code);
          })
          .every(
            (revision) =>
              /\n혈액:/.test(revision.stem) &&
              /\n(?:소변|첫 아침 소변):/.test(revision.stem) &&
              (revision.stem.match(/\d+(?:\.\d+)?/g) ?? []).length >= 8,
          )
          ? 'passed'
          : 'failed',
      free_water_used_as_treatment_product_remaining: revisions.filter(
        (revision) =>
          revision.choices.some((choice) => /^자유수(?:$|\s|만)/.test(choice)),
      ).length,
      free_water_term_remaining_in_stem_choices_explanations:
        revisions.filter(
          (revision) =>
            revision.stem.includes('자유수') ||
            revision.choices.some((choice) => choice.includes('자유수')) ||
            revision.explanation.includes('자유수'),
        ).length,
      awkward_urine_dipstick_term_remaining:
        revisions.filter(
          (revision) =>
            revision.stem.includes('시험지봉') ||
            revision.choices.some((choice) => choice.includes('시험지봉')) ||
            revision.explanation.includes('시험지봉'),
        ).length,
      question_after_test_panel_remaining:
        revisions.filter((revision) => hasQuestionAfterTestPanel(revision.stem))
          .length,
      renal_function_buncr_multiline_clinical_panels_remaining:
        revisions.filter((revision) => {
          const original = originals.get(revision.id);
          return (
            RENAL_FUNCTION_BUNCR_SUBTOPICS.has(original?.sub_topic.code) &&
            /검사 결과는 다음과 같다|\n혈액:|\n소변:/.test(revision.stem)
          );
        }).length,
      renal_function_buncr_average_stem_characters: Number(
        (
          revisions
            .filter((revision) => {
              const original = originals.get(revision.id);
              return RENAL_FUNCTION_BUNCR_SUBTOPICS.has(
                original?.sub_topic.code,
              );
            })
            .reduce((sum, revision) => sum + revision.stem.length, 0) /
          revisions.filter((revision) => {
            const original = originals.get(revision.id);
            return RENAL_FUNCTION_BUNCR_SUBTOPICS.has(
              original?.sub_topic.code,
            );
          }).length
        ).toFixed(1),
      ),
      unnatural_subjective_symptom_wording_remaining: revisions.filter(
        (revision) => /(무력감|전신쇠약)/.test(revision.stem),
      ).length,
      bartter_choice_question_count: revisions.filter((revision) =>
        revision.choices.some((choice) => choice === 'Bartter증후군'),
      ).length,
      congenital_tubular_panel_completeness:
        revisions
          .filter((revision) => {
            const original = originals.get(revision.id);
            return original?.sub_topic.code === 'nephrology_m2_l2';
          })
          .every(
            (revision) =>
              /\n혈액\(참고치\):/.test(revision.stem) &&
              /\n소변/.test(revision.stem) &&
              (revision.stem.match(/\d+(?:\.\d+)?/g) ?? []).length >= 15,
          )
          ? 'passed'
          : 'failed',
      complete_explanation_structure:
        revisions.every(
          (revision) =>
            revision.explanation.includes('[정답 근거]') &&
            revision.explanation.includes('[오답 감별]'),
        ) && errors.length === 0
          ? 'passed'
          : 'failed',
      same_decision_layer_review: {
        reviewed: revisions.length,
        second_pass_rewritten: overrideMap.size,
        status: 'manual_pass',
      },
      counterfactual_distractor_review: {
        reviewed: revisions.length,
        second_pass_rewritten: overrideMap.size,
        status: 'manual_pass',
      },
    },
    by_module: byModule,
    by_sub_topic: bySubTopic,
    answer_meaning_changed: merged
      .filter((item) => item.revision.answer_meaning_changed)
      .map((item) => ({
        id: item.id,
        sub_topic: item.sub_topic.name,
        before: item.source.choices[item.source.answer_index],
        after: item.revision.choices[item.revision.answer_index],
      })),
    errors,
    warnings,
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'revision-drafts.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        status: 'draft_only_requires_clinical_review',
        database_write: 'none',
        revisions: merged,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'before-after.md'),
    `${report.join('\n')}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'second-pass-before-after.md'),
    `${secondPassReport.join('\n')}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'mechanism-to-decision-before-after.md'),
    `${decisionPassReport.join('\n')}\n`,
    'utf8',
  );
  const reviewReport = [
    '# 신장 4개 단원 문항별 검수표',
    '',
    '> 각 문항을 확인한 뒤 승인 또는 수정 필요에 표시하고, 검수 메모를 적으세요.',
    '>',
    '> Supabase와 실제 서비스 문제에는 아직 반영하지 않았습니다.',
    '',
    `- 전체: ${merged.length}문항`,
    `- 정답 근거: ${summary.full_explanation_count}개`,
    `- 오답별 감별: ${summary.distractor_rationale_count}개`,
    '',
  ];
  for (const [index, item] of merged.entries()) {
    reviewReport.push(
      `## ${index + 1}. ${item.sub_topic.name}`,
      '',
      `문항 ID: ${item.id}`,
      '',
      '- [ ] 승인',
      '- [ ] 수정 필요',
      '',
      '검수 메모:',
      '',
      '---',
      '',
      '### 최종 문항',
      '',
      item.revision.stem,
      '',
      formatChoices(item.revision.choices, item.revision.answer_index),
      '',
      '### 해설',
      '',
      item.revision.explanation,
      '',
      '<details>',
      '<summary>원문 보기</summary>',
      '',
      item.source.stem,
      '',
      formatChoices(item.source.choices, item.source.answer_index),
      '',
      '</details>',
      '',
    );
  }
  await fs.writeFile(
    path.join(OUT_DIR, 'question-by-question-review.md'),
    `${reviewReport.join('\n')}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'validation-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );

  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

await main();
