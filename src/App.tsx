import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  BookOpen,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Download,
  ArrowLeft,
  ExternalLink,
  Image,
  FileText,
  Eye,
  FolderUp,
  FolderOpen,
  KeyRound,
  Library,
  Loader2,
  LogOut,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Trash2,
  Upload,
  X,
  UserRound
} from "lucide-react";
import { api } from "./api";
import type {
  Course,
  CourseFile,
  CoursePostClassSummary,
  Diagnostics,
  DiagnosticStatus,
  Job,
  Material,
  RagQuestionRecord,
  RagReindexJob,
  RagSearchResult,
  RagSourceKind,
  Student,
  SystemInfo,
  User
} from "./types";

type View = "students" | "materials";
type CourseDetailTab = "preview" | "workflow" | "postClass" | "activity";

interface AiLessonDraft {
  student: Student;
  course: Course;
}

interface AiDraftAttachmentItem {
  name: string;
  kind: "pdf" | "image" | "text" | "other";
  status: "ok" | "warn" | "error";
  message: string;
  pages?: number;
  size: number;
  savedPath?: string;
  retryable?: boolean;
}

interface AiDraftAttachmentSummary {
  fileCount: number;
  imageCount: number;
  items: AiDraftAttachmentItem[];
}

interface AiDraftContinueState {
  logPath: string;
  message: string;
}

interface AiDraftStudentForm {
  name: string;
  stage: string;
  notes: string;
  weakPoints: string;
  commonMistakes: string;
  parentNotes: string;
  nextLessonSuggestion: string;
}

interface SessionState {
  system: SystemInfo | null;
  user: User | null;
  loading: boolean;
}

const emptyCourseForm = {
  type: "formal",
  stage: "高中数学",
  grade: "",
  score: "",
  province: "",
  textbook: "",
  lessonKind: "专题提升",
  desiredContent: "",
  lessonTime: "",
  durationMinutes: 90,
  localFiles: "",
  notes: "",
  autoRun: true
};

interface AiDraftPersistedState {
  version: 1;
  savedAt: string;
  input: string;
  draft: AiLessonDraft | null;
  studentForm: AiDraftStudentForm;
  courseForm: typeof emptyCourseForm;
  attachmentSummary: AiDraftAttachmentSummary | null;
  uploadMessage: string;
  draftContinue: AiDraftContinueState | null;
  pendingFiles: Array<{ name: string; size: number }>;
  serverRecoveryLogPath?: string;
}

interface AiDraftServerRecovery {
  draft: AiLessonDraft;
  attachments: AiDraftAttachmentSummary;
  logPath: string;
  completedAt: string;
}

const aiDraftStorageVersion = 1;

function aiDraftStorageKey(studentId: string) {
  return `lesson-prep:ai-draft:v${aiDraftStorageVersion}:${studentId}`;
}

function aiDraftIgnoredServerLogKey(studentId: string) {
  return `lesson-prep:ai-draft:ignored-server-log:${studentId}`;
}

function readPersistedAiDraft(studentId: string): AiDraftPersistedState | null {
  try {
    const value = window.localStorage.getItem(aiDraftStorageKey(studentId));
    if (!value) return null;
    const parsed = JSON.parse(value) as AiDraftPersistedState;
    return parsed?.version === aiDraftStorageVersion ? parsed : null;
  } catch {
    return null;
  }
}

function removePersistedAiDraft(studentId: string) {
  try {
    window.localStorage.removeItem(aiDraftStorageKey(studentId));
  } catch {
    // The in-memory draft can still be submitted or cleared when storage is unavailable.
  }
}

function formatAiDraftSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "此前";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const folderPickerProps = { webkitdirectory: "", directory: "" };
const agentWorkFiles = [
  { paths: ["_work/连续学习档案.md"], label: "连续学习" },
  { paths: ["_work/题目提取.md", "_work/题目索引.md"], label: "题目提取" },
  { paths: ["_work/答案核对表.md"], label: "答案核对" },
  { paths: ["_work/课件生成计划.md", "_work/课件页码映射.md", "_work/授课一体版页码映射.md"], label: "课件生成" },
  { paths: ["_work/逐字稿丰富清单.md", "_work/内容丰富清单.md"], label: "逐字稿丰富" }
];

function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const timer = window.setInterval(() => savedCallback.current(), delay);
    return () => window.clearInterval(timer);
  }, [delay]);
}

function sameJsonList<T>(current: T[], next: T[]) {
  if (current.length !== next.length) return false;
  return current.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]));
}

function sameCourseFileList(current: CourseFile[], next: CourseFile[]) {
  if (current.length !== next.length) return false;
  return current.every((file, index) => {
    const nextFile = next[index];
    return (
      file.name === nextFile.name &&
      file.path === nextFile.path &&
      file.relativePath === nextFile.relativePath &&
      file.kind === nextFile.kind &&
      file.size === nextFile.size &&
      file.updatedAt === nextFile.updatedAt
    );
  });
}

function normalizedCourseFilePath(file: CourseFile) {
  return file.relativePath.replace(/\\/g, "/");
}

function isRootCourseFile(file: CourseFile) {
  return !normalizedCourseFilePath(file).includes("/");
}

function isHomeworkAnswerFile(file: CourseFile) {
  return file.kind === "pdf" && file.name.includes("课后作业") && file.name.includes("答案");
}

function isHomeworkFile(file: CourseFile) {
  return file.kind === "pdf" && file.name.includes("课后作业") && !file.name.includes("答案");
}

function courseOutputRank(file: CourseFile) {
  if (file.kind === "pdf" && file.name.includes("授课一体版") && isRootCourseFile(file)) return 0;
  if (file.kind === "pdf" && isRootCourseFile(file) && !isHomeworkFile(file) && !isHomeworkAnswerFile(file)) return 1;
  if (isHomeworkFile(file)) return 2;
  if (isHomeworkAnswerFile(file)) return 3;
  if (file.name === "老师逐字稿.md") return 4;
  if (file.name === "知识点详解.md") return 5;
  if (file.name === "课后反馈.md") return 6;
  return 20;
}

function courseOutputFiles(files: CourseFile[]) {
  const rootFiles = files.filter((file) => isRootCourseFile(file));
  const newest = (candidates: CourseFile[]) =>
    [...candidates].sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))[0];
  const teachingPdf = newest(rootFiles.filter((file) => file.kind === "pdf" && file.name.includes("授课一体版")));
  const studentPdf = newest(
    rootFiles.filter(
      (file) => file.kind === "pdf" && !file.name.includes("授课一体版") && !isHomeworkFile(file) && !isHomeworkAnswerFile(file)
    )
  );
  const homeworkPdf = newest(rootFiles.filter(isHomeworkFile));
  const homeworkAnswerPdf = newest(rootFiles.filter(isHomeworkAnswerFile));
  const markdownFiles = rootFiles.filter((file) => ["老师逐字稿.md", "知识点详解.md", "课后反馈.md"].includes(file.name));

  return [teachingPdf, studentPdf, homeworkPdf, homeworkAnswerPdf, ...markdownFiles]
    .filter((file): file is CourseFile => Boolean(file))
    .sort((a, b) => courseOutputRank(a) - courseOutputRank(b) || a.name.localeCompare(b.name, "zh-CN"));
}

function preferredCourseOutputFile(files: CourseFile[]) {
  return files.find((file) => file.kind === "pdf") || files[0] || null;
}

function courseFileKindLabel(file: CourseFile) {
  if (file.kind === "pdf" && file.name.includes("授课一体版")) return "教师授课一体版";
  if (isHomeworkAnswerFile(file)) return "课后作业参考答案";
  if (isHomeworkFile(file)) return "学生课后作业";
  if (file.kind === "pdf" && isRootCourseFile(file)) return "学生课堂讲义";
  return file.kind;
}

