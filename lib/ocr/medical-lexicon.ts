/**
 * OCR 결과 후처리 — 의학 약어·용어 사전.
 *
 * 작용:
 *   1. 흔한 OCR 오인식 보정 (예: "MI" → "M1" 같이 잘못 인식되는 패턴 복원)
 *   2. 한·영 혼용 약어 표준화 (대소문자 통일)
 *   3. 단위 정규화 (mm Hg → mmHg, mg / dl → mg/dL)
 *
 * 사전 규모: 약어 ~250개, 단위 ~30개, 자주 틀리는 패턴 ~50개.
 * 추후 사용자 피드백으로 키울 수 있도록 모듈화.
 */

// 의학 약어 (영문) — OCR 후 대소문자 통일·하이픈 정리.
// 주의:
//   - 너무 짧은 토큰(2~3글자, 대소문자 무시) 은 일반 단어와 충돌 가능. 흔한 충돌은
//     아래 리스트에서 제외했고, 새로 추가할 때도 영어 일반 단어와 겹치는지 확인할 것.
//   - 중복 항목은 자동으로 한 번만 적용되므로 카테고리별 표기를 위해 일부러 남겨도 OK.
const ABBREVIATIONS: string[] = [
  // 심장
  'MI', 'NSTEMI', 'STEMI', 'CHF', 'CAD', 'PCI', 'CABG', 'AF', 'VT', 'VF',
  'PVC', 'PSVT', 'WPW', 'LBBB', 'RBBB', 'LAD', 'RCA', 'LCX', 'LVEF', 'LVH',
  'HCM', 'DCM', 'IE', 'AS', 'AR', 'MS', 'MR', 'TR', 'TS', 'PS', 'PR',
  'HTN', 'HLD',
  // 호흡기
  'COPD', 'ARDS', 'PE', 'DVT', 'TB', 'PCP', 'IPF', 'OSA', 'ABG', 'PEEP',
  'FEV1', 'FVC', 'DLCO', 'PFT', 'SOB', 'CXR', 'HRCT',
  // 소화기
  'GI', 'GERD', 'IBD', 'IBS', 'UC', 'PUD', 'LFT', 'ALT', 'AST', 'ALP',
  'GGT', 'HCC', 'NAFLD', 'NASH', 'HBV', 'HCV', 'HAV', 'ERCP', 'EGD',
  // 신장·내분비
  'CKD', 'AKI', 'ESRD', 'GFR', 'BUN', 'Cr', 'UA', 'DM', 'DKA', 'HHS',
  'T1DM', 'T2DM', 'HbA1c', 'TSH', 'T3', 'T4', 'PTH', 'ACTH', 'SIADH',
  'fT3', 'fT4', 'GH', 'IGF-1', 'eGFR',
  // 신경
  'CVA', 'TIA', 'ICH', 'SAH', 'GCS', 'ALS', 'PD', 'AD', 'CSF',
  'EEG', 'EMG', 'NCS', 'LP',
  // 종양·혈액
  'CBC', 'WBC', 'RBC', 'Hb', 'Hct', 'MCV', 'PLT', 'PT', 'aPTT', 'INR',
  'DIC', 'ITP', 'TTP', 'AML', 'ALL', 'CML', 'CLL', 'NHL', 'HL', 'MM',
  // 영상
  'CT', 'MRI', 'PET', 'US', 'EKG', 'ECG', 'X-ray', 'KUB', 'IVP', 'CTA',
  'MRA',
  // 응급·중환자
  'CPR', 'ACLS', 'BLS', 'ICU', 'NICU', 'PICU', 'ER', 'ED', 'BP', 'HR',
  'RR', 'SpO2', 'EtCO2', 'IV', 'IM', 'SC', 'PO', 'NPO', 'NG', 'ET',
  // 약물·치료
  'ACEi', 'ARB', 'CCB', 'BB', 'NSAID', 'PPI', 'H2RA', 'SSRI', 'TCA',
  'MAOI', 'ABx', 'IVIG', 'TPN',
  // 기타
  'KMLE', 'OSCE', 'CC', 'PI', 'PMH', 'FH', 'SH', 'ROS', 'Dx', 'Tx', 'Rx',
];

