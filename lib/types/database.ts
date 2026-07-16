/**
 * lib/types/database.ts — 앱이 import 하는 단일 진입점 (wrapper).
 *
 * ╭─ 역할 ───────────────────────────────────────────────────────────────╮
 * │ 1. `Database` 타입을 export.                                            │
 * │ 2. 앱 전역에서 쓰는 alias (PlanTier / GradeLevel / UserRow ... ) 노출.  │
 * │ 3. Insert<T> 같은 helper 타입 제공.                                     │
 * ╰─────────────────────────────────────────────────────────────────────╯
 *
 * Database 출처 (자동 생성 ↔ 수동) 결정 흐름:
 *
 * ┌─ Docker + Supabase 로컬 가용 ────────────────────────────────────────┐
 * │ 1) npm run db:types                                                   │
 * │    → lib/types/database.generated.ts 생성됨 (이 파일과 별도).        │
 * │ 2) 본 파일 하단의 "MANUAL Database 시작/끝" 블록 통째로 제거.        │
 * │ 3) 본 파일 상단에 아래 한 줄 추가:                                    │
 * │      export type { Database } from './database.generated';            │
 * │ 4) tsc / next build 재실행해 alias 들이 generated 와 호환되는지 검증. │
 * │    - 마이그레이션 SQL 과 alias 가 일치하면 통과.                      │
 * │    - 불일치 시 alias 정의를 generated Database 의 enum / table 에서   │
 * │      derive 하도록 수정 (예: `Database['public']['Enums']['plan_tier']`).│
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 현재 (Docker 미설치) ────────────────────────────────────────────┐
 * │ database.generated.ts 가 없으므로 본 파일의 "MANUAL Database" 블록을 │
 * │ 그대로 사용. 마이그레이션 변경 시 본 파일을 직접 손봐야 한다.        │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 주의:
 *   - alias (PlanTier 등) 는 schema enum / table 정의 그 자체이므로
 *     manual ↔ generated 전환 시에도 export 이름은 그대로 유지된다.
 *   - 본 파일이 작아질수록 (alias 만 남고 Database 가 generated 에서 옴)
 *     안전. 지금은 db:types 가 못 돌아 manual 블록이 남아 있을 뿐.
 */

// ───────────── ENUM 타입 ─────────────

export type GradeLevel =
  | 'pre_1'
  | 'pre_2'
  | 'med_1'
  | 'med_2'
  | 'med_3'
  | 'med_4';

export type SemesterTerm = 'spring' | 'fall';

export type PlanTier = 'free' | 'lite' | 'standard' | 'pro';

export type ContentSource =
  | 'team_seed'
  | 'ai_generated'
  | 'ai_user_triggered'
  | 'doctor_reviewed'
  | 'kmle_style_seed';

export type ContentTier = 'curated' | 'community' | 'beta';

export type ContentStatus = 'active' | 'flagged' | 'deprecated';

export type AttemptTrack = 'smart_practice' | 'lecture_note';

export type UploadStatus =
  | 'uploaded'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export type MedicalImageType =
  | 'xray'
  | 'ct'
  | 'mri'
  | 'ecg'
  | 'pathology'
  | 'microscope'
  | 'ultrasound'
  | 'other';

export type SubscriptionStatus = 'active' | 'cancelled' | 'expired' | 'past_due';

export type UserRole = 'user' | 'admin';

export type StudyPurpose = 'naesin' | 'kmle' | 'usmle' | 'other';

export type MockExamStatus = 'in_progress' | 'submitted' | 'abandoned';

export type CpxSessionStatus = 'active' | 'ended';

export type PaymentKind =
  | 'subscription_initial'
  | 'subscription_renewal'
  | 'credit_questions'
  | 'credit_uploads'
  | 'credit_images';

export type PaymentStatus =
  | 'pending'
  | 'approved'
  | 'failed'
  | 'cancelled'
  | 'refunded';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export type OpenImageSource =
  | 'roco_v2'
  | 'nih_chestxray14'
  | 'pmc_open_access'
  | 'wikipedia_commons'
  | 'manual_upload';

export type OpenImageLicense =
  | 'cc0'
  | 'cc_by'
  | 'cc_by_sa'
  | 'public_domain'
  | 'pmc_oa'
  | 'nih_open_access';

// ───────────── 테이블 Row 타입 ─────────────