function formatDate(value?: string) {
  if (!value) return "未设置";
  const compact = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function compactText(value = "", maxLength = 90) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function toDatetimeLocalValue(value?: string) {
  if (!value) return "";
  const compact = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (compact) return `${compact[1]}T${compact[2]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function statusLabel(status: Course["status"] | Job["status"]) {
  const map: Record<Course["status"] | Job["status"], string> = {
    draft: "草稿",
    queued: "排队中",
    running: "生成中",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消"
  };
  return map[status];
}

function feishuNotificationLabel(status?: NonNullable<Course["feishuSync"]>["notificationStatus"]) {
  if (status === "sent") return "已发送";
  if (status === "failed") return "发送失败";
  if (status === "skipped") return "已跳过";
  return "未记录";
}

const emptyPostClassSummary: CoursePostClassSummary = {
  status: "draft",
  linkedPrevious: "",
  learned: "",
  mastered: "",
  unresolved: "",
  commonMistakes: "",
  homework: "",
  nextLessonSuggestion: "",
  teacherNotes: ""
};

function courseTimelineValue(course: Course) {
  return Date.parse(course.lessonTime || course.createdAt || course.updatedAt || "") || 0;
}

function sortCoursesByTimelineDesc(courses: Course[]) {
  return [...courses].sort((a, b) => courseTimelineValue(b) - courseTimelineValue(a) || b.createdAt.localeCompare(a.createdAt));
}

function sortCoursesByTimelineAsc(courses: Course[]) {
  return [...courses].sort((a, b) => courseTimelineValue(a) - courseTimelineValue(b) || a.createdAt.localeCompare(b.createdAt));
}

function postClassHasContent(summary?: CoursePostClassSummary) {
  if (!summary) return false;
  return Boolean(
    summary.linkedPrevious ||
      summary.learned ||
      summary.mastered ||
      summary.unresolved ||
      summary.commonMistakes ||
      summary.homework ||
      summary.nextLessonSuggestion ||
      summary.teacherNotes
  );
}

function postClassStateLabel(course: Course) {
  if (course.postClassSummary?.status === "confirmed") return "课后已确认";
  if (postClassHasContent(course.postClassSummary)) return "课后草稿";
  if (course.status === "completed") return "课后待确认";
  return "课后待生成";
}

function buildAiLessonInput(student: Student) {
  return [
    `学生：${student.name}`,
    `年级：${student.stage || ""}`,
    "分数/水平：",
    "课程类型：正式课",
    "课长：90分钟",
    `学生薄弱点：${student.weakPoints || ""}`,
    `常错题型：${student.commonMistakes || ""}`,
    `家长/老师沟通：${student.parentNotes || ""}`,
    `上次课建议：${student.nextLessonSuggestion || ""}`,
    `连续学习记忆：${student.learningMemory || ""}`,
    `长期路线图：${student.learningRoadmap || ""}`,
    "学生原题/错题：",
    "老师判断：",
    "本次备课要求：",
    "资料路径：",
    "其他："
  ].join("\n");
}

function statusClass(status: Course["status"] | Job["status"]) {
  return `status status-${status}`;
}

const latexCommandSource =
  String.raw`\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|lim|sin|cos|tan|log|ln|sim|mu|sigma|alpha|beta|gamma|theta|Delta|cdot|times|approx|leq|geq|neq|infty|pi|binom|overline|underline|hat|bar|vec|overrightarrow|perp|parallel|angle|circ|left|right|begin|end|mathbb|mathcal|mathrm|text)\b`;

function hasLatexCommand(value: string) {
  return new RegExp(latexCommandSource).test(value);
}

function hasMathShape(value: string) {
  return hasLatexCommand(value) || /[A-Za-z]\s*(?:[_^=<>]|\\)/.test(value) || /\\[A-Za-z]+/.test(value);
}

function normalizeMathExpression(expression: string) {
  return expression
    .trim()
    .replace(/\\vec\s+([A-Za-z])/g, "\\vec{$1}")
    .replace(/\\overrightarrow\s+([A-Za-z]{1,3})/g, "\\overrightarrow{$1}")
    .replaceAll("·", "\\cdot ")
    .replace(/\s+/g, " ");
}

function isInsideDollarMath(line: string, index: number) {
  let count = 0;
  for (let i = 0; i < index; i += 1) {
    if (line[i] === "$" && line[i - 1] !== "\\") count += 1;
  }
  return count % 2 === 1;
}

function wrapBareLatexRuns(line: string) {
  const commandPattern = new RegExp(latexCommandSource, "g");
  let output = "";
  let cursor = 0;

  for (let match = commandPattern.exec(line); match; match = commandPattern.exec(line)) {
    const commandStart = match.index;
    if (commandStart < cursor) continue;
    if (isInsideDollarMath(line, commandStart)) continue;

    const before = line.slice(0, commandStart);
    if (/(?:^|\s)[A-Za-z]:\\?$/.test(before) || /[\\/]/.test(line[commandStart - 1] || "")) {
      output += line.slice(cursor, commandStart + match[0].length);
      cursor = commandStart + match[0].length;
      continue;
    }

    let end = commandStart;
    while (end < line.length) {
      const char = line[end];
      if (/[\r\n\u4e00-\u9fff，。；、！？]/.test(char) || char === "$") break;
      end += 1;
    }

    const raw = line.slice(commandStart, end);
    const expression = normalizeMathExpression(raw);
    if (!hasMathShape(expression)) {
      output += line.slice(cursor, end);
      cursor = end;
      commandPattern.lastIndex = end;
      continue;
    }

    output += line.slice(cursor, commandStart);
    output += `$${expression}$`;
    cursor = end;
    commandPattern.lastIndex = end;
  }

  return output + line.slice(cursor);
}

function normalizeLatexText(value: string) {
  const normalized = value
    .replace(/\\\[((?:.|\n|\r)*?)\\\]/g, (_match, expression: string) => `\n\n$$\n${normalizeMathExpression(expression)}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (match, expression: string) => {
      if (expression.includes("\n")) return match;
      return `$${normalizeMathExpression(expression)}$`;
    });

  let insideDisplayMath = false;
  return normalized
    .split("\n")
    .map((line) => {
      if (line.trim() === "$$") {
        insideDisplayMath = !insideDisplayMath;
        return line;
      }
      if (insideDisplayMath) return line;

      const converted = line
        .replace(/^(\s*(?:[-*+]\s+)?)(\(.+\\[A-Za-z].+\))(\s*)$/, (match, prefix: string, expression: string, suffix: string) => {
          const inner = normalizeMathExpression(expression.slice(1, -1));
          if (!hasMathShape(inner)) return match;
          return `${prefix}$${inner}$${suffix}`;
        })
        .replace(/([：:]\s*)(\(.+\\[A-Za-z].+\))(\s*)$/, (match, prefix: string, expression: string, suffix: string) => {
          const inner = normalizeMathExpression(expression.slice(1, -1));
          if (!hasMathShape(inner)) return match;
          return `${prefix}$${inner}$${suffix}`;
        })
        .replace(/([：:]\s*)([A-Za-z][A-Za-z0-9_{}\\^+\-=<>.,\s]*\\[A-Za-z][A-Za-z0-9_{}\\^+\-=<>.,\s]*)$/, (match, prefix: string, expression: string) => {
          const trimmed = normalizeMathExpression(expression);
          if (!hasMathShape(trimmed)) return match;
          return `${prefix}$${trimmed}$`;
        })
        .replace(/\(([^()\n]*\\[A-Za-z][^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g, (match, expression: string) => {
          const trimmed = normalizeMathExpression(expression);
          if (!hasMathShape(trimmed)) return match;
          return `$${trimmed}$`;
        });
      return wrapBareLatexRuns(converted);
    })
    .join("\n");
}

function normalizeMarkdownSegments(value: string, normalizer: (segment: string) => string) {
  const parts = value.split(/(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return parts
    .map((part) => {
      if (!part) return part;
      if (part.startsWith("```") || part.startsWith("`") || part.startsWith("$$") || part.startsWith("$")) return part;
      return normalizer(part);
    })
    .join("");
}

function normalizeMarkdownMath(value: string) {
  return normalizeMarkdownSegments(value, normalizeLatexText);
}

function appendUploadFiles(formData: FormData, files: FileList) {
  Array.from(files).forEach((file) => {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    formData.append("files", file, relativePath || file.name);
  });
}

function appendUploadFileArray(formData: FormData, files: File[]) {
  files.forEach((file) => {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    formData.append("files", file, relativePath || file.name);
  });
}

function appendPathsText(current: string, paths: string[]) {
  const items = new Set(
    current
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  paths.forEach((item) => {
    if (item.trim()) items.add(item.trim());
  });
  return [...items].join("\n");
}

function splitLocalFiles(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function localFileLabel(value: string) {
  return decodeURIComponent(value.split(/[\\/]/).filter(Boolean).pop() || value);
}

export default function App() {
  const [session, setSession] = useState<SessionState>({ system: null, user: null, loading: true });
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>("students");
  const [error, setError] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selectedStudent = students.find((student) => student.id === selectedStudentId) || null;
  const selectedCourse = courses.find((course) => course.id === selectedCourseId) || null;
  const viewerPath =
    typeof window !== "undefined" && window.location.pathname === "/viewer"
      ? new URLSearchParams(window.location.search).get("path") || ""
      : "";
  const materialPreviewId =
    typeof window !== "undefined" && window.location.pathname === "/material-preview"
      ? new URLSearchParams(window.location.search).get("id") || ""
      : "";

  const loadStudents = useCallback(async () => {
    const data = await api.get<{ students: Student[] }>("/api/students");
    setStudents(data.students);
    setSelectedStudentId((current) => {
      if (current && data.students.some((student) => student.id === current)) return current;
      return data.students[0]?.id || "";
    });
  }, []);

  const loadSession = useCallback(async () => {
    const systemPromise = api.get<SystemInfo>("/api/system");
    const mePromise = api.get<{ user: User }>("/api/me").catch(() => null);
    const system = await systemPromise;
    if (system.setupRequired) {
      setSession({ system, user: null, loading: false });
      return;
    }

    const me = await mePromise;
    if (me) {
      setSession({ system, user: me.user, loading: false });
      await loadStudents();
      return;
    }
    setSession({ system, user: null, loading: false });
  }, [loadStudents]);

  useEffect(() => {
    loadSession().catch((err) => {
      setError(err.message);
      setSession((state) => ({ ...state, loading: false }));
    });
  }, [loadSession]);

  const loadCourses = useCallback(async (studentId: string) => {
    if (!studentId) {
      setCourses([]);
      return;
    }
    const data = await api.get<{ courses: Course[] }>(`/api/students/${studentId}/courses`);
    setCourses((current) => (sameJsonList(current, data.courses) ? current : data.courses));
    setSelectedCourseId((current) => {
      if (current && data.courses.some((course) => course.id === current)) return current;
      return data.courses[0]?.id || "";
    });
  }, []);

  useEffect(() => {
    if (session.user && selectedStudentId) {
      loadCourses(selectedStudentId).catch((err) => setError(err.message));
    }
  }, [session.user, selectedStudentId, loadCourses]);

  const runningCourse = courses.some((course) => course.status === "running" || course.status === "queued");
  useInterval(
    () => {
      if (selectedStudentId) loadCourses(selectedStudentId).catch((err) => setError(err.message));
    },
    runningCourse ? 5000 : null
  );

  if (session.loading) {
    return (
      <main className="center-screen">
        <Loader2 className="spin" />
      </main>
    );
  }

  if (!session.user) {
    return (
      <AuthScreen
        setupRequired={Boolean(session.system?.setupRequired)}
        onAuthed={async (user) => {
          setSession((state) => ({ ...state, user, system: state.system ? { ...state.system, setupRequired: false } : null }));
          await loadStudents();
        }}
      />
    );
  }

  if (viewerPath) {
    return <StandaloneViewer path={viewerPath} />;
  }

  if (materialPreviewId) {
    return <StandaloneMaterialPreview materialId={materialPreviewId} />;
  }

  return (
    <main className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={20} />
          </div>
          <div>
            <h1>备课工作台</h1>
            <p>
              {session.system?.workspaceRoot}
              {session.system?.codexRunner === "ssh" ? " · Codex Linux SSH" : " · Codex 本机"}
            </p>
          </div>
          <button
            className="tiny-icon-button sidebar-toggle"
            title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          </button>
        </div>

        {sidebarCollapsed ? null : (
          <>
            <nav className="nav-list">
              <button className={view === "students" ? "active" : ""} onClick={() => setView("students")}>
                <UserRound size={18} />
                学生
              </button>
              <button className={view === "materials" ? "active" : ""} onClick={() => setView("materials")}>
                <Library size={18} />
                资料库
              </button>
            </nav>

            <section className="sidebar-footer">
              <button className="logout-button" onClick={() => setAccountOpen((value) => !value)}>
                <Settings size={17} />
                账号设置
              </button>
              {accountOpen ? (
                <AccountSettings
                  user={session.user}
                  onSaved={(user) => {
                    setSession((state) => ({ ...state, user }));
                    setAccountOpen(false);
                  }}
                  onClose={() => setAccountOpen(false)}
                  onError={setError}
                />
              ) : null}
              <button
                className="logout-button"
                onClick={async () => {
                  await api.post("/api/logout");
                  setSession((state) => ({ ...state, user: null }));
                }}
              >
                <LogOut size={17} />
                退出登录
              </button>
            </section>
          </>
        )}
      </aside>

      <section className="workspace">
        {error ? (
          <div className="error-bar">
            <span>{error}</span>
            <button onClick={() => setError("")}>关闭</button>
          </div>
        ) : null}

        {view === "materials" ? (
          <MaterialsView system={session.system} onError={setError} />
        ) : (
          <StudentWorkspace
            students={students}
            student={selectedStudent}
            selectedStudentId={selectedStudentId}
            courses={courses}
            selectedCourse={selectedCourse}
            onSelectStudent={(id) => {
              setSelectedStudentId(id);
              setView("students");
            }}
            onSelectCourse={setSelectedCourseId}
            onCreateStudent={async (student) => {
              await loadStudents();
              setSelectedStudentId(student.id);
              setView("students");
            }}
            onCreated={async (course) => {
              await loadStudents();
              await loadCourses(course.studentId);
              setSelectedCourseId(course.id);
            }}
            onRefresh={async () => {
              if (selectedStudentId) {
                await Promise.all([loadStudents(), loadCourses(selectedStudentId)]);
              }
            }}
            onStudentSaved={async () => {
              await loadStudents();
              if (selectedStudentId) await loadCourses(selectedStudentId);
            }}
            onDeleteCourse={async (course) => {
              if (!window.confirm(`删除课程「${course.desiredContent || "未命名课程"}」？已生成文件会保留。`)) return;
              await api.del(`/api/courses/${course.id}`);
              await Promise.all([loadStudents(), loadCourses(course.studentId)]);
            }}
            onDeleteStudent={async (student) => {
              if (!window.confirm(`删除学生「${student.name}」？课程记录会从网页移除，但已生成文件会保留。`)) return;
              await api.del(`/api/students/${student.id}`);
              setSelectedCourseId("");
              await loadStudents();
            }}
            onError={setError}
          />
        )}
      </section>
    </main>
  );
}

function StandaloneViewer({ path }: { path: string }) {
  const fileName = decodeURIComponent(path.split(/[\\/]/).pop() || "文件预览");
  const kind = getKindByName(fileName);

  return (
    <main className="viewer-page">
      <header className="viewer-header">
        <div>
          <p className="eyebrow">文件预览</p>
          <h1>{fileName}</h1>
        </div>
        <a className="ghost-link" href="/">
          返回工作台
        </a>
      </header>
      <FilePreview
        file={{
          name: fileName,
          path,
          relativePath: fileName,
          kind,
          size: 0,
          updatedAt: ""
        }}
      />
    </main>
  );
}

function StandaloneMaterialPreview({ materialId }: { materialId: string }) {
  return (
    <main className="viewer-page">
      <header className="viewer-header">
        <div>
          <p className="eyebrow">RAG 预览</p>
          <h1>索引后的题目与片段</h1>
        </div>
        <a className="ghost-link" href="/">
          返回工作台
        </a>
      </header>
      <MaterialRagPreview materialId={materialId} />
    </main>
  );
}

function getKindByName(name: string): CourseFile["kind"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpg|jpeg|gif|webp)$/.test(lower)) return "image";
  if (/\.(txt|log|tex)$/.test(lower)) return "text";
  return "other";
}

function AuthScreen({ setupRequired, onAuthed }: { setupRequired: boolean; onAuthed: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const endpoint = setupRequired ? "/api/setup" : "/api/login";
      const data = await api.post<{ user: User }>(endpoint, { username, password });
      onAuthed(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="auth-title">
          <div className="brand-mark">
            <BookOpen size={22} />
          </div>
          <div>
            <h1>备课工作台</h1>
            <p>{setupRequired ? "初始化管理员" : "登录"}</p>
          </div>
        </div>

        <form onSubmit={submit} className="stack-form">
          <label>
            账号
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="输入账号"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={setupRequired ? "new-password" : "current-password"}
              minLength={8}
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-button" disabled={submitting}>
            {submitting ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
            {setupRequired ? "创建并进入" : "进入工作台"}
          </button>
        </form>
      </section>
    </main>
  );
}

function AccountSettings({
  user,
  onSaved,
  onClose,
  onError
}: {
  user: User;
  onSaved: (user: User) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const data = await api.patch<{ user: User }>("/api/me", {
        username,
        currentPassword,
        newPassword
      });
      setCurrentPassword("");
      setNewPassword("");
      onSaved(data.user);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function downloadBackup() {
    setBackupBusy(true);
    try {
      const response = await fetch("/api/admin/backup", { credentials: "include" });
      if (!response.ok) {
        let message = `备份下载失败：${response.status}`;
        try {
          const data = await response.json();
          if (data.error) message = data.error;
        } catch {
          // Keep the status message if the response is not JSON.
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      link.href = url;
      link.download = match?.[1] || "lesson-prep-backup.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackupBusy(false);
    }
  }

  async function loadDiagnostics() {
    setDiagnosticsBusy(true);
    try {
      const data = await api.get<{ diagnostics: Diagnostics }>("/api/admin/diagnostics");
      setDiagnostics(data.diagnostics);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  return (
    <form className="account-panel" onSubmit={submit}>
      <div className="account-title">
        <span>
          <KeyRound size={16} />
          <strong>登录信息</strong>
        </span>
        <button type="button" className="tiny-icon-button" title="关闭" aria-label="关闭账号设置" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <label>
        账号
        <input value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label>
        当前密码
        <input
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        新密码
        <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          placeholder="不修改就留空"
        />
      </label>
      <button className="primary-button" disabled={saving}>
        {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
        保存
      </button>
      <button type="button" className="ghost-button" disabled={backupBusy} onClick={downloadBackup}>
        {backupBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
        下载数据备份
      </button>
      <button type="button" className="ghost-button" disabled={diagnosticsBusy} onClick={loadDiagnostics}>
        {diagnosticsBusy ? <Loader2 className="spin" size={16} /> : <Stethoscope size={16} />}
        系统诊断
      </button>
      {diagnostics ? <DiagnosticsPanel diagnostics={diagnostics} /> : null}
    </form>
  );
}

function diagnosticLabel(status: DiagnosticStatus) {
  if (status === "ok") return "正常";
  if (status === "warn") return "提醒";
  return "异常";
}

function diagnosticStatusClass(status: DiagnosticStatus) {
  if (status === "ok") return "status status-completed";
  if (status === "warn") return "status status-queued";
  return "status status-failed";
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostics }) {
  return (
    <section className="diagnostics-panel">
      <div className="diagnostics-head">
        <strong>系统诊断</strong>
        <span className={diagnosticStatusClass(diagnostics.status)}>{diagnosticLabel(diagnostics.status)}</span>
      </div>
      <small>{formatDate(diagnostics.checkedAt)}</small>
      <div className="diagnostics-counts">
        <span>学生 {diagnostics.counts.students}</span>
        <span>课程 {diagnostics.counts.courses}</span>
        <span>资料 {diagnostics.counts.indexedMaterials}/{diagnostics.counts.materials}</span>
        <span>RAG 题 {diagnostics.counts.ragQuestions ?? 0}</span>
        <span>任务 {diagnostics.counts.runningJobs}/{diagnostics.counts.jobs}</span>
      </div>
      <div className="diagnostics-list">
        {diagnostics.checks.map((check) => (
          <div key={check.key} className="diagnostics-item">
            <span className={diagnosticStatusClass(check.status)}>{diagnosticLabel(check.status)}</span>
            <div>
              <strong>{check.label}</strong>
              <small>{check.message}</small>
              {check.detail ? <code>{check.detail}</code> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CreateStudentForm({
  onCreated,
  onError
}: {
  onCreated: (student: Student) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [stage, setStage] = useState("高中数学");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const data = await api.post<{ student: Student }>("/api/students", { name, stage });
      setName("");
      onCreated(data.student);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="mini-form" onSubmit={submit}>
      <input placeholder="学生姓名" value={name} onChange={(event) => setName(event.target.value)} />
      <select value={stage} onChange={(event) => setStage(event.target.value)}>
        <option>高中数学</option>
        <option>初中数学</option>
        <option>高等数学</option>
        <option>其他</option>
      </select>
      <button aria-label="创建学生">
        <Plus size={17} />
      </button>
    </form>
  );
}

function StudentWorkspace({
  students,
  student,
  selectedStudentId,
  courses,
  selectedCourse,
  onSelectStudent,
  onSelectCourse,
  onCreateStudent,
  onCreated,
  onRefresh,
  onStudentSaved,
  onDeleteCourse,
  onDeleteStudent,
  onError
}: {
  students: Student[];
  student: Student | null;
  selectedStudentId: string;
  courses: Course[];
  selectedCourse: Course | null;
  onSelectStudent: (id: string) => void;
  onSelectCourse: (id: string) => void;
  onCreateStudent: (student: Student) => void;
  onCreated: (course: Course) => void;
  onRefresh: () => Promise<void> | void;
  onStudentSaved: () => Promise<void> | void;
  onDeleteCourse: (course: Course) => Promise<void>;
  onDeleteStudent: (student: Student) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [showAiDraft, setShowAiDraft] = useState(false);
  const orderedCourses = useMemo(() => sortCoursesByTimelineDesc(courses), [courses]);

  return (
    <div className="student-workspace command-layout">
      <section className="student-roster-panel">
        <div className="source-head">
          <div>
            <p className="eyebrow">学生库</p>
            <h2>学生</h2>
          </div>
          <span>{students.length}</span>
        </div>
        <CreateStudentForm onCreated={onCreateStudent} onError={onError} />
        <div className="student-roster-list">
          {students.map((item) => (
            <div key={item.id} className={item.id === selectedStudentId ? "student-chip active" : "student-chip"}>
              <button className="student-source-main" onClick={() => onSelectStudent(item.id)}>
                <span className="student-avatar">{item.name.slice(0, 1)}</span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.stage || "未设置学段"} · {item.courseCount || 0} 节课</small>
                </span>
              </button>
              <button
                className="icon-button danger-icon"
                title="删除学生"
                aria-label="删除学生"
                onClick={() => onDeleteStudent(item).catch((err) => onError(err.message))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {student ? (
        <>
          <section className="student-command-panel">
            <header className="planner-header command-planner-header">
              <div>
                <p className="eyebrow">备课台</p>
                <h2>{student.name}</h2>
                <span>{student.stage || "未设置学段"}</span>
              </div>
              <div className="header-actions">
                <button className="ghost-button" onClick={() => onRefresh()}>
                  <RefreshCcw size={16} />
                  刷新
                </button>
                <button className="ghost-button" onClick={() => setShowAiDraft((value) => !value)}>
                  <Sparkles size={17} />
                  AI 草稿
                </button>
                <button className="primary-button" onClick={() => setShowForm((value) => !value)}>
                  <Plus size={17} />
                  新建课程
                </button>
              </div>
            </header>

            {showAiDraft || showForm ? (
              <section className="workspace-drawer">
                {showAiDraft ? (
                  <AiLessonDraftPanel
                    key={student.id}
                    initialStudent={student}
                    onCreated={async (course) => {
                      setShowAiDraft(false);
                      onCreated(course);
                    }}
                    onError={onError}
                  />
                ) : null}

                {showForm ? (
                  <CourseForm
                    student={student}
                    onCreated={(course) => {
                      setShowForm(false);
                      onCreated(course);
                    }}
                    onError={onError}
                  />
                ) : null}
              </section>
            ) : null}

            <StudentDossierPanel student={student} courses={orderedCourses} onSelectCourse={onSelectCourse} />

            <details className="profile-disclosure">
              <summary>
                <span>
                  <UserRound size={16} />
                  编辑学生长期档案
                </span>
                <ChevronRight size={16} />
              </summary>
              <StudentProfilePanel student={student} onSaved={onStudentSaved} onError={onError} />
            </details>

            <section className="course-board">
              <div className="section-title">
                <div>
                  <strong>课程队列</strong>
                  <small>{orderedCourses.length} 节课程</small>
                </div>
                <FolderOpen size={18} />
              </div>
              {orderedCourses.length === 0 ? (
                <div className="quiet-empty">暂无课程</div>
              ) : (
                <div className="course-list">
                  {orderedCourses.map((course) => (
                    <div key={course.id} className={course.id === selectedCourse?.id ? "course-item active" : "course-item"}>
                      <button className="course-select" onClick={() => onSelectCourse(course.id)}>
                        <span className={statusClass(course.status)}>{statusLabel(course.status)}</span>
                        <strong>{course.desiredContent || "未命名课程"}</strong>
                        <small>
                          {course.type === "trial" ? "试听课" : "正式课"} · {course.grade || "年级待填"} · {formatDate(course.lessonTime)}
                        </small>
                        <small className="course-continuity-state">{postClassStateLabel(course)}</small>
                      </button>
                      <button
                        className="icon-button danger-icon"
                        title="删除课程"
                        aria-label="删除课程"
                        onClick={() => onDeleteCourse(course).catch((err) => onError(err.message))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </section>

          <section className="course-stage-panel">
            <CourseDetail
              student={student}
              courses={orderedCourses}
              course={selectedCourse}
              onSelectCourse={onSelectCourse}
              onRefresh={onRefresh}
              onDeleteCourse={onDeleteCourse}
              onError={onError}
            />
          </section>
        </>
      ) : (
        <section className="empty-state planner-empty">
          <UserRound size={28} />
          <h2>先创建一个学生</h2>
        </section>
      )}
    </div>
  );
}

function StudentProfilePanel({
  student,
  onSaved,
  onError
}: {
  student: Student;
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    weakPoints: student.weakPoints || "",
    commonMistakes: student.commonMistakes || "",
    parentNotes: student.parentNotes || "",
    nextLessonSuggestion: student.nextLessonSuggestion || "",
    learningMemory: student.learningMemory || "",
    learningRoadmap: student.learningRoadmap || ""
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      weakPoints: student.weakPoints || "",
      commonMistakes: student.commonMistakes || "",
      parentNotes: student.parentNotes || "",
      nextLessonSuggestion: student.nextLessonSuggestion || "",
      learningMemory: student.learningMemory || "",
      learningRoadmap: student.learningRoadmap || ""
    });
  }, [
    student.id,
    student.weakPoints,
    student.commonMistakes,
    student.parentNotes,
    student.nextLessonSuggestion,
    student.learningMemory,
    student.learningRoadmap
  ]);

  function update(name: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.patch<{ student: Student }>(`/api/students/${student.id}`, form);
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="student-profile-panel" onSubmit={submit}>
      <div className="profile-heading">
        <div>
          <strong>学生长期档案</strong>
          <small>会自动写入后续 Codex 备课提示词</small>
        </div>
        <button className="ghost-button" disabled={saving}>
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          保存档案
        </button>
      </div>
      <div className="profile-grid">
        <label>
          薄弱点
          <textarea
            value={form.weakPoints}
            onChange={(event) => update("weakPoints", event.target.value)}
            rows={3}
            placeholder="例如：函数单调性、圆锥曲线计算、立体几何建系"
          />
        </label>
        <label>
          常错题型
          <textarea
            value={form.commonMistakes}
            onChange={(event) => update("commonMistakes", event.target.value)}
            rows={3}
            placeholder="例如：条件概率审题漏条件，导数分类讨论不完整"
          />
        </label>
        <label>
          家长沟通记录
          <textarea
            value={form.parentNotes}
            onChange={(event) => update("parentNotes", event.target.value)}
            rows={3}
            placeholder="记录家长期望、反馈、排课注意事项"
          />
        </label>
        <label>
          下次课建议
          <textarea
            value={form.nextLessonSuggestion}
            onChange={(event) => update("nextLessonSuggestion", event.target.value)}
            rows={3}
            placeholder="例如：先用 15 分钟复盘错题，再进入新专题"
          />
        </label>
        <label>
          连续学习记忆
          <textarea
            value={form.learningMemory}
            onChange={(event) => update("learningMemory", event.target.value)}
            rows={5}
            placeholder="系统会在每节课完成后自动沉淀，也可以手动修正"
          />
        </label>
        <label>
          长期学习路线图
          <textarea
            value={form.learningRoadmap}
            onChange={(event) => update("learningRoadmap", event.target.value)}
            rows={5}
            placeholder="例如：第1阶段补基础，第2阶段专题突破，第3阶段综合卷复盘"
          />
        </label>
      </div>
    </form>
  );
}

function StudentDossierPanel({
  student,
  courses,
  onSelectCourse
}: {
  student: Student;
  courses: Course[];
  onSelectCourse: (id: string) => void;
}) {
  const completedCourses = courses.filter((course) => course.status === "completed");
  const runningCourses = courses.filter((course) => course.status === "running" || course.status === "queued");
  const postClassPendingCourses = completedCourses.filter((course) => course.postClassSummary?.status !== "confirmed");
  const latestConfirmedCourse = sortCoursesByTimelineDesc(completedCourses).find((course) => course.postClassSummary?.status === "confirmed");
  const coveredItems = courses
    .map((course) => course.desiredContent || course.lessonKind || course.grade)
    .filter(Boolean)
    .slice(0, 10);
  const recentRecords = sortCoursesByTimelineDesc(courses).slice(0, 6);

  return (
    <section className="student-dossier-panel">
      <div className="section-title">
        <div>
          <strong>长期学生档案</strong>
          <small>自动汇总上课记录、已学内容和当前状态</small>
        </div>
        <BookOpen size={18} />
      </div>

      <div className="dossier-metrics">
        <div>
          <strong>{courses.length}</strong>
          <span>累计课程</span>
        </div>
        <div>
          <strong>{completedCourses.length}</strong>
          <span>已完成</span>
        </div>
        <div>
          <strong>{runningCourses.length}</strong>
          <span>进行中</span>
        </div>
      </div>

      <div className="dossier-continuity">
        <div>
          <span className="dossier-label">最近确认沉淀</span>
          <strong>{latestConfirmedCourse?.desiredContent || "暂无确认记录"}</strong>
          <small>{latestConfirmedCourse ? formatDate(latestConfirmedCourse.lessonTime || latestConfirmedCourse.createdAt) : "完成课后确认后会作为下一节课上下文"}</small>
        </div>
        <div>
          <span className="dossier-label">待确认课后</span>
          <strong>{postClassPendingCourses.length}</strong>
          <small>{postClassPendingCourses.length > 0 ? "这些课不会自动写入长期档案" : "已完成课程均已沉淀"}</small>
        </div>
      </div>

      {postClassPendingCourses.length > 0 ? (
        <div className="dossier-alert">
          <ClipboardCheck size={16} />
          <span>{postClassPendingCourses.length} 节已完成课程还没有确认课后沉淀，下一节课可能缺少真实课堂反馈。</span>
        </div>
      ) : null}

      <div className="dossier-section">
        <span className="dossier-label">已上/已规划内容</span>
        {coveredItems.length > 0 ? (
          <div className="covered-content-list">
            {coveredItems.map((item, index) => (
              <span key={`${item}-${index}`}>{item}</span>
            ))}
          </div>
        ) : (
          <small className="dossier-empty">创建课程后会自动沉淀内容</small>
        )}
      </div>

      {student.learningMemory ? (
        <div className="dossier-section">
          <span className="dossier-label">连续学习记忆</span>
          <small className="dossier-memory">{student.learningMemory}</small>
        </div>
      ) : null}

      {student.learningRoadmap ? (
        <div className="dossier-section">
          <span className="dossier-label">长期学习路线图</span>
          <small className="dossier-memory">{student.learningRoadmap}</small>
        </div>
      ) : null}

      <div className="dossier-section">
        <span className="dossier-label">上课记录</span>
        {recentRecords.length > 0 ? (
          <div className="lesson-timeline">
            {recentRecords.map((course) => (
              <button
                key={course.id}
                type="button"
                className="lesson-record"
                title={course.desiredContent || "未命名课程"}
                onClick={() => onSelectCourse(course.id)}
              >
                <span className={statusClass(course.status)}>{statusLabel(course.status)}</span>
                <strong>{course.desiredContent || "未命名课程"}</strong>
                <small>
                  {formatDate(course.lessonTime || course.createdAt)} · {course.durationMinutes || 90} 分钟 · {postClassStateLabel(course)}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <small className="dossier-empty">{student.name} 还没有上课记录</small>
        )}
      </div>
    </section>
  );
}

function StructuredLessonFields({
  studentForm,
  courseForm,
  updateStudent,
  updateCourse
}: {
  studentForm: {
    name: string;
    stage: string;
    notes: string;
    weakPoints: string;
    commonMistakes: string;
    parentNotes: string;
    nextLessonSuggestion: string;
  };
  courseForm: {
    type: string;
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
  };
  updateStudent: (name: string, value: string) => void;
  updateCourse: (name: string, value: string | number) => void;
}) {
  return (
    <>
      <div className="form-grid">
        <label>
          学生姓名
          <input value={studentForm.name} onChange={(event) => updateStudent("name", event.target.value)} />
        </label>
        <label>
          学段
          <select value={studentForm.stage} onChange={(event) => {
            updateStudent("stage", event.target.value);
            updateCourse("stage", event.target.value);
          }}>
            <option>高中数学</option>
            <option>初中数学</option>
            <option>高等数学</option>
            <option>其他</option>
          </select>
        </label>
        <label>
          年级
          <input value={courseForm.grade} onChange={(event) => updateCourse("grade", event.target.value)} />
        </label>
        <label>
          分数
          <input value={courseForm.score} onChange={(event) => updateCourse("score", event.target.value)} />
        </label>
        <label>
          课程类型
          <select value={courseForm.type} onChange={(event) => updateCourse("type", event.target.value)}>
            <option value="formal">正式课</option>
            <option value="trial">试听课</option>
          </select>
        </label>
        <label>
          课长
          <input type="number" min={20} max={240} step={5} value={courseForm.durationMinutes} onChange={(event) => updateCourse("durationMinutes", Number(event.target.value))} />
        </label>
        <label>
          上课时间
          <input type="datetime-local" value={courseForm.lessonTime} onChange={(event) => updateCourse("lessonTime", event.target.value)} />
        </label>
        <label>
          地区
          <input value={courseForm.province} onChange={(event) => updateCourse("province", event.target.value)} />
        </label>
        <label>
          教材
          <input value={courseForm.textbook} onChange={(event) => updateCourse("textbook", event.target.value)} />
        </label>
        <label>
          课程性质
          <select value={courseForm.lessonKind} onChange={(event) => updateCourse("lessonKind", event.target.value)}>
            <option>专题提升</option>
            <option>同步巩固</option>
            <option>错题复盘</option>
            <option>培优拓展</option>
            <option>考前冲刺</option>
            <option>作业答疑</option>
          </select>
        </label>
      </div>
      <label>
        想听的内容
        <textarea value={courseForm.desiredContent} onChange={(event) => updateCourse("desiredContent", event.target.value)} rows={2} required />
      </label>
      <label>
        本地题目/资料路径
        <textarea value={courseForm.localFiles} onChange={(event) => updateCourse("localFiles", event.target.value)} rows={2} />
      </label>
      <label>
        学生长期备注
        <textarea value={studentForm.notes} onChange={(event) => updateStudent("notes", event.target.value)} rows={2} />
      </label>
      <label>
        学生薄弱点
        <textarea value={studentForm.weakPoints} onChange={(event) => updateStudent("weakPoints", event.target.value)} rows={2} />
      </label>
      <label>
        常错题型/方法
        <textarea value={studentForm.commonMistakes} onChange={(event) => updateStudent("commonMistakes", event.target.value)} rows={2} />
      </label>
      <label>
        家长沟通记录
        <textarea value={studentForm.parentNotes} onChange={(event) => updateStudent("parentNotes", event.target.value)} rows={2} />
      </label>
      <label>
        下次课建议
        <textarea value={studentForm.nextLessonSuggestion} onChange={(event) => updateStudent("nextLessonSuggestion", event.target.value)} rows={2} />
      </label>
    </>
  );
}

function AiLessonDraftPanel({
  initialStudent,
  onCreated,
  onError
}: {
  initialStudent: Student;
  onCreated: (course: Course) => void;
  onError: (message: string) => void;
}) {
  const initialInput = buildAiLessonInput(initialStudent);
  const initialStudentForm: AiDraftStudentForm = {
    name: initialStudent.name,
    stage: initialStudent.stage || "高中数学",
    notes: initialStudent.notes || "",
    weakPoints: initialStudent.weakPoints || "",
    commonMistakes: initialStudent.commonMistakes || "",
    parentNotes: initialStudent.parentNotes || "",
    nextLessonSuggestion: initialStudent.nextLessonSuggestion || ""
  };
  const initialCourseForm = { ...emptyCourseForm, autoRun: false, stage: initialStudent.stage || emptyCourseForm.stage };
  const recoveredDraft = useMemo(() => readPersistedAiDraft(initialStudent.id), [initialStudent.id]);
  const [input, setInput] = useState(() => recoveredDraft?.input ?? initialInput);
  const [draft, setDraft] = useState<AiLessonDraft | null>(() => recoveredDraft?.draft ?? null);
  const [studentForm, setStudentForm] = useState<AiDraftStudentForm>(() => recoveredDraft?.studentForm ?? initialStudentForm);
  const [courseForm, setCourseForm] = useState(() => ({ ...initialCourseForm, ...recoveredDraft?.courseForm, autoRun: false }));
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [unrestoredFiles, setUnrestoredFiles] = useState(() => recoveredDraft?.pendingFiles ?? []);
  const [attachmentSummary, setAttachmentSummary] = useState<AiDraftAttachmentSummary | null>(() => recoveredDraft?.attachmentSummary ?? null);
  const [uploadMessage, setUploadMessage] = useState(() => recoveredDraft?.uploadMessage ?? "");
  const [draftContinue, setDraftContinue] = useState<AiDraftContinueState | null>(() => recoveredDraft?.draftContinue ?? null);
  const [serverRecoveryLogPath, setServerRecoveryLogPath] = useState(recoveredDraft?.serverRecoveryLogPath ?? "");
  const [draftDirty, setDraftDirty] = useState(Boolean(recoveredDraft));
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState(recoveredDraft?.savedAt ?? "");
  const [recoveryMessage, setRecoveryMessage] = useState(() => {
    if (!recoveredDraft) return "";
    const pendingMessage = recoveredDraft.pendingFiles.length > 0
      ? `；上次选择的 ${recoveredDraft.pendingFiles.length} 个本地文件需重新选择`
      : "";
    return `已恢复 ${formatAiDraftSavedAt(recoveredDraft.savedAt)} 自动保存的草稿${pendingMessage}。`;
  });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retryingOcrPath, setRetryingOcrPath] = useState("");
  const draftFileInputRef = useRef<HTMLInputElement | null>(null);
  const draftImageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!draftDirty || generating || saving) return undefined;
    const savedAt = new Date().toISOString();
    const pendingFiles = [
      ...unrestoredFiles,
      ...draftFiles.map((file) => ({ name: file.name, size: file.size }))
    ];
    const persisted: AiDraftPersistedState = {
      version: aiDraftStorageVersion,
      savedAt,
      input,
      draft,
      studentForm,
      courseForm,
      attachmentSummary,
      uploadMessage,
      draftContinue,
      pendingFiles,
      serverRecoveryLogPath
    };
    try {
      window.localStorage.setItem(aiDraftStorageKey(initialStudent.id), JSON.stringify(persisted));
      setLastAutoSavedAt(savedAt);
    } catch {
      setRecoveryMessage("浏览器未能保存草稿，请暂时不要关闭此页面。");
    }
    return undefined;
  }, [attachmentSummary, courseForm, draft, draftContinue, draftDirty, draftFiles, generating, initialStudent.id, input, saving, serverRecoveryLogPath, studentForm, unrestoredFiles, uploadMessage]);

  function updateStudent(name: string, value: string) {
    setDraftDirty(true);
    setStudentForm((current) => ({ ...current, [name]: value }));
  }

  function updateCourse(name: string, value: string | number) {
    setDraftDirty(true);
    setCourseForm((current) => ({ ...current, [name]: value }));
  }

  function addDraftFiles(files: FileList | null) {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) {
      setUploadMessage("没有读取到选择的文件，请重新选择。");
      return;
    }
    setDraftDirty(true);
    setUnrestoredFiles([]);
    setRecoveryMessage("");
    setDraftFiles((current) => [...current, ...selectedFiles]);
    setAttachmentSummary(null);
    setUploadMessage(`已选择 ${selectedFiles.length} 个文件，生成草稿时会一起上传。`);
    setDraftContinue(null);
  }

  function applyDraftData(data: { draft: AiLessonDraft; attachments?: AiDraftAttachmentSummary }) {
    setDraftDirty(true);
    if (data.attachments) setAttachmentSummary(data.attachments);
    setUploadMessage(
      data.attachments && data.attachments.fileCount > 0
        ? `上传成功：${data.attachments.fileCount} 个文件已保存到学生目录，结构化草稿会保留真实文件路径。`
        : "结构化草稿已生成。"
    );
    setDraft(data.draft);
    setStudentForm({
      name: data.draft.student.name || initialStudent.name,
      stage: data.draft.student.stage || initialStudent.stage || "高中数学",
      notes: data.draft.student.notes || initialStudent.notes || "",
      weakPoints: data.draft.student.weakPoints || initialStudent.weakPoints || "",
      commonMistakes: data.draft.student.commonMistakes || initialStudent.commonMistakes || "",
      parentNotes: data.draft.student.parentNotes || initialStudent.parentNotes || "",
      nextLessonSuggestion: data.draft.student.nextLessonSuggestion || initialStudent.nextLessonSuggestion || ""
    });
    setCourseForm({
      type: data.draft.course.type,
      stage: data.draft.course.stage || initialStudent.stage || "高中数学",
      grade: data.draft.course.grade || "",
      score: data.draft.course.score || "",
      province: data.draft.course.province || "",
      textbook: data.draft.course.textbook || "",
      lessonKind: data.draft.course.lessonKind || "专题提升",
      desiredContent: data.draft.course.desiredContent || "",
      lessonTime: toDatetimeLocalValue(data.draft.course.lessonTime),
      durationMinutes: data.draft.course.durationMinutes || 90,
      localFiles: data.draft.course.localFiles || "",
      notes: data.draft.course.notes || input,
      autoRun: false
    });
    setDraftContinue(null);
  }

  useEffect(() => {
    if (recoveredDraft?.draft) return undefined;
    let canceled = false;
    api
      .get<{ recovery: AiDraftServerRecovery | null }>(`/api/ai-drafts/lesson/recovery?studentId=${encodeURIComponent(initialStudent.id)}`)
      .then(({ recovery }) => {
        if (canceled || !recovery) return;
        let ignoredLogPath = "";
        try {
          ignoredLogPath = window.localStorage.getItem(aiDraftIgnoredServerLogKey(initialStudent.id)) || "";
        } catch {
          ignoredLogPath = "";
        }
        if (ignoredLogPath === recovery.logPath) return;
        const recoveredFileNames = new Set(recovery.attachments.items.map((item) => item.name));
        const matchesPendingUpload = Boolean(
          recoveredDraft?.pendingFiles.length &&
          recoveredDraft.pendingFiles.every((file) => recoveredFileNames.has(file.name))
        );
        if (
          recoveredDraft?.savedAt &&
          Date.parse(recovery.completedAt) <= Date.parse(recoveredDraft.savedAt) &&
          !matchesPendingUpload
        ) return;
        applyDraftData(recovery);
        setDraftFiles([]);
        setUnrestoredFiles([]);
        setServerRecoveryLogPath(recovery.logPath);
        setRecoveryMessage(`已自动恢复服务端 ${formatAiDraftSavedAt(recovery.completedAt)} 完成的 AI 草稿，无需重新上传 PDF。`);
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [initialStudent.id, recoveredDraft]);

  async function generateDraft(event: React.FormEvent) {
    event.preventDefault();
    setDraftDirty(true);
    setGenerating(true);
    setAttachmentSummary(null);
    setUploadMessage(draftFiles.length > 0 ? `正在上传并分析 ${draftFiles.length} 个文件...` : "");
    try {
      const formData = new FormData();
      formData.append("input", input);
      formData.append("studentId", initialStudent.id);
      draftFiles.forEach((file) => formData.append("files", file, file.name));
      const data = await api.post<{ draft: AiLessonDraft; attachments: AiDraftAttachmentSummary }>("/api/ai-drafts/lesson", formData);
      applyDraftData(data);
    } catch (err) {
      const data = (err as Error & { data?: { draftContinue?: { logPath?: string } } }).data;
      const logPath = data?.draftContinue?.logPath || "";
      if (logPath) {
        setDraftContinue({ logPath, message: err instanceof Error ? err.message : String(err) });
        setUploadMessage("Codex 草稿中断，可以点击继续生成草稿。");
      } else {
        setUploadMessage(draftFiles.length > 0 ? "上传或分析失败，请查看错误提示后重试。" : "");
      }
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function continueDraft() {
    if (!draftContinue) return;
    setGenerating(true);
    setUploadMessage("正在从上次日志继续生成草稿...");
    try {
      const data = await api.post<{ draft: AiLessonDraft; attachments: AiDraftAttachmentSummary }>("/api/ai-drafts/lesson/continue", {
        logPath: draftContinue.logPath
      });
      applyDraftData(data);
    } catch (err) {
      const data = (err as Error & { data?: { draftContinue?: { logPath?: string } } }).data;
      const logPath = data?.draftContinue?.logPath || draftContinue.logPath;
      setDraftContinue({ logPath, message: err instanceof Error ? err.message : String(err) });
      setUploadMessage("继续生成仍然中断，可以稍后再次点击继续。");
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function retryAttachmentOcr(item: AiDraftAttachmentItem) {
    if (!item.savedPath || retryingOcrPath) return;
    setRetryingOcrPath(item.savedPath);
    setAttachmentSummary((current) => current ? {
      ...current,
      items: current.items.map((candidate) => candidate.savedPath === item.savedPath
        ? { ...candidate, message: "正在重新提交 PaddleOCR..." }
        : candidate)
    } : current);
    try {
      const data = await api.post<{ item: AiDraftAttachmentItem }>("/api/ai-drafts/lesson/attachments/ocr-retry", {
        studentId: initialStudent.id,
        savedPath: item.savedPath
      });
      setAttachmentSummary((current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.savedPath === item.savedPath ? data.item : candidate)
      } : current);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAttachmentSummary((current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.savedPath === item.savedPath
          ? { ...candidate, status: "warn", message: `OCR 重试失败：${message}`, retryable: true }
          : candidate)
      } : current);
      onError(message);
    } finally {
      setRetryingOcrPath("");
    }
  }

  async function saveDraft() {
    setSaving(true);
    try {
      const data = await api.post<{ student: Student; course: Course; job: Job }>("/api/ai-drafts/lesson/commit", {
        studentId: initialStudent.id,
        student: studentForm,
        course: courseForm
      });
      removePersistedAiDraft(initialStudent.id);
      if (serverRecoveryLogPath) {
        try {
          window.localStorage.setItem(aiDraftIgnoredServerLogKey(initialStudent.id), serverRecoveryLogPath);
        } catch {
          // The committed course is already stored on the server.
        }
      }
      onCreated(data.course);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function clearDraft() {
    if (!window.confirm("确定清空这个学生的 AI 草稿吗？清空后无法自动恢复。")) return;
    removePersistedAiDraft(initialStudent.id);
    if (serverRecoveryLogPath) {
      try {
        window.localStorage.setItem(aiDraftIgnoredServerLogKey(initialStudent.id), serverRecoveryLogPath);
      } catch {
        // Clearing the visible draft still works when storage is unavailable.
      }
    }
    setInput(initialInput);
    setDraft(null);
    setStudentForm(initialStudentForm);
    setCourseForm(initialCourseForm);
    setDraftFiles([]);
    setUnrestoredFiles([]);
    setAttachmentSummary(null);
    setUploadMessage("");
    setDraftContinue(null);
    setServerRecoveryLogPath("");
    setLastAutoSavedAt("");
    setRecoveryMessage("草稿已清空。");
    setDraftDirty(false);
  }

  return (
    <section className="ai-draft-panel">
      <form className="ai-draft-input" onSubmit={generateDraft}>
        <div className="form-heading">
          <span>
            <Sparkles size={17} />
            <strong>AI 备课草稿</strong>
          </span>
          <div className="ai-draft-heading-tools">
            <small>{lastAutoSavedAt ? `已自动保存 ${formatAiDraftSavedAt(lastAutoSavedAt)}` : "只整理学生和课程字段，调用备课 Agent 时再检索资料"}</small>
            {draftDirty ? (
              <button type="button" className="ghost-button" onClick={clearDraft}>
                <Trash2 size={14} />
                清空草稿
              </button>
            ) : null}
          </div>
        </div>
        {recoveryMessage ? (
          <div className="draft-recovery-status">
            <RefreshCcw size={14} />
            <span>{recoveryMessage}</span>
          </div>
        ) : null}
        <label>
          非结构化备课内容
          <textarea value={input} onChange={(event) => { setDraftDirty(true); setInput(event.target.value); }} rows={10} />
        </label>
        <section className="resource-picker ai-draft-files">
          <div className="resource-actions">
            <button type="button" className="ghost-button" onClick={() => draftFileInputRef.current?.click()}>
              <Upload size={16} />
              上传 PDF/文件
            </button>
            <input
              ref={draftFileInputRef}
              className="hidden-file-input"
              type="file"
              accept=".pdf,.txt,.md,.markdown,.tex,.csv,application/pdf,text/*"
              multiple
              onChange={(event) => {
                addDraftFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button type="button" className="ghost-button" onClick={() => draftImageInputRef.current?.click()}>
              <Image size={16} />
              上传图片
            </button>
            <input
              ref={draftImageInputRef}
              className="hidden-file-input"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                addDraftFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <span>{draftFiles.length > 0 ? `${draftFiles.length} 个文件将随草稿分析` : "支持 PDF 文本和题目截图"}</span>
          </div>
          {draftFiles.length > 0 ? (
            <div className="draft-file-list">
              {draftFiles.map((file, index) => (
                <span key={`${file.name}-${file.lastModified}-${index}`}>
                  {file.name}
                  <button
                    type="button"
                    aria-label={`移除 ${file.name}`}
                    onClick={() => {
                      setDraftDirty(true);
                      setDraftFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
                      setAttachmentSummary(null);
                      setUploadMessage("");
                    }}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {uploadMessage ? <div className="upload-status">{generating ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}{uploadMessage}</div> : null}
          {attachmentSummary?.items.length ? (
            <div className="attachment-status-list">
              {attachmentSummary.items.map((item, index) => (
                <div className={`attachment-status ${item.status}`} key={`${item.name}-${index}`}>
                  <div className="attachment-status-heading">
                    <strong>{item.name}</strong>
                    {item.savedPath && (item.retryable || (item.kind === "pdf" && item.status !== "ok" && item.message.includes("OCR"))) ? (
                      <button
                        type="button"
                        className="ghost-button attachment-retry-button"
                        disabled={Boolean(retryingOcrPath)}
                        onClick={() => retryAttachmentOcr(item)}
                      >
                        {retryingOcrPath === item.savedPath ? <Loader2 className="spin" size={14} /> : <RefreshCcw size={14} />}
                        {retryingOcrPath === item.savedPath ? "重试中" : "重试 OCR"}
                      </button>
                    ) : null}
                  </div>
                  <span>{item.message}</span>
                  {item.savedPath ? <small>{item.savedPath}</small> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
        <button className="primary-button" disabled={generating || (!input.trim() && draftFiles.length === 0)}>
          {generating ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          生成结构化草稿
        </button>
        {draftContinue ? (
          <div className="draft-continue-box">
            <span>{draftContinue.message}</span>
            <small>{draftContinue.logPath}</small>
            <button type="button" className="ghost-button" disabled={generating} onClick={() => continueDraft()}>
              {generating ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
              继续生成草稿
            </button>
          </div>
        ) : null}
      </form>

      <div className="ai-draft-review">
        <div className="form-heading">
          <span>
            <FileText size={17} />
            <strong>草稿预览</strong>
          </span>
          {draft ? <small>检查字段后确认，系统会立即调用 Codex</small> : <small>生成后会显示在这里</small>}
        </div>
        {draft ? (
          <>
            <StructuredLessonFields studentForm={studentForm} courseForm={courseForm} updateStudent={updateStudent} updateCourse={updateCourse} />
            <div className="form-footer">
              <button type="button" className="primary-button" disabled={saving || !courseForm.desiredContent.trim() || !studentForm.name.trim()} onClick={() => saveDraft()}>
                {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
                确认并调用 Codex
              </button>
            </div>
          </>
        ) : (
          <div className="quiet-empty">粘贴需求后生成草稿</div>
        )}
      </div>
    </section>
  );
}

function CourseForm({
  student,
  onCreated,
  onError
}: {
  student: Student;
  onCreated: (course: Course) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({ ...emptyCourseForm, stage: student.stage || emptyCourseForm.stage });
  const [submitting, setSubmitting] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialResults, setMaterialResults] = useState<RagSearchResult[]>([]);
  const [searchingMaterials, setSearchingMaterials] = useState(false);
  const continuitySuggestion = student.nextLessonSuggestion?.trim() || "";

  function update(name: string, value: string | number | boolean) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function addPendingFiles(files: FileList | null) {
    if (!files?.length) return;
    setPendingFiles((current) => [...current, ...Array.from(files)]);
  }

  function addMaterialPath(pathValue: string) {
    setForm((current) => ({ ...current, localFiles: appendPathsText(current.localFiles, [pathValue]) }));
  }

  async function searchMaterials() {
    if (!materialQuery.trim()) {
      setMaterialResults([]);
      return;
    }
    setSearchingMaterials(true);
    try {
      const data = await api.get<{ results: RagSearchResult[] }>(`/api/materials/search?q=${encodeURIComponent(materialQuery)}`);
      setMaterialResults(data.results);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchingMaterials(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const shouldRunAfterUpload = form.autoRun && pendingFiles.length > 0;
      const createPayload = shouldRunAfterUpload ? { ...form, autoRun: false } : form;
      const data = await api.post<{ course: Course }>(`/api/students/${student.id}/courses`, createPayload);
      let course = data.course;
      if (pendingFiles.length > 0) {
        const formData = new FormData();
        pendingFiles.forEach((file) => formData.append("files", file, file.name));
        const uploadData = await api.post<{ course: Course }>(`/api/courses/${course.id}/attachments`, formData);
        course = uploadData.course;
      }
      if (shouldRunAfterUpload) {
        const runData = await api.post<{ course: Course; job: Job }>(`/api/courses/${course.id}/run`);
        course = runData.course;
      }
      onCreated(course);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="course-form" onSubmit={submit}>
      <div className="segmented">
        <button type="button" className={form.type === "formal" ? "active" : ""} onClick={() => update("type", "formal")}>
          正式课
        </button>
        <button type="button" className={form.type === "trial" ? "active" : ""} onClick={() => update("type", "trial")}>
          试听课
        </button>
      </div>

      <div className="form-grid">
        <label>
          学段
          <select value={form.stage} onChange={(event) => update("stage", event.target.value)}>
            <option>高中数学</option>
            <option>初中数学</option>
            <option>高等数学</option>
            <option>其他</option>
          </select>
        </label>
        <label>
          年级
          <input value={form.grade} onChange={(event) => update("grade", event.target.value)} placeholder="高二 / 初三" />
        </label>
        <label>
          分数
          <input value={form.score} onChange={(event) => update("score", event.target.value)} placeholder="最近考试分数或水平" />
        </label>
        <label>
          上课时间
          <input type="datetime-local" value={form.lessonTime} onChange={(event) => update("lessonTime", event.target.value)} />
        </label>
        <label>
          课长
          <input
            type="number"
            min={20}
            max={240}
            step={5}
            value={form.durationMinutes}
            onChange={(event) => update("durationMinutes", Number(event.target.value))}
          />
        </label>
        <label>
          地区
          <input value={form.province} onChange={(event) => update("province", event.target.value)} placeholder="新高考 I / 广东" />
        </label>
        <label>
          教材版本
          <input value={form.textbook} onChange={(event) => update("textbook", event.target.value)} placeholder="人教A版" />
        </label>
        <label>
          课程性质
          <select value={form.lessonKind} onChange={(event) => update("lessonKind", event.target.value)}>
            <option>专题提升</option>
            <option>同步巩固</option>
            <option>错题复盘</option>
            <option>培优拓展</option>
            <option>考前冲刺</option>
            <option>作业答疑</option>
          </select>
        </label>
      </div>

      {continuitySuggestion ? (
        <div className="continuity-seed">
          <div>
            <strong>上次课给出的下节课建议</strong>
            <small>{continuitySuggestion}</small>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => update("desiredContent", form.desiredContent.trim() ? `${form.desiredContent.trim()}\n${continuitySuggestion}` : continuitySuggestion)}
          >
            <ChevronRight size={16} />
            填入本课主题
          </button>
        </div>
      ) : null}

      <label>
        想听的内容
        <textarea
          value={form.desiredContent}
          onChange={(event) => update("desiredContent", event.target.value)}
          placeholder="例如：高二概率，条件概率与连续抽球，希望有大招和真题变式"
          rows={3}
          required
        />
      </label>
      <label>
        本地题目/资料路径
        <textarea
          value={form.localFiles}
          onChange={(event) => update("localFiles", event.target.value)}
          placeholder="可粘贴 PDF、docx、图片或文件夹路径，一行一个"
          rows={2}
        />
      </label>
      <section className="resource-picker">
        <div className="resource-actions">
          <label className="ghost-button file-button">
            <Upload size={16} />
            上传本地文件
            <input
              type="file"
              multiple
              onChange={(event) => {
                addPendingFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <label className="ghost-button file-button">
            <Image size={16} />
            上传图片
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                addPendingFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <span>{pendingFiles.length > 0 ? `${pendingFiles.length} 个文件待上传` : "文件会在创建课程后保存到课程目录"}</span>
        </div>
        <div className="material-select-row">
          <Search size={16} />
          <input
            value={materialQuery}
            onChange={(event) => setMaterialQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                searchMaterials();
              }
            }}
            placeholder="搜索资料库后手动加入课程"
          />
          <button type="button" className="ghost-button" onClick={searchMaterials} disabled={searchingMaterials}>
            {searchingMaterials ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
            搜索
          </button>
        </div>
        {materialResults.length > 0 ? (
          <div className="material-pick-list">
            {materialResults.slice(0, 6).map((result) => (
              <button type="button" key={result.material.path} onClick={() => addMaterialPath(result.material.path)}>
                <strong>{result.material.title}</strong>
                <small>{result.reason}</small>
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <label>
        备注
        <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} rows={2} />
      </label>

      <div className="form-footer">
        <label className="check-row">
          <input type="checkbox" checked={form.autoRun} onChange={(event) => update("autoRun", event.target.checked)} />
          创建后自动调用 Codex
        </label>
        <button className="primary-button" disabled={submitting}>
          {submitting ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
          创建课程
        </button>
      </div>
    </form>
  );
}

function courseToEditableForm(course: Course) {
  return {
    type: course.type,
    stage: course.stage || emptyCourseForm.stage,
    grade: course.grade || "",
    score: course.score || "",
    province: course.province || "",
    textbook: course.textbook || "",
    lessonKind: course.lessonKind || emptyCourseForm.lessonKind,
    desiredContent: course.desiredContent || "",
    lessonTime: toDatetimeLocalValue(course.lessonTime),
    durationMinutes: course.durationMinutes || emptyCourseForm.durationMinutes,
    localFiles: course.localFiles || "",
    notes: course.notes || ""
  };
}

function CourseSettingsPanel({
  student,
  course,
  onSaved,
  onCancel,
  onError
}: {
  student: Student;
  course: Course;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(() => courseToEditableForm(course));
  const [studentForm, setStudentForm] = useState({
    name: student.name,
    stage: student.stage || course.stage || "高中数学",
    notes: student.notes || "",
    weakPoints: student.weakPoints || "",
    commonMistakes: student.commonMistakes || "",
    parentNotes: student.parentNotes || "",
    nextLessonSuggestion: student.nextLessonSuggestion || ""
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(courseToEditableForm(course));
    setStudentForm({
      name: student.name,
      stage: student.stage || course.stage || "高中数学",
      notes: student.notes || "",
      weakPoints: student.weakPoints || "",
      commonMistakes: student.commonMistakes || "",
      parentNotes: student.parentNotes || "",
      nextLessonSuggestion: student.nextLessonSuggestion || ""
    });
  }, [course.id, student.id, student.name, student.stage, student.notes, student.weakPoints, student.commonMistakes, student.parentNotes, student.nextLessonSuggestion]);

  function update(name: string, value: string | number) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function updateStudent(name: string, value: string) {
    setStudentForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.patch<{ student: Student }>(`/api/students/${student.id}`, studentForm);
      await api.patch<{ course: Course }>(`/api/courses/${course.id}`, form);
      await onSaved();
      onCancel();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="course-form course-settings-panel" onSubmit={submit}>
      <div className="form-heading">
        <div>
          <strong>课程设置</strong>
          <small>修改后再次调用备课 Agent 会使用这里的新信息</small>
        </div>
        <button type="button" className="tiny-icon-button" title="关闭" aria-label="关闭课程设置" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

      <StructuredLessonFields studentForm={studentForm} courseForm={form} updateStudent={updateStudent} updateCourse={update} />

      <div className="form-footer">
        <button type="button" className="ghost-button" onClick={onCancel}>
          取消
        </button>
        <button className="primary-button" disabled={saving}>
          {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
          保存设置
        </button>
      </div>
    </form>
  );
}

function PostClassSummaryPanel({
  course,
  onSaved,
  onError
}: {
  course: Course;
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<CoursePostClassSummary>(() => ({
    ...emptyPostClassSummary,
    ...(course.postClassSummary || {})
  }));
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setForm({ ...emptyPostClassSummary, ...(course.postClassSummary || {}) });
  }, [course.id, course.postClassSummary]);

  function update(name: keyof CoursePostClassSummary, value: string) {
    setForm((current) => ({
      ...current,
      [name]: value,
      status: current.status === "confirmed" ? "draft" : current.status
    }));
  }

  async function saveDraft() {
    setSaving(true);
    try {
      const data = await api.patch<{ summary: CoursePostClassSummary; course: Course }>(`/api/courses/${course.id}/post-class`, {
        summary: { ...form, status: "draft" }
      });
      setForm({ ...emptyPostClassSummary, ...data.summary });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function extractDraft() {
    if (postClassHasContent(form) && !window.confirm("从产物重新提取会覆盖当前课后沉淀草稿，是否继续？")) return;
    setDrafting(true);
    try {
      const data = await api.post<{ summary: CoursePostClassSummary; course: Course }>(`/api/courses/${course.id}/post-class/draft`);
      setForm({ ...emptyPostClassSummary, ...data.summary });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrafting(false);
    }
  }

  async function confirmSummary() {
    setConfirming(true);
    try {
      const data = await api.post<{ summary: CoursePostClassSummary; course: Course; student: Student }>(
        `/api/courses/${course.id}/post-class/confirm`,
        { summary: form }
      );
      setForm({ ...emptyPostClassSummary, ...data.summary });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  const confirmed = form.status === "confirmed";
  const locked = course.status === "running" || course.status === "queued";
  const hasContent = postClassHasContent(form);

  return (
    <section className="tool-group post-class-panel">
      <div className="panel-title">
        <ClipboardCheck size={18} />
        <h4>课后结构化沉淀</h4>
      </div>
      <small className="quiet-copy">
        先保存草稿，课后按真实课堂表现修正；点击确认后才会更新学生长期档案。
      </small>
      <div className="post-class-status">
        <span className={confirmed ? "status status-completed" : "status status-draft"}>{confirmed ? "已确认" : "草稿"}</span>
        {form.updatedAt ? <small>更新于 {formatDate(form.updatedAt)}</small> : null}
        {form.confirmedAt ? <small>确认于 {formatDate(form.confirmedAt)}</small> : null}
      </div>
      {locked ? <div className="quiet-copy">课程正在生成中，完成后再提取或确认课后沉淀。</div> : null}
      <label>
        与上节课的衔接
        <textarea disabled={locked} value={form.linkedPrevious || ""} onChange={(event) => update("linkedPrevious", event.target.value)} rows={2} />
      </label>
      <label>
        本节课新增内容
        <textarea disabled={locked} value={form.learned || ""} onChange={(event) => update("learned", event.target.value)} rows={3} />
      </label>
      <label>
        已掌握/课堂亮点
        <textarea disabled={locked} value={form.mastered || ""} onChange={(event) => update("mastered", event.target.value)} rows={3} />
      </label>
      <label>
        待回收薄弱点
        <textarea disabled={locked} value={form.unresolved || ""} onChange={(event) => update("unresolved", event.target.value)} rows={3} />
      </label>
      <label>
        常错题型/方法问题
        <textarea disabled={locked} value={form.commonMistakes || ""} onChange={(event) => update("commonMistakes", event.target.value)} rows={3} />
      </label>
      <label>
        课后作业
        <textarea disabled={locked} value={form.homework || ""} onChange={(event) => update("homework", event.target.value)} rows={2} />
      </label>
      <label>
        下节课建议
        <textarea disabled={locked} value={form.nextLessonSuggestion || ""} onChange={(event) => update("nextLessonSuggestion", event.target.value)} rows={3} />
      </label>
      <label>
        老师补充
        <textarea disabled={locked} value={form.teacherNotes || ""} onChange={(event) => update("teacherNotes", event.target.value)} rows={2} />
      </label>
      <div className="button-row">
        <button type="button" className="ghost-button" disabled={locked || drafting} onClick={extractDraft}>
          {drafting ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
          从产物提取草稿
        </button>
        <button type="button" className="ghost-button" disabled={locked || saving} onClick={saveDraft}>
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          保存草稿
        </button>
        <button type="button" className="primary-button" disabled={locked || confirming || !hasContent} onClick={confirmSummary}>
          {confirming ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
          {confirmed ? "重新确认并更新档案" : "确认并更新档案"}
        </button>
      </div>
    </section>
  );
}

function CourseContinuityBar({
  student,
  course,
  courses,
  onSelectCourse
}: {
  student: Student;
  course: Course;
  courses: Course[];
  onSelectCourse: (id: string) => void;
}) {
  const timeline = sortCoursesByTimelineAsc(courses);
  const currentIndex = timeline.findIndex((item) => item.id === course.id);
  const previousCourse = currentIndex > 0 ? timeline[currentIndex - 1] : null;
  const nextCourse = currentIndex >= 0 ? timeline[currentIndex + 1] : null;
  const needsPostClass = course.status === "completed" && course.postClassSummary?.status !== "confirmed";

  return (
    <section className="continuity-bar">
      <div className="continuity-step">
        <span>上一节</span>
        {previousCourse ? (
          <button type="button" className="continuity-link" onClick={() => onSelectCourse(previousCourse.id)}>
            {previousCourse.desiredContent || "未命名课程"}
          </button>
        ) : (
          <strong>暂无历史课</strong>
        )}
        <small>{previousCourse ? formatDate(previousCourse.lessonTime || previousCourse.createdAt) : "本节会作为连续档案起点"}</small>
      </div>
      <div className={needsPostClass ? "continuity-step attention" : "continuity-step"}>
        <span>本节沉淀</span>
        <strong>{postClassStateLabel(course)}</strong>
        <small>{needsPostClass ? "确认后才会更新学生长期档案" : "后续备课会读取确认后的档案"}</small>
      </div>
      <div className="continuity-step">
        <span>下一节</span>
        {nextCourse ? (
          <button type="button" className="continuity-link" onClick={() => onSelectCourse(nextCourse.id)}>
            {nextCourse.desiredContent || "未命名课程"}
          </button>
        ) : (
          <strong>{student.nextLessonSuggestion ? compactText(student.nextLessonSuggestion, 80) : "待规划"}</strong>
        )}
        <small>{nextCourse ? formatDate(nextCourse.lessonTime || nextCourse.createdAt) : "新建课程时可沿用下节课建议"}</small>
      </div>
    </section>
  );
}

function CourseDetail({
  student,
  courses,
  course,
  onSelectCourse,
  onRefresh,
  onDeleteCourse,
  onError
}: {
  student: Student;
  courses: Course[];
  course: Course | null;
  onSelectCourse: (id: string) => void;
  onRefresh: () => Promise<void> | void;
  onDeleteCourse: (course: Course) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [files, setFiles] = useState<CourseFile[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [manualQuality, setManualQuality] = useState<NonNullable<Job["quality"]> | null>(null);
  const [logTail, setLogTail] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingQuality, setCheckingQuality] = useState(false);
  const [editing, setEditing] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refineFiles, setRefineFiles] = useState<File[]>([]);
  const [refineUploadStatus, setRefineUploadStatus] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const [refining, setRefining] = useState(false);
  const [pdfRefinePages, setPdfRefinePages] = useState("");
  const [pdfRefineInstruction, setPdfRefineInstruction] = useState("");
  const [pdfRefining, setPdfRefining] = useState(false);
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialResults, setMaterialResults] = useState<RagSearchResult[]>([]);
  const [searchingMaterials, setSearchingMaterials] = useState(false);
  const [notifyingFeishu, setNotifyingFeishu] = useState(false);
  const [detailTab, setDetailTab] = useState<CourseDetailTab>("preview");
  const refineFileInputRef = useRef<HTMLInputElement | null>(null);
  const refineImageInputRef = useRef<HTMLInputElement | null>(null);

  const courseId = course?.id || "";
  const courseJobId = course?.jobId || "";
  const previewFiles = courseOutputFiles(files);
  const selectedFile = previewFiles.find((file) => file.path === selectedPath) || preferredCourseOutputFile(previewFiles);

  const loadFiles = useCallback(async () => {
    if (!courseId) return;
    const data = await api.get<{ files: CourseFile[] }>(`/api/courses/${courseId}/files`);
    setFiles((current) => (sameCourseFileList(current, data.files) ? current : data.files));
    setSelectedPath((current) => {
      const outputFiles = courseOutputFiles(data.files);
      if (current && outputFiles.some((file) => file.path === current)) return current;
      return preferredCourseOutputFile(outputFiles)?.path || "";
    });
  }, [courseId]);

  const loadJob = useCallback(async () => {
    if (!courseJobId) {
      setJob(null);
      setLogTail("");
      return;
    }
    const data = await api.get<{ job: Job; logTail: string }>(`/api/jobs/${courseJobId}`);
    setJob(data.job);
    setLogTail(data.logTail);
  }, [courseJobId]);

  const loadJobs = useCallback(async () => {
    if (!courseId) {
      setJobs([]);
      return;
    }
    const data = await api.get<{ jobs: Job[] }>(`/api/courses/${courseId}/jobs`);
    setJobs(data.jobs);
  }, [courseId]);

  useEffect(() => {
    setFiles([]);
    setSelectedPath("");
    setJobs([]);
    setManualQuality(null);
    setEditing(false);
    setDetailTab("preview");
    setRefineInstruction("");
    setRefineFiles([]);
    setRefineUploadStatus(null);
    setPdfRefinePages("");
    setPdfRefineInstruction("");
    setMaterialQuery("");
    setMaterialResults([]);
    if (!courseId) return;
    loadFiles().catch((err) => onError(err.message));
    loadJob().catch((err) => onError(err.message));
    loadJobs().catch((err) => onError(err.message));
  }, [courseId, loadFiles, loadJob, loadJobs, onError]);

  const polling =
    course?.status === "running" ||
    course?.status === "queued" ||
    job?.status === "running" ||
    job?.status === "queued";
  const wasPollingRef = useRef(false);
  useInterval(
    () => {
      loadJob().catch((err) => onError(err.message));
      loadJobs().catch((err) => onError(err.message));
    },
    polling ? 4000 : null
  );
  useInterval(
    () => {
      loadFiles().catch((err) => onError(err.message));
    },
    polling ? 20000 : null
  );
  useEffect(() => {
    const wasPolling = wasPollingRef.current;
    wasPollingRef.current = polling;
    if (!wasPolling || polling || !courseId) return;
    loadFiles().catch((err) => onError(err.message));
    loadJob().catch((err) => onError(err.message));
    loadJobs().catch((err) => onError(err.message));
  }, [polling, courseId, loadFiles, loadJob, loadJobs, onError]);

  if (!course) {
    return (
      <section className="detail-panel empty-detail">
        <FileText size={26} />
        <h3>选择一节课程</h3>
      </section>
    );
  }

  async function runCourse() {
    if (!course) return;
    setBusy(true);
    try {
      const data = await api.post<{ job: Job }>(`/api/courses/${course.id}/run`);
      setJob(data.job);
      setLogTail("");
      setManualQuality(null);
      await onRefresh();
      await loadJobs();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadAttachments(event: React.ChangeEvent<HTMLInputElement>) {
    const inputFiles = event.target.files;
    if (!inputFiles?.length || !course) return;
    const formData = new FormData();
    appendUploadFiles(formData, inputFiles);
    try {
      await api.post(`/api/courses/${course.id}/attachments`, formData);
      await onRefresh();
      await loadFiles();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      event.target.value = "";
    }
  }

  async function searchCourseMaterials() {
    if (!materialQuery.trim()) {
      setMaterialResults([]);
      return;
    }
    setSearchingMaterials(true);
    try {
      const data = await api.get<{ results: RagSearchResult[] }>(`/api/materials/search?q=${encodeURIComponent(materialQuery)}`);
      setMaterialResults(data.results);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchingMaterials(false);
    }
  }

  async function selectCourseMaterial(pathValue: string) {
    if (!course) return;
    try {
      await api.post(`/api/courses/${course.id}/materials/select`, { paths: [pathValue] });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeCourseMaterial(pathValue: string) {
    if (!course) return;
    try {
      await api.post(`/api/courses/${course.id}/materials/remove`, { paths: [pathValue] });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refineCourse(event: React.FormEvent) {
    event.preventDefault();
    if (!course) return;
    const submittedFileCount = refineFiles.length;
    setRefineUploadStatus(
      submittedFileCount > 0 ? { tone: "info", text: `正在上传 ${submittedFileCount} 个文件...` } : null
    );
    setRefining(true);
    try {
      const formData = new FormData();
      formData.append("instruction", refineInstruction);
      refineFiles.forEach((file) => formData.append("files", file, file.name));
      const data = await api.post<{ job: Job; files: string[] }>(`/api/courses/${course.id}/refine`, formData);
      setJob(data.job);
      setLogTail("");
      setManualQuality(null);
      setRefineInstruction("");
      setRefineFiles([]);
      setRefineUploadStatus(
        data.files.length > 0
          ? { tone: "success", text: `上传成功：${data.files.length} 个文件已保存，补充任务正在调用 OCR。` }
          : { tone: "success", text: "补充任务已提交。" }
      );
      await onRefresh();
      await loadJobs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRefineUploadStatus({ tone: "error", text: `上传或提交失败：${message}` });
      onError(message);
    } finally {
      setRefining(false);
    }
  }

  async function refinePdfImages(event: React.FormEvent) {
    event.preventDefault();
    if (!course) return;
    setPdfRefining(true);
    try {
      const data = await api.post<{ job: Job }>(`/api/courses/${course.id}/pdf-image-refine`, {
        pages: pdfRefinePages,
        instruction: pdfRefineInstruction
      });
      setJob(data.job);
      setLogTail("");
      setManualQuality(null);
      setPdfRefinePages("");
      setPdfRefineInstruction("");
      await onRefresh();
      await loadJobs();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPdfRefining(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${job.id}/cancel`);
      await onRefresh();
      await loadJob();
      await loadJobs();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function continueJob(jobId: string) {
    setBusy(true);
    try {
      const data = await api.post<{ job: Job }>(`/api/jobs/${jobId}/continue`);
      setJob(data.job);
      setLogTail("");
      setManualQuality(null);
      await onRefresh();
      await loadJobs();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkQuality() {
    if (!course) return;
    setCheckingQuality(true);
    try {
      const data = await api.post<{ quality: NonNullable<Job["quality"]>; job: Job | null }>(`/api/courses/${course.id}/quality`);
      setManualQuality(data.quality);
      if (data.job) setJob(data.job);
      await loadJobs();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingQuality(false);
    }
  }

  async function notifyFeishu() {
    if (!course) return;
    setNotifyingFeishu(true);
    try {
      await api.post<{ course: Course; notification: { action: "sent" | "skipped" | "failed"; detail: string } }>(
        `/api/courses/${course.id}/feishu/notify`
      );
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotifyingFeishu(false);
    }
  }

  const currentQuality = job?.quality || manualQuality;
  const selectedMaterials = splitLocalFiles(course.localFiles);
  const agentWorkStatus = agentWorkFiles.map((workFile) => ({
    ...workFile,
    file: files.find((file) => workFile.paths.includes(file.relativePath.replace(/\\/g, "/"))) || null
  }));
  const tabs: Array<{ key: CourseDetailTab; label: string; count?: number }> = [
    { key: "preview", label: "产物预览", count: previewFiles.length },
    { key: "workflow", label: "资料与流程", count: agentWorkStatus.filter((item) => item.file).length },
    { key: "postClass", label: "课后沉淀", count: course.postClassSummary?.status === "confirmed" ? 1 : undefined },
    { key: "activity", label: "任务记录", count: jobs.length }
  ];

  return (
    <section className="detail-panel course-console redesigned-course">
      <header className="detail-header course-console-header">
        <div>
          <span className={statusClass(course.status)}>{statusLabel(course.status)}</span>
          <h3>{course.desiredContent || "未命名课程"}</h3>
          <p>
            {course.type === "trial" ? "试听课" : "正式课"} · {course.grade || "年级待填"} · {course.durationMinutes} 分钟
          </p>
        </div>
        <div className="button-row command-bar">
          <button className="ghost-button" disabled={checkingQuality || polling} onClick={checkQuality}>
            {checkingQuality ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
            质量检查
          </button>
          {polling && job ? (
            <button className="ghost-button danger-button" disabled={busy} onClick={cancelJob}>
              <X size={17} />
              取消生成
            </button>
          ) : null}
          <button className="ghost-button" onClick={() => setEditing((value) => !value)}>
            <SlidersHorizontal size={17} />
            编辑设置
          </button>
          {course.status === "completed" ? (
            <button className="ghost-button" disabled={polling || notifyingFeishu} onClick={notifyFeishu}>
              {notifyingFeishu ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
              重发飞书消息
            </button>
          ) : null}
          <button className="ghost-button danger-button" disabled={polling} onClick={() => onDeleteCourse(course).catch((err) => onError(err.message))}>
            <Trash2 size={17} />
            删除课程
          </button>
          <button className="primary-button" disabled={busy || polling} onClick={() => runCourse()}>
            {busy || polling ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            调用 Codex
          </button>
        </div>
      </header>

      <section className="course-overview-band">
        <div className="meta-strip">
          <span>
            <CalendarClock size={15} />
            {formatDate(course.lessonTime)}
          </span>
          <span>{course.score || "分数待填"}</span>
          <span>{course.province || "地区待填"}</span>
          <span>{course.lessonKind || "课程性质待填"}</span>
        </div>

        <CourseContinuityBar student={student} course={course} courses={courses} onSelectCourse={onSelectCourse} />

        {course.feishuSync ? (
          <div className="meta-strip">
            {course.feishuSync.folderUrl ? (
              <a href={course.feishuSync.folderUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={15} />
                飞书目录
              </a>
            ) : (
              <span>飞书目录待同步</span>
            )}
            <span>消息：{feishuNotificationLabel(course.feishuSync.notificationStatus)}</span>
            {course.feishuSync.notificationDetail ? (
              <span title={course.feishuSync.notificationDetail}>{compactText(course.feishuSync.notificationDetail)}</span>
            ) : null}
          </div>
        ) : null}
      </section>

      {editing ? (
        <CourseSettingsPanel
          student={student}
          course={course}
          onSaved={onRefresh}
          onCancel={() => setEditing(false)}
          onError={onError}
        />
      ) : null}

      <nav className="course-tabs" aria-label="课程详情">
        {tabs.map((tab) => (
          <button key={tab.key} className={detailTab === tab.key ? "active" : ""} onClick={() => setDetailTab(tab.key)}>
            {tab.label}
            {tab.count !== undefined ? <span>{tab.count}</span> : null}
          </button>
        ))}
      </nav>

      <div className="course-tab-body">
        {detailTab === "preview" ? (
          <div className="course-preview-layout">
            <FilePreview file={selectedFile} />
            <section className="tool-group generated-files">
              <div className="panel-title">
                <FolderOpen size={18} />
                <h4>生成文件</h4>
              </div>
              <form className="pdf-refine-panel" onSubmit={refinePdfImages}>
                <div className="panel-title compact-title">
                  <Image size={17} />
                  <h4>PDF 图形修订</h4>
                </div>
                <label>
                  页码
                  <input
                    value={pdfRefinePages}
                    onChange={(event) => setPdfRefinePages(event.target.value)}
                    placeholder="例如：4 或 3,7-8"
                    disabled={polling}
                  />
                </label>
                <label>
                  修改要求
                  <textarea
                    value={pdfRefineInstruction}
                    onChange={(event) => setPdfRefineInstruction(event.target.value)}
                    placeholder="只写要改的图形/标签/版面，例如：第4页立体图 C 点和 C1 点太近，把底面三角形展开一点，标签不要压线。"
                    rows={4}
                    disabled={polling}
                  />
                </label>
                <button className="ghost-button" disabled={polling || pdfRefining || !pdfRefinePages.trim() || !pdfRefineInstruction.trim()}>
                  {pdfRefining ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                  单独修 PDF 图
                </button>
              </form>
              <div className="file-list">
                {previewFiles.length === 0 ? (
                  <div className="quiet-empty">等待生成文件</div>
                ) : (
                  previewFiles.map((file) => (
                    <div key={file.path} className={file.path === selectedFile?.path ? "file-row active" : "file-row"}>
                      <button className="file-select" onClick={() => setSelectedPath(file.path)}>
                        <span>{file.name}</span>
                        <small>{courseFileKindLabel(file)}</small>
                      </button>
                      <a
                        className="icon-button"
                        title="新页面打开"
                        aria-label="新页面打开"
                        href={`/viewer?path=${encodeURIComponent(file.path)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={15} />
                      </a>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        ) : null}

        {detailTab === "workflow" ? (
          <section className="course-tool-stack">
            <section className="tool-group">
              <div className="panel-title">
                <FileText size={18} />
                <h4>资料选择</h4>
              </div>
              <label className="upload-line">
                <Upload size={16} />
                上传本地文件/图片
                <input type="file" multiple onChange={uploadAttachments} />
              </label>
              <div className="course-material-picker">
                <div className="material-select-row">
                  <Search size={16} />
                  <input
                    value={materialQuery}
                    onChange={(event) => setMaterialQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        searchCourseMaterials();
                      }
                    }}
                    placeholder="搜索资料库并加入本课"
                  />
                  <button type="button" className="ghost-button" disabled={searchingMaterials} onClick={searchCourseMaterials}>
                    {searchingMaterials ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
                    搜索
                  </button>
                </div>
                {materialResults.length > 0 ? (
                  <div className="material-pick-list compact">
                    {materialResults.slice(0, 5).map((result) => (
                      <button type="button" key={result.material.path} onClick={() => selectCourseMaterial(result.material.path)}>
                        <strong>{result.material.title}</strong>
                        <small>{result.reason}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {selectedMaterials.length > 0 ? (
                <div className="selected-materials">
                  <strong>已选资料</strong>
                  {selectedMaterials.map((item) => (
                    <div key={item} className="selected-material-row">
                      <span title={item}>{localFileLabel(item)}</span>
                      <button
                        className="icon-button danger-icon"
                        title="移除"
                        aria-label="移除已选资料"
                        onClick={() => removeCourseMaterial(item)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <AgentWorkPanel items={agentWorkStatus} />
            {currentQuality ? <QualityPanel quality={currentQuality} /> : null}
          </section>
        ) : null}

        {detailTab === "postClass" ? <PostClassSummaryPanel course={course} onSaved={onRefresh} onError={onError} /> : null}

        {detailTab === "activity" ? (
          <section className="course-tool-stack">
            {job ? (
              <div className="job-log">
                <div className="job-log-title">
                  <span className={statusClass(job.status)}>{statusLabel(job.status)}</span>
                  <small>{job.exitCode ?? ""}</small>
                  {job.status === "failed" || job.status === "canceled" ? (
                    <button className="ghost-button" disabled={busy || polling} onClick={() => continueJob(job.id)}>
                      {busy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
                      继续生成
                    </button>
                  ) : null}
                </div>
                <pre>{logTail || "暂无日志"}</pre>
              </div>
            ) : (
              <div className="quiet-empty">暂无任务日志</div>
            )}

            {jobs.length > 0 ? <JobHistory jobs={jobs} disabled={busy || polling} onContinue={continueJob} /> : null}

            <form className="refine-panel" onSubmit={refineCourse}>
              <label>
                内容不够时继续补充
                <textarea
                  value={refineInstruction}
                  onChange={(event) => setRefineInstruction(event.target.value)}
                  placeholder="例如：逐字稿再细一点，补 6 道函数单调性变式题，PDF 课件页数增加到 12 页"
                  rows={3}
                  disabled={polling}
                />
              </label>
              <section className="resource-picker refine-files">
                <div className="resource-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={polling || refining}
                    onClick={() => refineFileInputRef.current?.click()}
                  >
                    <Upload size={16} />
                    上传 PDF/文件
                  </button>
                  <input
                    ref={refineFileInputRef}
                    className="hidden-file-input"
                    type="file"
                    accept=".pdf,.txt,.md,.markdown,.tex,.csv,application/pdf,text/*"
                    multiple
                    onChange={(event) => {
                      const selected = Array.from(event.target.files || []);
                      setRefineFiles((current) => [...current, ...selected]);
                      if (selected.length > 0) {
                        setRefineUploadStatus({ tone: "info", text: `已选择 ${selected.length} 个文件，点击“提交补充”后上传。` });
                      }
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={polling || refining}
                    onClick={() => refineImageInputRef.current?.click()}
                  >
                    <Image size={16} />
                    上传图片
                  </button>
                  <input
                    ref={refineImageInputRef}
                    className="hidden-file-input"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      const selected = Array.from(event.target.files || []);
                      setRefineFiles((current) => [...current, ...selected]);
                      if (selected.length > 0) {
                        setRefineUploadStatus({ tone: "info", text: `已选择 ${selected.length} 张图片，点击“提交补充”后上传。` });
                      }
                      event.target.value = "";
                    }}
                  />
                  <span>{refineFiles.length > 0 ? `${refineFiles.length} 个文件将随补充任务上传` : "PDF/图片会先调用 OCR"}</span>
                </div>
                {refineFiles.length > 0 ? (
                  <div className="draft-file-list">
                    {refineFiles.map((file, index) => (
                      <span key={`${file.name}-${file.lastModified}-${index}`}>
                        {file.name}
                        <button
                          type="button"
                          aria-label={`移除 ${file.name}`}
                          onClick={() => {
                            const remainingCount = Math.max(0, refineFiles.length - 1);
                            setRefineFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
                            setRefineUploadStatus(
                              remainingCount > 0
                                ? { tone: "info", text: `已选择 ${remainingCount} 个文件，点击“提交补充”后上传。` }
                                : null
                            );
                          }}
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {refineUploadStatus ? (
                  <div className={`refine-upload-status ${refineUploadStatus.tone}`} role="status">
                    {refining && refineUploadStatus.tone === "info" ? <Loader2 className="spin" size={14} /> : null}
                    {!refining && refineUploadStatus.tone === "success" ? <CheckCircle2 size={14} /> : null}
                    {!refining && refineUploadStatus.tone === "error" ? <X size={14} /> : null}
                    <span>{refineUploadStatus.text}</span>
                  </div>
                ) : null}
              </section>
              <button
                className="ghost-button"
                disabled={polling || refining || (!refineInstruction.trim() && refineFiles.length === 0)}
              >
                {refining ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                提交补充
              </button>
            </form>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function AgentWorkPanel({
  items
}: {
  items: Array<{ paths: string[]; label: string; file: CourseFile | null }>;
}) {
  const completed = items.filter((item) => item.file).length;
  return (
    <section className="agent-work-panel">
      <div className="agent-work-head">
        <strong>多 Agent 工作区</strong>
        <small>{completed}/{items.length}</small>
      </div>
      <div className="agent-work-list">
        {items.map((item) => (
          <div key={item.label} className={item.file ? "agent-work-item done" : "agent-work-item missing"}>
            <span>{item.label}</span>
            <small>{item.file ? `${Math.max(1, Math.round(item.file.size / 1024))} KB · ${formatDate(item.file.updatedAt)}` : "待生成"}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function QualityPanel({ quality }: { quality: NonNullable<Job["quality"]> }) {
  const label = quality.status === "pass" ? "通过" : quality.status === "warn" ? "有警告" : "未通过";
  const className =
    quality.status === "pass"
      ? "status status-completed"
      : quality.status === "warn"
      ? "status status-queued"
      : "status status-failed";

  return (
    <section className="quality-panel">
      <div className="quality-head">
        <div>
          <strong>生成质量评分</strong>
          <small>{formatDate(quality.checkedAt)}</small>
        </div>
        <div className="quality-score">
          <strong>{quality.score}</strong>
          <span className={className}>{label}</span>
        </div>
      </div>
      <div className="quality-list">
        {quality.items.map((check) => (
          <div key={check.key} className={`quality-item quality-${check.status}`}>
            <span className={statusClass(check.status === "pass" ? "completed" : check.status === "warn" ? "queued" : "failed")}>
              {check.status === "pass" ? "通过" : check.status === "warn" ? "警告" : "失败"}
            </span>
            <div>
              <strong>{check.label}</strong>
              <small>{check.message}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function JobHistory({
  jobs,
  disabled,
  onContinue
}: {
  jobs: Job[];
  disabled: boolean;
  onContinue: (jobId: string) => void;
}) {
  const jobKindLabel = (historyJob: Job) => {
    if (historyJob.kind === "pdf-image-refine") return `PDF 图形修订${historyJob.pdfRefinePages ? ` P${historyJob.pdfRefinePages}` : ""}`;
    if (historyJob.refineInstruction) {
      return historyJob.supplementalFiles?.length ? `补充生成 · ${historyJob.supplementalFiles.length} 个附件` : "补充生成";
    }
    return "首次生成";
  };

  return (
    <section className="job-history">
      <strong>生成记录</strong>
      {jobs.slice(0, 6).map((historyJob, index) => (
        <div key={historyJob.id} className="history-row">
          <span className={statusClass(historyJob.status)}>{statusLabel(historyJob.status)}</span>
          <div>
            <small>
              {jobKindLabel(historyJob)} · {formatDate(historyJob.createdAt)}
              {index === 0 ? " · 最新" : ""}
            </small>
            {historyJob.quality ? <small>质量评分 {historyJob.quality.score}</small> : null}
          </div>
          {historyJob.status === "failed" || historyJob.status === "canceled" ? (
            <button className="ghost-button" disabled={disabled} onClick={() => onContinue(historyJob.id)}>
              <RefreshCcw size={15} />
              继续
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function FilePreview({ file }: { file: CourseFile | null }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const previousPathRef = useRef("");
  const markdownContent = useMemo(() => normalizeMarkdownMath(content), [content]);

  useEffect(() => {
    const filePath = file?.path || "";
    const fileKind = file?.kind || "";
    const pathChanged = previousPathRef.current !== filePath;
    previousPathRef.current = filePath;

    if (pathChanged) setContent("");
    setError("");
    if (!filePath || !["markdown", "text"].includes(fileKind)) return;
    let canceled = false;
    api
      .get<{ content: string }>(`/api/files/content?path=${encodeURIComponent(filePath)}`)
      .then((data) => {
        if (!canceled) setContent(data.content);
      })
      .catch((err) => {
        if (!canceled) setError(err.message);
      });
    return () => {
      canceled = true;
    };
  }, [file?.path, file?.kind, file?.updatedAt]);

  if (!file) {
    return (
      <section className="preview-panel empty-preview">
        <FileText size={26} />
        <h4>暂无可预览文件</h4>
      </section>
    );
  }

  const rawUrl = `/api/files/raw?path=${encodeURIComponent(file.path)}&v=${encodeURIComponent(file.updatedAt || "")}`;
  const viewerUrl = `/viewer?path=${encodeURIComponent(file.path)}`;

  return (
    <section className="preview-panel">
      <div className="preview-title">
        <strong>{file.name}</strong>
        <span className="preview-actions">
          <a href={viewerUrl} target="_blank" rel="noreferrer">
            新页面
          </a>
          <a href={rawUrl} target="_blank" rel="noreferrer">
            原文件
          </a>
        </span>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {file.kind === "markdown" ? (
        <article className="markdown-view">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
            {markdownContent}
          </ReactMarkdown>
        </article>
      ) : null}
      {file.kind === "text" ? <pre className="text-view">{content}</pre> : null}
      {file.kind === "pdf" ? <iframe className="pdf-view" src={rawUrl} title={file.name} /> : null}
      {file.kind === "image" ? <img className="image-view" src={rawUrl} alt={file.name} /> : null}
      {file.kind === "other" ? <div className="quiet-empty">此类型请点击打开查看</div> : null}
    </section>
  );
}

function MaterialsView({ system, onError }: { system: SystemInfo | null; onError: (message: string) => void }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [chunkCount, setChunkCount] = useState(system?.ragChunkCount || 0);
  const [reindexJob, setReindexJob] = useState<RagReindexJob | null>(null);
  const [docNotice, setDocNotice] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploadRoot, setUploadRoot] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [busy, setBusy] = useState(false);

  const loadMaterials = useCallback(async () => {
    const data = await api.get<{ materials: Material[]; chunkCount: number; uploadRoot: string }>("/api/materials");
    setMaterials(data.materials);
    setChunkCount(data.chunkCount);
    setUploadRoot(data.uploadRoot);
  }, []);

  useEffect(() => {
    loadMaterials().catch((err) => onError(err.message));
  }, [loadMaterials, onError]);

  useInterval(
    () => {
      api
        .get<{ job: RagReindexJob; stats: { chunks: number } }>("/api/materials/reindex")
        .then((data) => {
          setReindexJob(data.job);
          setChunkCount(data.stats.chunks);
          if (data.job.status === "completed" || data.job.status === "failed") loadMaterials().catch((err) => onError(err.message));
        })
        .catch((err) => onError(err.message));
    },
    reindexJob?.status === "running" ? 1500 : null
  );

  const search = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const data = await api.get<{ results: RagSearchResult[] }>(`/api/materials/search?q=${encodeURIComponent(query)}`);
    setResults(data.results);
  }, [query]);

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files?.length) return;
    const allFiles = Array.from(files);
    const batchSize = 20;
    setBusy(true);
    try {
      for (let start = 0; start < allFiles.length; start += batchSize) {
        const batch = allFiles.slice(start, start + batchSize);
        const formData = new FormData();
        appendUploadFileArray(formData, batch);
        setUploadNotice(`正在上传 ${Math.min(start + batch.length, allFiles.length)}/${allFiles.length}`);
        const data = await api.post<{ job: RagReindexJob }>("/api/materials/upload", formData);
        setReindexJob(data.job);
      }
      setUploadNotice(`已上传 ${allFiles.length} 个文件，正在增量索引新资料。`);
      await loadMaterials();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function reindex() {
    setBusy(true);
    try {
      const data = await api.post<{ job: RagReindexJob; stats: { chunks: number } }>("/api/materials/reindex");
      setReindexJob(data.job);
      setChunkCount(data.stats.chunks);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function showDocConversionNotice() {
    try {
      const data = await api.get<{ count: number; message: string }>("/api/materials/convert-doc");
      setDocNotice(`${data.message}${data.count > 0 ? ` 当前有 ${data.count} 个 .doc 文件需要转换。` : " 当前没有待转换 .doc 文件。"}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteMaterial(material: Material) {
    if (!window.confirm(`删除资料「${material.title}」？这会同时删除文件和 RAG 索引。`)) return;
    setBusy(true);
    try {
      const data = await api.del<{ chunkCount: number }>(`/api/materials/${material.id}`);
      setChunkCount(data.chunkCount);
      setResults((current) => current.filter((result) => result.material.id !== material.id));
      await loadMaterials();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMaterialFolder(entry: Extract<MaterialBrowserEntry, { kind: "folder" }>) {
    if (!window.confirm(`删除文件夹「${entry.name}」及其中 ${entry.count} 个资料文件？这会同时删除文件和 RAG 索引。`)) return;
    setBusy(true);
    try {
      const data = await api.del<{ chunkCount: number }>(`/api/materials/folder?path=${encodeURIComponent(entry.path)}`);
      setChunkCount(data.chunkCount);
      setResults((current) => current.filter((result) => !materialRelativePath(result.material, uploadRoot).startsWith(`${entry.path}/`)));
      if (currentPath === entry.path || currentPath.startsWith(`${entry.path}/`)) setCurrentPath(parentMaterialPath(entry.path));
      await loadMaterials();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const indexedCount = useMemo(() => materials.filter((material) => material.status === "indexed").length, [materials]);
  const totalMaterialCount = materials.length;
  const questionCount = useMemo(() => materials.reduce((sum, material) => sum + (material.questionCount || 0), 0), [materials]);
  const snippetCount = useMemo(() => materials.reduce((sum, material) => sum + (material.snippetCount || 0), 0), [materials]);
  const browserEntries = useMemo(() => buildMaterialEntries(materials, uploadRoot, currentPath), [materials, uploadRoot, currentPath]);

  return (
    <section className="materials-view settings-workspace">
      <header className="workspace-header workspace-hero">
        <div>
          <p className="eyebrow">资料库</p>
          <h2>本地 RAG 索引</h2>
          <span>{uploadRoot || "资料库/网页上传"}</span>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={reindex} disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
            增量索引资料库
          </button>
          <button className="ghost-button" onClick={showDocConversionNotice}>
            <FileText size={16} />
            .doc 转换
          </button>
          <label className="primary-button file-button">
            <Upload size={17} />
            上传资料
            <input type="file" multiple onChange={upload} />
          </label>
          <label className="ghost-button file-button">
            <FolderUp size={17} />
            上传文件夹
            <input type="file" multiple {...folderPickerProps} onChange={upload} />
          </label>
        </div>
      </header>

      <div className="stat-row materials-stats">
        <div>
          <Boxes size={18} />
          <strong>{totalMaterialCount}</strong>
          <span>资料文件</span>
          <small>{indexedCount} 个已索引</small>
        </div>
        <div>
          <FileText size={18} />
          <strong>{questionCount}</strong>
          <span>题目记录</span>
          <small>优先用于选题</small>
        </div>
        <div>
          <BookOpen size={18} />
          <strong>{snippetCount}</strong>
          <span>参考片段</span>
          <small>知识点、解析与说明</small>
        </div>
        <div>
          <Search size={18} />
          <strong>{chunkCount}</strong>
          <span>可检索内容</span>
          <small>题目 + 片段</small>
        </div>
      </div>

      {reindexJob ? (
        <section className="reindex-status">
          <div>
            <strong>
              {reindexJob.status === "running"
                ? "正在增量索引"
                : reindexJob.status === "completed"
                ? "增量索引完成"
                : reindexJob.status === "failed"
                ? "增量索引失败"
                : "索引待命"}
            </strong>
            <small>
              {reindexJob.processed}/{reindexJob.total} · 已索引 {reindexJob.indexed}
              {reindexJob.current ? ` · ${localFileLabel(reindexJob.current)}` : ""}
              {reindexJob.error ? ` · ${reindexJob.error}` : ""}
            </small>
          </div>
          <progress value={reindexJob.processed} max={Math.max(1, reindexJob.total)} />
        </section>
      ) : null}

      {docNotice ? <div className="doc-notice">{docNotice}</div> : null}
      {uploadNotice ? <div className="doc-notice">{uploadNotice}</div> : null}

      <div className="materials-layout">
        <section className="materials-search-panel">
          <div className="panel-title">
            <Search size={18} />
            <h3>资料检索</h3>
          </div>
          <section className="search-band">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") search().catch((err) => onError(err.message));
              }}
              placeholder="搜索知识点、题型、年级"
            />
            <button onClick={() => search().catch((err) => onError(err.message))}>搜索</button>
          </section>

          {results.length > 0 ? (
            <section className="rag-results">
              {results.map((result) => (
                <article key={result.chunk.id} className="result-item">
                  <strong>
                    {result.question ? `${result.question.questionNumber || result.question.label} · ` : ""}
                    {result.material.title}
                  </strong>
                  <small>{result.material.path}</small>
                  {result.question ? (
                    <div className="result-meta">
                      <span>{sourceKindLabel(result.question.sourceKind)}</span>
                      <span>{result.question.questionType}</span>
                      <span>难度：{result.question.difficulty}</span>
                      <span>{result.question.hasAnswer ? "有解析" : "需验算"}</span>
                      {result.question.examSource ? <span>{result.question.examSource}</span> : null}
                    </div>
                  ) : result.snippet ? (
                    <div className="result-meta">
                      <span>{result.snippet.kind}</span>
                      <span>知识参考</span>
                    </div>
                  ) : null}
                  <span className="result-reason">{result.reason}</span>
                  <p>{result.excerpt}</p>
                </article>
              ))}
            </section>
          ) : (
            <div className="quiet-empty">输入关键词检索题目、解析和知识片段</div>
          )}
        </section>

        <section className="materials-browser-panel">
          <section className="materials-table">
            <div className="material-browser-header">
              <div>
                <strong>{currentPath || "全部资料"}</strong>
                <small>{currentPath ? "当前文件夹" : "文件夹优先显示"}</small>
              </div>
              {currentPath ? (
                <button className="ghost-button" onClick={() => setCurrentPath(parentMaterialPath(currentPath))}>
                  <ArrowLeft size={16} />
                  返回上级
                </button>
              ) : null}
            </div>
            {materials.length === 0 ? (
              <div className="quiet-empty">暂无索引资料</div>
            ) : browserEntries.length === 0 ? (
              <div className="quiet-empty">这个文件夹里暂无可显示资料</div>
            ) : (
              browserEntries.map((entry) => (
                entry.kind === "folder" ? (
                  <article key={`folder-${entry.path}`} className="material-row material-folder">
                    <div>
                      <button className="material-folder-open" onClick={() => setCurrentPath(entry.path)}>
                        <FolderOpen size={17} />
                        <span>{entry.name}</span>
                      </button>
                      <small>{entry.count} 个文件</small>
                    </div>
                    <div className="material-actions">
                      <button className="icon-button" title="打开文件夹" aria-label="打开文件夹" onClick={() => setCurrentPath(entry.path)}>
                        <ChevronRight size={18} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        disabled={busy}
                        title="删除文件夹"
                        aria-label="删除文件夹"
                        onClick={() => deleteMaterialFolder(entry)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                ) : (
                <article key={entry.material.id} className="material-row">
                    <div>
                      <strong>{entry.material.title}</strong>
                      <small>{entry.material.path}</small>
                    </div>
                    <div className="material-actions">
                      <span className={entry.material.status === "indexed" ? "status status-completed" : "status status-failed"}>
                        {entry.material.status === "indexed"
                        ? materialIndexLabel(entry.material)
                        : entry.material.status === "needs_conversion"
                        ? "待转换"
                        : entry.material.status === "pending"
                        ? "待索引"
                        : entry.material.status}
                      </span>
                      <a
                        className="icon-button"
                        title="预览 RAG 内容"
                        aria-label="预览 RAG 内容"
                        href={`/material-preview?id=${encodeURIComponent(entry.material.id)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Eye size={15} />
                      </a>
                      <a className="icon-button" title="新页面打开" aria-label="新页面打开" href={`/viewer?path=${encodeURIComponent(entry.material.path)}`} target="_blank" rel="noreferrer">
                        <ExternalLink size={15} />
                      </a>
                      <button
                        className="icon-button danger-icon"
                        disabled={busy}
                        title="删除资料"
                        aria-label="删除资料"
                        onClick={() => deleteMaterial(entry.material)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                )
              ))
            )}
          </section>
        </section>
      </div>
    </section>
  );
}

function sourceKindLabel(kind: RagSourceKind) {
  const labels: Record<string, string> = {
    exam: "真题",
    mock: "模考",
    local: "本地题",
    adapted: "改编题",
    self_written: "自编题",
    unknown: "来源未分类"
  };
  return labels[String(kind)] || String(kind);
}

function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function materialIndexLabel(material: Material) {
  const questions = material.questionCount || 0;
  const snippets = material.snippetCount || 0;
  if (questions > 0 || snippets > 0) return `${questions} 题 · ${snippets} 段`;
  return "已索引 · 未拆出题目";
}

interface MaterialRagPreviewData {
  material: Material;
  questions: RagQuestionRecord[];
  snippets: NonNullable<RagSearchResult["snippet"]>[];
}

function MaterialRagPreview({ materialId }: { materialId: string }) {
  const [preview, setPreview] = useState<MaterialRagPreviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setPreview(null);
    setError("");
    if (!materialId) return;
    api
      .get<MaterialRagPreviewData>(`/api/materials/${materialId}/preview`)
      .then((data) => setPreview(data))
      .catch((err) => setError(err.message));
  }, [materialId]);

  if (!materialId) {
    return (
      <section className="preview-panel empty-preview">
        <FileText size={26} />
        <h4>缺少资料 ID</h4>
      </section>
    );
  }

  const material = preview?.material;

  return (
    <section className="preview-panel material-rag-preview">
      <div className="preview-title">
        <strong>{material?.title || "正在读取资料"}</strong>
        <span className="preview-actions">
          {material ? <a href={`/viewer?path=${encodeURIComponent(material.path)}`} target="_blank" rel="noreferrer">
            原文件
          </a> : null}
        </span>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {!preview ? <div className="quiet-empty">正在读取 RAG 内容...</div> : null}
      {preview && preview.questions.length === 0 && preview.snippets.length === 0 ? (
        <div className="quiet-empty">{preview.material.status === "pending" ? "这个文件尚未索引。" : "这个文件没有可预览的 RAG 题目或片段。"}</div>
      ) : null}
      {preview?.questions.map((question) => (
        <article key={question.id} className="rag-preview-item">
          <div className="result-meta">
            <span>{question.questionNumber || question.label}</span>
            <span>{sourceKindLabel(question.sourceKind)}</span>
            <span>{question.questionType}</span>
            <span>{question.hasAnswer ? "有解析" : "需验算"}</span>
          </div>
          <p>{question.text}</p>
          {question.solution ? <small>{question.solution}</small> : null}
        </article>
      ))}
      {preview?.snippets.map((snippet) => (
        <article key={snippet.id} className="rag-preview-item">
          <div className="result-meta">
            <span>{snippet.kind}</span>
            <span>参考片段</span>
          </div>
          <p>{snippet.text}</p>
        </article>
      ))}
    </section>
  );
}

function materialRelativePath(material: Material, uploadRoot: string) {
  const normalizedPath = normalizePathSeparators(material.path);
  const normalizedRoot = normalizePathSeparators(uploadRoot);
  if (normalizedRoot && normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "") || material.title;
  }
  const marker = "/资料库/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex >= 0) return normalizedPath.slice(markerIndex + marker.length).replace(/^\/+/, "") || material.title;
  return normalizedPath.split("/").pop() || material.title;
}

function parentMaterialPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

type MaterialBrowserEntry =
  | { kind: "folder"; name: string; path: string; count: number }
  | { kind: "file"; material: Material };

function buildMaterialEntries(materials: Material[], uploadRoot: string, currentPath: string): MaterialBrowserEntry[] {
  const folderMap = new Map<string, { name: string; path: string; count: number }>();
  const files: Array<{ kind: "file"; material: Material }> = [];
  const currentParts = currentPath.split("/").filter(Boolean);

  for (const material of materials) {
    const relative = materialRelativePath(material, uploadRoot);
    const parts = relative.split("/").filter(Boolean);
    const matchesCurrent = currentParts.every((part, index) => parts[index] === part);
    if (!matchesCurrent) continue;

    const remaining = parts.slice(currentParts.length);
    if (remaining.length > 1) {
      const folderPath = [...currentParts, remaining[0]].join("/");
      const existing = folderMap.get(folderPath);
      if (existing) existing.count += 1;
      else folderMap.set(folderPath, { name: remaining[0], path: folderPath, count: 1 });
      continue;
    }

    files.push({ kind: "file", material });
  }

  return [
    ...Array.from(folderMap.values())
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((folder) => ({ kind: "folder" as const, ...folder })),
    ...files.sort((a, b) => a.material.title.localeCompare(b.material.title, "zh-CN"))
  ];
}
