export interface SystemInfo {
  setupRequired: boolean;
  workspaceRoot: string;
  codexAutoRun: boolean;
  codexRunner: "local" | "ssh";
  ragChunkCount: number;
  ragQuestionCount?: number;
  ragSnippetCount?: number;
}

export type DiagnosticStatus = "ok" | "warn" | "fail";

export interface DiagnosticItem {
  key: string;
  label: string;
  status: DiagnosticStatus;
  message: string;
  detail?: string;
}

export interface Diagnostics {
  status: DiagnosticStatus;
  checkedAt: string;
  config: {
    projectRoot: string;
    workspaceRoot: string;
    materialRoot: string;
    dataDir: string;
    codexRunner: "local" | "ssh";
    codexAutoRun: boolean;
    maxUploadFiles: number;
    trustProxy: boolean;
    secureCookies: boolean;
    enableHsts: boolean;
    authRateLimitMax: number;
    authRateLimitWindowMs: number;
  };
  counts: {
    users: number;
    students: number;
    courses: number;
    jobs: number;
    runningJobs: number;
    materials: number;
    indexedMaterials: number;
    ragChunks: number;
    ragQuestions?: number;
    ragSnippets?: number;
  };
  checks: DiagnosticItem[];
}

export interface User {
  id: string;
  username: string;
}

