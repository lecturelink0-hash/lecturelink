/**
 * Domain types — 비즈니스 로직에서 사용하는 타입
 *
 * Database row 타입과 별개로, API 응답·서비스 계층에서 다루는 형태를 정의한다.
 * UI 친화적 변환·계산 필드 포함.
 */

import type {
  AttemptTrack,
  ContentSource,
  ContentTier,
  GradeLevel,
  MedicalImageType,
  PlanTier,
  SemesterTerm,
} from './database';

// ───────────── 코호트 관련 ─────────────

export interface CohortKey {
  schoolId: string;
  grade: GradeLevel;
  year: number;
  semester: SemesterTerm;
  subjectId: string;
}

export interface CohortInsight {
  cohortId: string;
  activeUsers: number;            // 같은 코호트 활성 사용자 수
  totalAttempts: number;
  averageAccuracy: number;        // 0~1
  topInScope: SubTopicInclusion[];      // 시험 범위 포함 빈도 높은 top-N
  topOutOfScope: SubTopicInclusion[];   // 범위 아님 빈도 높은 top-N
}

export interface SubTopicInclusion {
  subTopicId: string;
  subTopicName: string;
  inclusionScore: number; // 0~1
  sampleSize: number;
  confidence: number;
}

// ───────────── 문항 ─────────────

export interface Question {
  id: string;
  subTopic: {
    id: string;
    name: string;
    subjectName: string;
  };
  stem: string;
  choices: string[];
  answerIndex: number;
  explanation: string | null;
  concepts: string[];
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: MedicalImageType | null;
  source: ContentSource;
  tier: ContentTier;
  examRelevance: 1 | 2 | 3;  // sub_topic에서 상속
  stats: {
    timesAnswered: number;
    accuracyRate: number; // 0~1
  };
}

// 풀이 세션에서 사용자에게 전달되는 형태 (정답·해설 숨김)
export interface QuestionForUser {
  id: string;
  stem: string;
  choices: string[];
  concepts: string[];
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: MedicalImageType | null;
  tier: ContentTier;
  badge: {
    label: string;
    color: 'curated' | 'community' | 'beta';
  };
  subjectName: string;
  subTopicName: string;
  /** open_images 풀에서 온 이미지일 때 출처·라이선스 정보. CC BY/CC BY-SA 등은 노출 의무. */
  attribution?: {
    text: string;
    license: string;
    originalUrl: string;
  };
}

// ───────────── 사용자 ─────────────

export interface UserProfile {
  id: string;
  displayName: string | null;
  school: {
    id: string;
    name: string;
    shortName: string;
  } | null;
  grade: GradeLevel | null;
  currentSemester: SemesterTerm | null;
  currentYear: number | null;
  planTier: PlanTier;
  onboardedAt: string | null;
}

// ───────────── 풀이 세션 ─────────────

export interface AttemptInput {
  questionId: string;
  selectedIndex: number;
  timeSpentSeconds: number;
  track: AttemptTrack;
  cohortId?: string;
}

export interface AttemptResult {
  attemptId: string;
  isCorrect: boolean;
  correctIndex: number;
  explanation: string | null;
  // 후속 추천
  nextRecommendations?: string[]; // question IDs
}

export interface OutOfScopeInput {
  questionId: string;
  cohortId: string;
}

// ───────────── 추천 ─────────────

export interface RecommendationRequest {
  userId: string;
  cohortId?: string;
  subjectId?: string;
  excludeIds?: string[];
  count?: number;
  prioritizeWeakAreas?: boolean;
}

export interface RecommendationResult {
  questions: QuestionForUser[];
  rationale: {
    explorationCount: number;
    exploitationCount: number;
    wildCardCount: number;
    weakAreaBoosts: string[]; // sub_topic IDs
  };
}

// ───────────── 약점 ─────────────

export interface WeakArea {
  subTopicId: string;
  subTopicName: string;
  subjectName: string;
  errorCount: number;
  attemptCount: number;
  errorRate: number; // 0~1
  severity: 1 | 2 | 3;
  lastUpdated: string;
  // AI 추천 학습 플랜
  recommendedAction?: {
    type: 'smart_practice' | 'lecture_note';
    description: string;
    questionCount?: number;
  };
}

// ───────────── Track A (강의 노트) ─────────────

export interface UploadRequest {
  fileName: string;
  fileType: 'pdf' | 'pptx' | 'image' | 'dicom';
  fileSizeBytes: number;
}

export interface UploadResult {
  uploadId: string;
  storagePath: string;
  uploadUrl: string; // pre-signed URL
}

export interface GenerateFromUploadInput {
  uploadId: string;
  subjectId?: string;       // 자동 분류 X 시 수동 지정
  style: 'kmle' | 'professor' | 'internal';
  count: number;            // 생성 문항 수
  imageTypes?: MedicalImageType[]; // 이미지 처리할 유형
}

export interface GenerationProgress {
  uploadId: string;
  stage: 'parsing' | 'analyzing' | 'generating' | 'verifying' | 'completed' | 'failed';
  progress: number; // 0~1
  generatedCount: number;
  totalCount: number;
  error?: string;
}

// ───────────── 사용량 / 결제 ─────────────

export interface QuotaSnapshot {
  planTier: PlanTier;
  periodStart: string;
  periodEnd: string;
  questions: {
    used: number;
    limit: number;
    bonus: number;
  };
  uploads: {
    used: number;
    limit: number;
    bonus: number;
  };
  images: {
    used: number;
    limit: number;
    bonus: number;
  };
}

export const PLAN_LIMITS: Record<
  PlanTier,
  { questions: number; uploads: number; images: number; price: number }
> = {
  // 요금제 개편(기획서 기준): 내신 대비 7,900 / 국가고시 대비 9,900 / 통합형 14,900.
  // (통합형 무제한 20,900 은 별도 enum 값이 필요해 백엔드 마이그레이션 후 추가 — 현재는 표시만)
  free: { questions: 50, uploads: 1, images: 5, price: 0 },
  lite: { questions: 500, uploads: 10, images: 30, price: 7900 },
  standard: { questions: 500, uploads: 5, images: 40, price: 9900 },
  pro: { questions: 2000, uploads: 100, images: 200, price: 14900 },
};

// ───────────── AI 생성 파이프라인 ─────────────

export interface QuestionGenerationContext {
  subjectName: string;
  subTopicName: string;
  examRelevance: 1 | 2 | 3;
  isRiskCategory: boolean;
  difficulty: 1 | 2 | 3;
  style: 'kmle' | 'professor' | 'internal';
  examples?: Array<{ stem: string; choices: string[]; explanation: string }>;
  imageContext?: {
    imageUrl: string;
    imageType: MedicalImageType;
  };
}

export interface GeneratedQuestion {
  stem: string;
  choices: string[];
  /**
   * Anthropic tool schema 가 snake_case 로 `answer_index` 를 반환하므로 그대로 사용.
   * 다른 도메인 객체와 일관성 차이가 있지만 AI 응답 매핑 비용을 줄이기 위함.
   */
  answer_index: number;
  explanation: string;
  concepts: string[];
  difficulty: 1 | 2 | 3;
}

export interface VerificationResult {
  passed: boolean;
  score: number; // 0~1
  issues: string[];
  suggestedFixes?: string[];
}
