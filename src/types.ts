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
  outputDir: string;
  status: CourseStatus;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  courseId: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  logPath: string;
  lastMessagePath: string;
  command: string;
  runner: "local" | "ssh";
  refineInstruction?: string;
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