export interface Student {
  id: string;
  name: string;
  stage?: string;
  notes?: string;
  weakPoints?: string;
  commonMistakes?: string;
  parentNotes?: string;
  nextLessonSuggestion?: string;
  learningMemory?: string;
  learningRoadmap?: string;
  courseCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type QualityStatus = "pass" | "warn" | "fail";

export interface QualityCheckItem {
  key: string;
  label: string;
  status: QualityStatus;
  message: string;
  path?: string;
}

export interface GenerationQuality {
  score: number;
  status: QualityStatus;
  checkedAt: string;
  items: QualityCheckItem[];
}

export type CourseType = "trial" | "formal";
export type CourseStatus = "draft" | "queued" | "running" | "completed" | "failed" | "canceled";
export type JobKind = "lesson" | "pdf-image-refine";

export interface Course {
  id: string;
  studentId: string;
  type: CourseType;
  stage: string;
  grade: string;
  score: string;
  province: string;
  textbook: string;
  lessonKind: string;
  desiredContent: string;
  lessonTime: string;
  durationMinutes: number;
  localFiles: string;
  notes: string;
  codexPromptOverride?: string;
  outputDir: string;
  status: CourseStatus;
  jobId?: string;
  feishuSync?: CourseFeishuSync;
  postClassSummary?: CoursePostClassSummary;
  createdAt: string;
  updatedAt: string;
}

export interface CoursePostClassSummary {
  status?: "draft" | "confirmed";
  linkedPrevious?: string;
  learned?: string;
  mastered?: string;
  unresolved?: string;
  commonMistakes?: string;
  homework?: string;
  nextLessonSuggestion?: string;
  teacherNotes?: string;
  updatedAt?: string;
  confirmedAt?: string;
}

export interface CourseFeishuSync {
  folderToken?: string;
  folderUrl?: string;
  calendarEventId?: string;
  calendarId?: string;
  lastJobId?: string;
  lastSyncedAt?: string;
  pdfFileToken?: string;
  pdfFileUrl?: string;
  notificationStatus?: "sent" | "failed" | "skipped";
  notificationDetail?: string;
  notificationAttemptedAt?: string;
  notificationSentAt?: string;
  lastNotificationText?: string;
}

export interface Job {
  id: string;
  courseId: string;
  kind?: JobKind;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  logPath: string;
  lastMessagePath: string;
  command: string;
  runner: "local" | "ssh";
  refineInstruction?: string;
  supplementalFiles?: string[];
  pdfRefinePages?: string;
  quality?: GenerationQuality;
  exitCode?: number | null;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface CourseFile {
  name: string;
  path: string;
  relativePath: string;
  kind: "markdown" | "pdf" | "image" | "text" | "other";
  size: number;
  updatedAt: string;
}

export interface Material {
  id: string;
  title: string;
  path: string;
  size: number;
  mimeType?: string;
  status: "indexed" | "failed" | "unsupported" | "needs_conversion" | "pending";
  chunkCount: number;
  questionCount?: number;
  snippetCount?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LessonTemplate {
  id: string;
  name: string;
  description: string;
  type: CourseType;
  durationMinutes: number;
  textbook: string;
  lessonKind: string;
  notes: string;
  codexPromptOverride: string;
  createdAt: string;
  updatedAt: string;
}

export interface RagQuestionRecord {
  id: string;
  materialId: string;
  path: string;
  title: string;
  index: number;
  label: string;
  questionNumber: string;
  text: string;
  answer: string;
  solution: string;
  context: string;
  sourceKind: "exam" | "mock" | "local" | "adapted" | "self_written" | "unknown";
  examSource: string;
  questionType: string;
  difficulty: string;
  teachingRoles: string[];
  knowledgeTags: string[];
  tags: string[];
  tokens: string[];
  hasAnswer: boolean;
  formulaCount: number;
  imageCount: number;
  qualityWarnings: string[];
  fingerprint: string;
  duplicateClusterId: string;
  isClusterRepresentative: boolean;
  answerQuality: "none" | "answer_only" | "solution_steps" | "detailed_solution";
}

export type RagSourceKind = RagQuestionRecord["sourceKind"];

export interface RagSearchResult {
  score: number;
  scoreParts: Record<string, number>;
  matchedTags: string[];
  reason: string;
  material: Material & { tags?: string[] };
  question?: RagQuestionRecord;
  snippet?: {
    id: string;
    materialId: string;
    path: string;
    title: string;
    index: number;
    kind: "knowledge" | "answer" | "metadata" | "chunk";
    text: string;
    context: string;
    tags: string[];
    tokens: string[];
    formulaCount: number;
    imageCount: number;
  };
  chunks: Array<{
    chunk: {
      id: string;
      materialId: string;
      path: string;
      title: string;
      index: number;
      text: string;
      tokens: string[];
      tags?: string[];
      summary?: string;
      context?: string;
    };
    excerpt: string;
    score: number;
  }>;
  chunk: {
    id: string;
    materialId: string;
    path: string;
    title: string;
    index: number;
    text: string;
    tokens: string[];
    tags?: string[];
    summary?: string;
    context?: string;
  };
  excerpt: string;
}

export interface RagReindexJob {
  status: "idle" | "running" | "completed" | "failed";
  total: number;
  processed: number;
  current: string;
  indexed: number;
  error: string;
  startedAt: string;
  endedAt: string;
}

export type DashboardNextAction = "prepare" | "monitor" | "retry" | "review" | "post_class";

export interface DashboardCourseSummary {
  courseId: string;
  studentId: string;
  studentName: string;
  title: string;
  type: CourseType;
  lessonTime: string;
  durationMinutes: number;
  status: CourseStatus;
  updatedAt: string;
  nextAction: DashboardNextAction;
}

export interface DashboardAttentionItem extends DashboardCourseSummary {
  reason: string;
}

export interface DashboardActivity {
  id: string;
  kind: "course" | "job" | "material";
  title: string;
  detail: string;
  status: string;
  occurredAt: string;
  courseId?: string;
  studentId?: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  metrics: {
    studentCount: number;
    courseCount: number;
    completedCourseCount: number;
    activeJobCount: number;
    upcomingCourseCount: number;
    postClassPendingCount: number;
    indexedMaterialCount: number;
    indexedKnowledgeCount: number;
    averageQualityScore: number | null;
  };
  upcomingCourses: DashboardCourseSummary[];
  attention: DashboardAttentionItem[];
  recentActivity: DashboardActivity[];
}

export interface LearningInsights {
  generatedAt: string;
  summary: {
    weeklyLessonCount: number;
    completionRate: number;
    postClassConfirmationRate: number;
    refineRate: number;
    averageQualityScore: number | null;
  };
  weeklyLessons: Array<{ start: string; end: string; label: string; count: number }>;
  recurringWeakPoints: Array<{ label: string; count: number }>;
  qualityTrend: Array<{ jobId: string; courseId: string; score: number; checkedAt: string }>;
  revisions: {
    coursesWithRevisions: number;
    totalRefinements: number;
  };
}

export type MemoryScope = "student" | "global" | "course";
export type MemoryKind = "learning" | "preference" | "insight" | "requirement" | "note";
export type MemorySource = "manual" | "ai-draft" | "post-class" | "lesson-job" | "system";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  studentId?: string;
  courseId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  source: MemorySource;
  pinned?: boolean;
  active?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ConversationRole = "user" | "assistant" | "system";
export type ConversationStatus = "active" | "completed" | "canceled" | "archived";

export interface ConversationTurn {
  id: string;
  role: ConversationRole;
  content: string;
  state?: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationContext {
  step: string;
  lastUserInstruction?: string;
  lastDraftSummary?: string;
  draftLogPath?: string;
  courseId?: string;
  jobId?: string;
  lastQualityStatus?: string;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  studentId?: string;
  courseId?: string;
  title: string;
  status: ConversationStatus;
  context: ConversationContext;
  turns: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
}
