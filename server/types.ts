export type CourseType = "trial" | "formal";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type JobKind = "lesson" | "pdf-image-refine";
export type CourseStatus = "draft" | "queued" | "running" | "completed" | "failed" | "canceled";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
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
  status: JobStatus;
  logPath: string;
  lastMessagePath: string;
  command: string;
  args: string[];
  runner: "local" | "ssh";
  refineInstruction?: string;
  supplementalFiles?: string[];
  pdfRefinePages?: string;
  artifactBefore?: JobArtifactSnapshot;
  artifactAfter?: JobArtifactSnapshot;
  quality?: GenerationQuality;
  exitCode?: number | null;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface JobArtifactSnapshot {
  workPdfPath?: string;
  workPdfSha256?: string;
  workPdfSize?: number;
  workPdfMtime?: string;
  finalPdfPath?: string;
  finalPdfSha256?: string;
  finalPdfSize?: number;
  finalPdfMtime?: string;
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

export interface RagChunk {
  id: string;
  materialId: string;
  path: string;
  title: string;
  index: number;
  text: string;
  tokens: string[];
}

export interface Db {
  users: User[];
  students: Student[];
  courses: Course[];
  jobs: Job[];
  materials: Material[];
  ragChunks: RagChunk[];
  templates: LessonTemplate[];
}

export interface CourseFile {
  name: string;
  path: string;
  relativePath: string;
  kind: "markdown" | "pdf" | "image" | "text" | "other";
  size: number;
  updatedAt: string;
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