// 단위 정규화: 잘못 띄어쓴 패턴 → 정상
const UNIT_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\bmm\s*Hg\b/gi, 'mmHg'],
  [/\bmg\s*\/\s*d\s*[lL]\b/g, 'mg/dL'],
  [/\bmg\s*\/\s*[kK]g\b/g, 'mg/kg'],
  [/\bmcg\s*\/\s*[kK]g\b/g, 'mcg/kg'],
  [/\bmEq\s*\/\s*[lL]\b/g, 'mEq/L'],
  [/\bmmol\s*\/\s*[lL]\b/g, 'mmol/L'],
  [/\bIU\s*\/\s*[lL]\b/g, 'IU/L'],
  [/\bU\s*\/\s*[lL]\b/g, 'U/L'],
  [/\bL\s*\/\s*min\b/g, 'L/min'],
  [/\bbpm\s*\.?\b/gi, 'bpm'],
  [/\b(\d)\s*°\s*C\b/g, '$1°C'],
  [/\b(\d)\s*%\b/g, '$1%'],
];

// 자주 틀리는 OCR 패턴: 약어가 숫자·기호로 잘못 인식되는 패턴 보정
// (전체 단어 경계에서만 적용해 본문 텍스트는 건드리지 않음)
const COMMON_MISREADS: Array<[RegExp, string]> = [
  [/\bM1\b(?=\s*(occlusion|infarct|심근|급성))/g, 'MI'],
  [/\bC0PD\b/gi, 'COPD'],
  [/\bC0VID\b/gi, 'COVID'],
  [/\bAF1B\b/g, 'AFIB'],
  [/\bV-?Tach\b/gi, 'VT'],
  [/\bV-?Fib\b/gi, 'VF'],
  [/\bS-?T\s*분절\b/g, 'ST 분절'],
  [/\bQ-?T\s*간격\b/g, 'QT 간격'],
];

// 한국어 의학 용어 — 띄어쓰기/오기 정규화
const KOREAN_TERMS: Array<[RegExp, string]> = [
  [/\b급성\s*심근\s*경색\b/g, '급성 심근경색'],
  [/\b만성\s*폐쇄성\s*폐\s*질환\b/g, '만성 폐쇄성 폐질환'],
  [/\b심부전\b/g, '심부전'],
  [/\b부정맥\b/g, '부정맥'],
  [/\b심실\s*세동\b/g, '심실세동'],
  [/\b심방\s*세동\b/g, '심방세동'],
];

function normalizeAbbreviations(text: string): string {
  let out = text;
  for (const abbr of ABBREVIATIONS) {
    // 단어 경계에서 대소문자 무시 매치 → 표준 형태로 치환
    const pattern = new RegExp(
      `\\b${abbr.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`,
      'gi',
    );
    out = out.replace(pattern, abbr);
  }
  return out;
}

function normalizeUnits(text: string): string {
  let out = text;
  for (const [re, replace] of UNIT_NORMALIZATIONS) {
    out = out.replace(re, replace);
  }
  return out;
}

function fixCommonMisreads(text: string): string {
  let out = text;
  for (const [re, replace] of COMMON_MISREADS) {
    out = out.replace(re, replace);
  }
  return out;
}

function normalizeKoreanTerms(text: string): string {
  let out = text;
  for (const [re, replace] of KOREAN_TERMS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * 통합 후처리.
 */
export function postprocessText(raw: string): string {
  if (!raw) return raw;
  let t = raw;
  t = fixCommonMisreads(t);
  t = normalizeAbbreviations(t);
  t = normalizeUnits(t);
  t = normalizeKoreanTerms(t);
  // 공백 정리
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

export const LEXICON_STATS = {
  abbreviations: ABBREVIATIONS.length,
  unitRules: UNIT_NORMALIZATIONS.length,
  misreadRules: COMMON_MISREADS.length,
  koreanRules: KOREAN_TERMS.length,
};
