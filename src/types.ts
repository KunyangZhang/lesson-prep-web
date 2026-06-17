export interface SystemInfo {
  setupRequired: boolean;
  workspaceRoot: string;
  codexAutoRun: boolean;
  codexRunner: "local" | "ssh";
  ragChunkCount: number;
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
    ragMaxReindexFiles: number;
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
  status: "indexed" | "failed" | "unsupported";
  chunkCount: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RagSearchResult {
  score: number;
  chunk: {
    id: string;
    materialId: string;
    path: string;
    title: string;
    index: number;
    text: string;
    tokens: string[];
  };
  excerpt: string;
}