export type SchoolRow = {
  id: string;
  name: string;
  short_name: string;
  type: string;
  created_at: string;
}

export type SubjectRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export type SubTopicRow = {
  id: string;
  subject_id: string;
  parent_id: string | null;
  level: number;
  code: string;
  name: string;
  exam_relevance: 1 | 2 | 3;
  is_risk_category: boolean;
  sort_order: number;
  created_at: string;
}

export type UserRow = {
  id: string;
  display_name: string | null;
  school_id: string | null;
  grade: GradeLevel | null;
  current_semester: SemesterTerm | null;
  current_year: number | null;
  plan_tier: PlanTier;
  role: UserRole;
  study_purpose: StudyPurpose | null;
  referral_code: string | null;
  acquisition_channel: string | null;
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CohortRow = {
  id: string;
  school_id: string;
  grade: GradeLevel;
  year: number;
  semester: SemesterTerm;
  subject_id: string;
  created_at: string;
}

export type QuestionRow = {
  id: string;
  sub_topic_id: string;
  stem: string;
  choices: string[];
  answer_index: number;
  explanation: string | null;
  concepts: string[];
  difficulty: 1 | 2 | 3;
  image_url: string | null;
  image_type: MedicalImageType | null;
  source: ContentSource;
  tier: ContentTier;
  status: ContentStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  embedding: number[] | null;
  open_image_id: string | null;
  times_answered: number;
  times_correct: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

export type CohortSubTopicScoreRow = {
  cohort_id: string;
  sub_topic_id: string;
  inclusion_score: number;
  sample_size: number;
  confidence: number;
  weighted_score: number; // generated column
  updated_at: string;
}

export type UserAttemptRow = {
  id: string;
  user_id: string;
  question_id: string | null;
  private_question_id: string | null;
  cohort_id: string | null;
  track: AttemptTrack;
  selected_index: number;
  is_correct: boolean;
  time_spent_seconds: number | null;
  created_at: string;
}

export type OutOfScopeFeedbackRow = {
  id: string;
  user_id: string;
  question_id: string;
  sub_topic_id: string;
  cohort_id: string;
  created_at: string;
}

export type UserWeakAreaRow = {
  user_id: string;
  sub_topic_id: string;
  error_count: number;
  attempt_count: number;
  error_rate: number; // generated
  severity: 1 | 2 | 3;
  last_updated: string;
}

export type UserUploadRow = {
  id: string;
  user_id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  storage_path: string;
  status: UploadStatus;
  extracted_text: string | null;
  page_count: number | null;
  error_message: string | null;
  processed_at: string | null;
  created_at: string;
}

export type PrivateQuestionRow = {
  id: string;
  user_id: string;
  upload_id: string;
  sub_topic_id: string | null;
  stem: string;
  choices: string[];
  answer_index: number;
  explanation: string | null;
  concepts: string[];
  difficulty: 1 | 2 | 3;
  created_at: string;
}

export type PrivateQuestionImageRow = {
  id: string;
  private_question_id: string;
  user_id: string;
  upload_id: string;
  storage_path: string;
  source_page: number | null;
  kind: string | null;
  caption: string | null;
  sort_order: number;
  created_at: string;
}

export type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_tier: PlanTier;
  status: SubscriptionStatus;
  started_at: string;
  expires_at: string | null;
  auto_renew: boolean;
  payment_provider: string | null;
  provider_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export type UsageQuotaRow = {
  user_id: string;
  period_start: string; // ISO date
  period_end: string;
  questions_used: number;
  uploads_used: number;
  images_used: number;
  weakness_reports_used: number;
  bonus_questions: number;
  bonus_uploads: number;
  bonus_images: number;
  updated_at: string;
}

export type PaymentRow = {
  id: string;
  user_id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount_krw: number;
  plan_tier: PlanTier | null;
  credit_amount: number | null;
  toss_order_id: string;
  toss_payment_key: string | null;
  failure_reason: string | null;
  raw_response: Record<string, unknown> | null;
  approved_at: string | null;
  subscription_id: string | null;
  entitlement_granted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AiCostLogRow = {
  id: string;
  user_id: string | null;
  endpoint: string;
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export type OpsAlertRow = {
  id: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  payload: Record<string, unknown> | null;
  resolved_at: string | null;
  created_at: string;
}

export type OpenImageRow = {
  id: string;
  source: OpenImageSource;
  source_id: string;
  modality: MedicalImageType;
  sub_topic_id: string | null;
  license: OpenImageLicense;
  attribution_text: string;
  original_url: string;
  storage_path: string | null;
  caption: string | null;
  keywords: string[] | null;
  embedding: number[] | null;
  width_px: number | null;
  height_px: number | null;
  file_size_bytes: number | null;
  ingested_at: string;
  ingested_by: string | null;
  is_active: boolean;
}

export type CohortScoreRecalcQueueRow = {
  id: number;
  cohort_id: string;
  sub_topic_id: string;
  enqueued_at: string;
  processed_at: string | null;
}

export type ExamScheduleRow = {
  id: string;
  user_id: string;
  title: string;
  exam_date: string; // ISO date
  subject_id: string | null;
  memo: string | null;
  color: string;
  created_at: string;
}

export type SavedWrongQuestionRow = {
  id: string;
  user_id: string;
  question_id: string | null;
  private_question_id: string | null;
  sub_topic_id: string | null;
  selected_index: number | null;
  source: string;
  resolved: boolean;
  created_at: string;
}

export type MockExamSessionRow = {
  id: string;
  user_id: string;
  title: string;
  subject_ids: string[];
  question_ids: string[];
  answers: number[];
  flagged: number[];
  memo: string | null;
  status: MockExamStatus;
  score: number | null;
  total: number;
  duration_seconds: number | null;
  started_at: string;
  submitted_at: string | null;
  created_at: string;
}

export type CpxSessionRow = {
  id: string;
  user_id: string;
  external_session_id: string;
  case_id: string;
  persona: Record<string, unknown>;
  status: CpxSessionStatus;
  result: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CpxTranscriptEventRow = {
  id: number;
  user_id: string;
  session_id: string;
  role: 'student' | 'patient' | 'system';
  text: string;
  t_offset_ms: number;
  created_at: string;
}

export type CpxPhysicalExamEventRow = {
  id: number;
  user_id: string;
  session_id: string;
  button_id: string;
  t_offset_ms: number;
  result: Record<string, unknown>;
  created_at: string;
}

// ───────────── Insert/Update 타입 (DB writes) ─────────────

/**
 * Supabase 가 자동 생성하는 컬럼(`created_at`/`updated_at`/`id`) 은 insert 시
 * 생략 가능해야 한다. `Pick<T, 'id'>` 가 'id' 가 없는 row 에서 컴파일 실패하는 문제를
 * 피하기 위해 conditional 로 처리.
 *
 * 또한 NOT NULL DEFAULT / nullable 컬럼이 많아 정확한 require/optional 매핑은 어렵다.
 * 실 사용처(API 라우트) 는 Postgres 기본값/NOT NULL 위배를 런타임에 처리하므로 여기서는
 * Partial 로 너그럽게 허용한다. (Supabase gen 출력이 들어오면 정밀해진다.)
 */
type WithOptionalId<T> = T extends { id: infer I } ? { id?: I } : Record<never, never>;
export type Insert<T> = Partial<Omit<T, 'created_at' | 'updated_at' | 'id'>> &
  WithOptionalId<T>;

export type Update<T> = Partial<Omit<T, 'id' | 'created_at'>>;

// ───────────── Supabase Database 인터페이스 ─────────────

// supabase gen typescript 가 만드는 Relationships 와 동일한 구조.
// .select('embed:other_table(...)') 형식 nested query 가 통과하려면 FK 가 명시돼야 함.
type FK<
  Self extends string,
  Col extends string,
  Target extends string,
> = {
  foreignKeyName: `${Self}_${Col}_fkey`;
  columns: [Col];
  isOneToOne: false;
  referencedRelation: Target;
  referencedColumns: ['id'];
};
type Rel = never[];

// ╭───────────────── MANUAL Database 시작 ─────────────────╮
// │ db:types 후 본 블록을 통째로 제거하고                    │
// │   export type { Database } from './database.generated'; │
// │ 한 줄로 교체. alias 정의(상단) 와 helper 정의(상위) 는   │
// │ 그대로 유지하면 앱 코드 변경 없이 전환된다.              │
// ╰────────────────────────────────────────────────────╯
export interface Database {
  public: {
    Tables: {
      schools: {
        Row: SchoolRow;
        Insert: Insert<SchoolRow>;
        Update: Update<SchoolRow>;
        Relationships: Rel;
      };
      subjects: {
        Row: SubjectRow;
        Insert: Insert<SubjectRow>;
        Update: Update<SubjectRow>;
        Relationships: Rel;
      };
      sub_topics: {
        Row: SubTopicRow;
        Insert: Insert<SubTopicRow>;
        Update: Update<SubTopicRow>;
        Relationships: [FK<'sub_topics', 'subject_id', 'subjects'>];
      };
      users: {
        Row: UserRow;
        Insert: Insert<UserRow>;
        Update: Update<UserRow>;
        Relationships: [FK<'users', 'school_id', 'schools'>];
      };
      cohorts: {
        Row: CohortRow;
        Insert: Insert<CohortRow>;
        Update: Update<CohortRow>;
        Relationships: [
          FK<'cohorts', 'school_id', 'schools'>,
          FK<'cohorts', 'subject_id', 'subjects'>,
        ];
      };
      questions: {
        Row: QuestionRow;
        Insert: Insert<QuestionRow>;
        Update: Update<QuestionRow>;
        Relationships: [
          FK<'questions', 'sub_topic_id', 'sub_topics'>,
          FK<'questions', 'open_image_id', 'open_images'>,
        ];
      };
      cohort_sub_topic_scores: {
        Row: CohortSubTopicScoreRow;
        Insert: Omit<CohortSubTopicScoreRow, 'weighted_score' | 'updated_at'>;
        Update: Partial<
          Omit<CohortSubTopicScoreRow, 'cohort_id' | 'sub_topic_id' | 'weighted_score'>
        >;
        Relationships: [
          FK<'cohort_sub_topic_scores', 'cohort_id', 'cohorts'>,
          FK<'cohort_sub_topic_scores', 'sub_topic_id', 'sub_topics'>,
        ];
      };
      user_attempts: {
        Row: UserAttemptRow;
        Insert: Insert<UserAttemptRow>;
        Update: Update<UserAttemptRow>;
        Relationships: [
          FK<'user_attempts', 'user_id', 'users'>,
          FK<'user_attempts', 'question_id', 'questions'>,
          FK<'user_attempts', 'cohort_id', 'cohorts'>,
        ];
      };
      out_of_scope_feedback: {
        Row: OutOfScopeFeedbackRow;
        Insert: Insert<OutOfScopeFeedbackRow>;
        Update: Update<OutOfScopeFeedbackRow>;
        Relationships: [
          FK<'out_of_scope_feedback', 'user_id', 'users'>,
          FK<'out_of_scope_feedback', 'question_id', 'questions'>,
          FK<'out_of_scope_feedback', 'sub_topic_id', 'sub_topics'>,
          FK<'out_of_scope_feedback', 'cohort_id', 'cohorts'>,
        ];
      };
      user_weak_areas: {
        Row: UserWeakAreaRow;
        Insert: Omit<UserWeakAreaRow, 'error_rate' | 'last_updated'>;
        Update: Partial<
          Omit<UserWeakAreaRow, 'user_id' | 'sub_topic_id' | 'error_rate'>
        >;
        Relationships: [
          FK<'user_weak_areas', 'user_id', 'users'>,
          FK<'user_weak_areas', 'sub_topic_id', 'sub_topics'>,
        ];
      };
      user_uploads: {
        Row: UserUploadRow;
        Insert: Insert<UserUploadRow>;
        Update: Update<UserUploadRow>;
        Relationships: [FK<'user_uploads', 'user_id', 'users'>];
      };
      private_questions: {
        Row: PrivateQuestionRow;
        Insert: Insert<PrivateQuestionRow>;
        Update: Update<PrivateQuestionRow>;
        Relationships: [
          FK<'private_questions', 'user_id', 'users'>,
          FK<'private_questions', 'upload_id', 'user_uploads'>,
          FK<'private_questions', 'sub_topic_id', 'sub_topics'>,
        ];
      };
      private_question_images: {
        Row: PrivateQuestionImageRow;
        Insert: Insert<PrivateQuestionImageRow>;
        Update: Update<PrivateQuestionImageRow>;
        Relationships: [
          FK<'private_question_images', 'private_question_id', 'private_questions'>,
          FK<'private_question_images', 'user_id', 'users'>,
          FK<'private_question_images', 'upload_id', 'user_uploads'>,
        ];
      };
      subscriptions: {
        Row: SubscriptionRow;
        Insert: Insert<SubscriptionRow>;
        Update: Update<SubscriptionRow>;
        Relationships: [FK<'subscriptions', 'user_id', 'users'>];
      };
      usage_quotas: {
        Row: UsageQuotaRow;
        Insert: Omit<UsageQuotaRow, 'updated_at'>;
        Update: Partial<Omit<UsageQuotaRow, 'user_id' | 'period_start'>>;
        Relationships: [FK<'usage_quotas', 'user_id', 'users'>];
      };
      payments: {
        Row: PaymentRow;
        Insert: Insert<PaymentRow>;
        Update: Update<PaymentRow>;
        Relationships: [
          FK<'payments', 'user_id', 'users'>,
          FK<'payments', 'subscription_id', 'subscriptions'>,
        ];
      };
      ai_cost_log: {
        Row: AiCostLogRow;
        Insert: Insert<AiCostLogRow>;
        Update: Update<AiCostLogRow>;
        Relationships: [FK<'ai_cost_log', 'user_id', 'users'>];
      };
      ops_alerts: {
        Row: OpsAlertRow;
        Insert: Insert<OpsAlertRow>;
        Update: Update<OpsAlertRow>;
        Relationships: Rel;
      };
      open_images: {
        Row: OpenImageRow;
        Insert: Insert<OpenImageRow>;
        Update: Update<OpenImageRow>;
        Relationships: [
          FK<'open_images', 'sub_topic_id', 'sub_topics'>,
          FK<'open_images', 'ingested_by', 'users'>,
        ];
      };
      cohort_score_recalc_queue: {
        Row: CohortScoreRecalcQueueRow;
        Insert: Partial<Omit<CohortScoreRecalcQueueRow, 'id' | 'enqueued_at'>>;
        Update: Partial<Omit<CohortScoreRecalcQueueRow, 'id'>>;
        Relationships: [
          FK<'cohort_score_recalc_queue', 'cohort_id', 'cohorts'>,
          FK<'cohort_score_recalc_queue', 'sub_topic_id', 'sub_topics'>,
        ];
      };
      exam_schedules: {
        Row: ExamScheduleRow;
        Insert: Insert<ExamScheduleRow>;
        Update: Update<ExamScheduleRow>;
        Relationships: [
          FK<'exam_schedules', 'user_id', 'users'>,
          FK<'exam_schedules', 'subject_id', 'subjects'>,
        ];
      };
      saved_wrong_questions: {
        Row: SavedWrongQuestionRow;
        Insert: Insert<SavedWrongQuestionRow>;
        Update: Update<SavedWrongQuestionRow>;
        Relationships: [
          FK<'saved_wrong_questions', 'user_id', 'users'>,
          FK<'saved_wrong_questions', 'question_id', 'questions'>,
          FK<'saved_wrong_questions', 'private_question_id', 'private_questions'>,
          FK<'saved_wrong_questions', 'sub_topic_id', 'sub_topics'>,
        ];
      };
      mock_exam_sessions: {
        Row: MockExamSessionRow;
        Insert: Insert<MockExamSessionRow>;
        Update: Update<MockExamSessionRow>;
        Relationships: [FK<'mock_exam_sessions', 'user_id', 'users'>];
      };
      cpx_sessions: {
        Row: CpxSessionRow;
        Insert: Insert<CpxSessionRow>;
        Update: Update<CpxSessionRow>;
        Relationships: [FK<'cpx_sessions', 'user_id', 'users'>];
      };
      cpx_transcript_events: {
        Row: CpxTranscriptEventRow;
        Insert: Insert<CpxTranscriptEventRow>;
        Update: Update<CpxTranscriptEventRow>;
        Relationships: [
          FK<'cpx_transcript_events', 'user_id', 'users'>,
          FK<'cpx_transcript_events', 'session_id', 'cpx_sessions'>,
        ];
      };
      cpx_physical_exam_events: {
        Row: CpxPhysicalExamEventRow;
        Insert: Insert<CpxPhysicalExamEventRow>;
        Update: Update<CpxPhysicalExamEventRow>;
        Relationships: [
          FK<'cpx_physical_exam_events', 'user_id', 'users'>,
          FK<'cpx_physical_exam_events', 'session_id', 'cpx_sessions'>,
        ];
      };
    };
    Functions: {
      // ───── quota / bonus / payment ─────
      ensure_quota_row: {
        Args: { p_user_id: string };
        Returns: UsageQuotaRow;
      };
      current_quota_period: {
        Args: { p_now?: string };
        Returns: { period_start: string; period_end: string }[];
      };
      check_user_quota: {
        Args: {
          p_user_id: string;
          p_resource: 'questions' | 'uploads' | 'images';
          p_amount?: number;
        };
        Returns: {
          ok: boolean;
          plan_tier: PlanTier;
          limit_amount: number;
          used_amount: number;
          bonus_amount: number;
          remaining: number;
        }[];
      };
      consume_quota: {
        Args: {
          p_user_id: string;
          p_resource: 'questions' | 'uploads' | 'images';
          p_amount?: number;
        };
        Returns: void;
      };
      consume_quota_checked: {
        Args: {
          p_user_id: string;
          p_resource: 'questions' | 'uploads' | 'images';
          p_amount?: number;
        };
        Returns: {
          ok: boolean;
          plan_tier: PlanTier;
          limit_amount: number;
          used_amount: number;
          bonus_amount: number;
          remaining: number;
        }[];
      };
      add_bonus_credits: {
        Args: {
          p_user_id: string;
          p_resource: 'questions' | 'uploads' | 'images';
          p_amount: number;
        };
        Returns: void;
      };
      reset_expired_bonuses: {
        Args: Record<string, never>;
        Returns: void;
      };
      apply_payment_credit_bonus: {
        Args: { p_payment_id: string };
        Returns: {
          applied: boolean;
          kind: string;
          credit_amount: number;
        }[];
      };

      // ───── AI 비용 / admin ─────
      is_admin: {
        Args: { user_id: string };
        Returns: boolean;
      };
      daily_ai_cost_usd: {
        Args: Record<string, never>;
        Returns: number;
      };
      check_daily_cost_within: {
        Args: { threshold_usd: number };
        Returns: {
          within_cap: boolean;
          current_usd: number;
          threshold: number;
        }[];
      };

      // ───── 코호트 / bandit ─────
      calc_user_weight: {
        Args: { p_user_id: string };
        Returns: number;
      };
      recalc_cohort_subtopic_score: {
        Args: { p_cohort_id: string; p_sub_topic_id: string };
        Returns: void;
      };
      detect_curriculum_drift: {
        Args: { p_cohort_id: string };
        Returns: {
          sub_topic_id: string;
          sub_topic_name: string;
          current_score: number;
          previous_score: number;
          delta: number;
          direction: 'expanded' | 'narrowed';
        }[];
      };
      cohort_active_users: {
        Args: { p_cohort_id: string; p_days?: number };
        Returns: number;
      };
      process_cohort_score_recalc_queue: {
        Args: Record<string, never>;
        Returns: void;
      };

      // ───── 임베딩 검색 / 통계 ─────
      match_questions: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          exclude_ids?: string[];
          sub_topic_filter?: string[] | null;
        };
        Returns: {
          id: string;
          sub_topic_id: string;
          stem: string;
          similarity: number;
        }[];
      };
      match_open_images: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          modality_filter?: MedicalImageType | null;
          sub_topic_filter?: string[] | null;
        };
        Returns: {
          id: string;
          similarity: number;
          modality: MedicalImageType;
          sub_topic_id: string | null;
          caption: string | null;
          original_url: string;
          attribution_text: string;
          license: OpenImageLicense;
        }[];
      };
      increment_question_stats: {
        Args: { p_question_id: string; p_is_correct: boolean };
        Returns: void;
      };
    };
    Enums: {
      grade_level: GradeLevel;
      semester_term: SemesterTerm;
      plan_tier: PlanTier;
      content_source: ContentSource;
      content_tier: ContentTier;
      content_status: ContentStatus;
      attempt_track: AttemptTrack;
      upload_status: UploadStatus;
      medical_image_type: MedicalImageType;
      subscription_status: SubscriptionStatus;
      user_role: UserRole;
      payment_kind: PaymentKind;
      payment_status: PaymentStatus;
      alert_severity: AlertSeverity;
      open_image_source: OpenImageSource;
      open_image_license: OpenImageLicense;
      study_purpose: StudyPurpose;
      mock_exam_status: MockExamStatus;
    };
    Views: {
      [K: string]: {
        Row: Record<string, unknown>;
        Relationships: never[];
      };
    };
    CompositeTypes: {
      [K: string]: Record<string, unknown>;
    };
  };
}
// ╰───────────────── MANUAL Database 끝 ─────────────────╯
