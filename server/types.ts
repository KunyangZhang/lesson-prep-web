export type CourseType = "trial" | "formal";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
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
  outputDir: string;
  status: CourseStatus;
  jobId?: string;
  feishuSync?: CourseFeishuSync;
  createdAt: string;
  updatedAt: string;
}

export interface CourseFeishuSync {
  folderToken?: string;
  folderUrl?: string;
  calendarEventId?: string;
  calendarId?: string;
  lastJobId?: string;
  lastSyncedAt?: string;
}

export interface Job {
  id: string;
  courseId: string;
  status: JobStatus;
  logPath: string;
  lastMessagePath: string;
  command: string;
  args: string[];
  runner: "local" | "ssh";
  refineInstruction?: string;
  quality?: GenerationQuality;
  exitCode?: number | null;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
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
}

export interface CourseFile {
  name: string;
  path: string;
  relativePath: string;
  kind: "markdown" | "pdf" | "image" | "text" | "other";
  size: number;
  updatedAt: string;
}
