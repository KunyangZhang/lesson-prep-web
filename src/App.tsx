import { useCallback, useEffect, useMemo, useState } from "react";
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
  Download,
  ArrowLeft,
  ExternalLink,
  Image,
  FileText,
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
  Stethoscope,
  Trash2,
  Upload,
  X,
  UserRound
} from "lucide-react";
import { api } from "./api";
import type { Course, CourseFile, Diagnostics, DiagnosticStatus, Job, Material, RagReindexJob, RagSearchResult, Student, SystemInfo, User } from "./types";

type View = "students" | "materials";

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

const folderPickerProps = { webkitdirectory: "", directory: "" };

function useInterval(callback: () => void, delay: number | null) {
  useEffect(() => {
    if (delay === null) return;
    const timer = window.setInterval(callback, delay);
    return () => window.clearInterval(timer);
  }, [callback, delay]);
}

function formatDate(value?: string) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
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

  const loadStudents = useCallback(async () => {
    const data = await api.get<{ students: Student[] }>("/api/students");
    setStudents(data.students);
    setSelectedStudentId((current) => {
      if (current && data.students.some((student) => student.id === current)) return current;
      return data.students[0]?.id || "";
    });
  }, []);

  const loadSession = useCallback(async () => {
    const system = await api.get<SystemInfo>("/api/system");
    if (system.setupRequired) {
      setSession({ system, user: null, loading: false });
      return;
    }

    try {
      const me = await api.get<{ user: User }>("/api/me");
      setSession({ system, user: me.user, loading: false });
      await loadStudents();
    } catch {
      setSession({ system, user: null, loading: false });
    }
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
    setCourses(data.courses);
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

            <section className="student-rail">
              <CreateStudentForm
                onCreated={async (student) => {
                  await loadStudents();
                  setSelectedStudentId(student.id);
                  setView("students");
                }}
                onError={setError}
              />

              <div className="rail-list">
                {students.map((student) => (
                  <div
                    key={student.id}
                    className={student.id === selectedStudentId ? "rail-item active" : "rail-item"}
                  >
                    <button
                      className="rail-select"
                      onClick={() => {
                        setSelectedStudentId(student.id);
                        setView("students");
                      }}
                    >
                      <span>
                        <strong>{student.name}</strong>
                        <small>{student.stage || "未设置学段"} · {student.courseCount || 0} 节课</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                    <button
                      className="icon-button danger-icon"
                      title="删除学生"
                      aria-label="删除学生"
                      onClick={async () => {
                        if (!window.confirm(`删除学生「${student.name}」？课程记录会从网页移除，但已生成文件会保留。`)) return;
                        try {
                          await api.del(`/api/students/${student.id}`);
                          setSelectedCourseId("");
                          await loadStudents();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </section>

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
            student={selectedStudent}
            courses={courses}
            selectedCourse={selectedCourse}
            onSelectCourse={setSelectedCourseId}
            onCreated={async (course) => {
              await loadCourses(course.studentId);
              setSelectedCourseId(course.id);
            }}
            onRefresh={() => {
              if (selectedStudentId) {
                return loadCourses(selectedStudentId);
              }
            }}
            onStudentSaved={async () => {
              await loadStudents();
              if (selectedStudentId) await loadCourses(selectedStudentId);
            }}
            onDeleteCourse={async (course) => {
              if (!window.confirm(`删除课程「${course.desiredContent || "未命名课程"}」？已生成文件会保留。`)) return;
              await api.del(`/api/courses/${course.id}`);
              await loadCourses(course.studentId);
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
        <span>RAG {diagnostics.counts.ragChunks}</span>
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
  student,
  courses,
  selectedCourse,
  onSelectCourse,
  onCreated,
  onRefresh,
  onStudentSaved,
  onDeleteCourse,
  onError
}: {
  student: Student | null;
  courses: Course[];
  selectedCourse: Course | null;
  onSelectCourse: (id: string) => void;
  onCreated: (course: Course) => void;
  onRefresh: () => Promise<void> | void;
  onStudentSaved: () => Promise<void> | void;
  onDeleteCourse: (course: Course) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);

  if (!student) {
    return (
      <section className="empty-state">
        <UserRound size={28} />
        <h2>先创建一个学生</h2>
      </section>
    );
  }

  return (
    <div className="student-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">学生</p>
          <h2>{student.name}</h2>
          <span>{student.stage || "未设置学段"}</span>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={() => onRefresh()}>
            <RefreshCcw size={16} />
            刷新
          </button>
          <button className="primary-button" onClick={() => setShowForm((value) => !value)}>
            <Plus size={17} />
            新建课程
          </button>
        </div>
      </header>

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

      <StudentProfilePanel student={student} onSaved={onStudentSaved} onError={onError} />

      <div className="content-grid">
        <section className="course-list-panel">
          <div className="panel-title">
            <FolderOpen size={18} />
            <h3>课程</h3>
          </div>
          {courses.length === 0 ? (
            <div className="quiet-empty">暂无课程</div>
          ) : (
            <div className="course-list">
              {courses.map((course) => (
                <div key={course.id} className={course.id === selectedCourse?.id ? "course-item active" : "course-item"}>
                  <button className="course-select" onClick={() => onSelectCourse(course.id)}>
                    <span className={statusClass(course.status)}>{statusLabel(course.status)}</span>
                    <strong>{course.desiredContent || "未命名课程"}</strong>
                    <small>
                      {course.type === "trial" ? "试听课" : "正式课"} · {course.grade || "年级待填"} · {formatDate(course.lessonTime)}
                    </small>
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

        <CourseDetail course={selectedCourse} onRefresh={onRefresh} onDeleteCourse={onDeleteCourse} onError={onError} />
      </div>
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
    nextLessonSuggestion: student.nextLessonSuggestion || ""
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      weakPoints: student.weakPoints || "",
      commonMistakes: student.commonMistakes || "",
      parentNotes: student.parentNotes || "",
      nextLessonSuggestion: student.nextLessonSuggestion || ""
    });
  }, [student.id, student.weakPoints, student.commonMistakes, student.parentNotes, student.nextLessonSuggestion]);

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
      </div>
    </form>
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
    lessonTime: course.lessonTime || "",
    durationMinutes: course.durationMinutes || emptyCourseForm.durationMinutes,
    localFiles: course.localFiles || "",
    notes: course.notes || ""
  };
}

function CourseSettingsPanel({
  course,
  onSaved,
  onCancel,
  onError
}: {
  course: Course;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(() => courseToEditableForm(course));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(courseToEditableForm(course));
  }, [course.id]);

  function update(name: string, value: string | number) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
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
          <small>修改后再次调用 Codex 会使用这里的新信息</small>
        </div>
        <button type="button" className="tiny-icon-button" title="关闭" aria-label="关闭课程设置" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

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
          <input value={form.grade} onChange={(event) => update("grade", event.target.value)} />
        </label>
        <label>
          分数
          <input value={form.score} onChange={(event) => update("score", event.target.value)} />
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
          <input value={form.province} onChange={(event) => update("province", event.target.value)} />
        </label>
        <label>
          教材版本
          <input value={form.textbook} onChange={(event) => update("textbook", event.target.value)} />
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

      <label>
        想听的内容
        <textarea value={form.desiredContent} onChange={(event) => update("desiredContent", event.target.value)} rows={3} required />
      </label>
      <label>
        本地题目/资料路径
        <textarea value={form.localFiles} onChange={(event) => update("localFiles", event.target.value)} rows={2} />
      </label>
      <label>
        备注
        <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} rows={2} />
      </label>

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

function CourseDetail({
  course,
  onRefresh,
  onDeleteCourse,
  onError
}: {
  course: Course | null;
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
  const [refining, setRefining] = useState(false);
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialResults, setMaterialResults] = useState<RagSearchResult[]>([]);
  const [searchingMaterials, setSearchingMaterials] = useState(false);

  const selectedFile = files.find((file) => file.path === selectedPath) || files[0] || null;

  const loadFiles = useCallback(async () => {
    if (!course) return;
    const data = await api.get<{ files: CourseFile[] }>(`/api/courses/${course.id}/files`);
    setFiles(data.files);
    setSelectedPath((current) => {
      if (current && data.files.some((file) => file.path === current)) return current;
      return data.files[0]?.path || "";
    });
  }, [course]);

  const loadJob = useCallback(async () => {
    if (!course?.jobId) {
      setJob(null);
      setLogTail("");
      return;
    }
    const data = await api.get<{ job: Job; logTail: string }>(`/api/jobs/${course.jobId}`);
    setJob(data.job);
    setLogTail(data.logTail);
  }, [course]);

  const loadJobs = useCallback(async () => {
    if (!course) {
      setJobs([]);
      return;
    }
    const data = await api.get<{ jobs: Job[] }>(`/api/courses/${course.id}/jobs`);
    setJobs(data.jobs);
  }, [course]);

  useEffect(() => {
    setFiles([]);
    setSelectedPath("");
    setJobs([]);
    setManualQuality(null);
    setEditing(false);
    setRefineInstruction("");
    setMaterialQuery("");
    setMaterialResults([]);
    loadFiles().catch((err) => onError(err.message));
    loadJob().catch((err) => onError(err.message));
    loadJobs().catch((err) => onError(err.message));
  }, [course?.id, loadFiles, loadJob, loadJobs, onError]);

  const polling =
    course?.status === "running" ||
    course?.status === "queued" ||
    job?.status === "running" ||
    job?.status === "queued";
  useInterval(
    () => {
      loadFiles().catch((err) => onError(err.message));
      loadJob().catch((err) => onError(err.message));
      loadJobs().catch((err) => onError(err.message));
    },
    polling ? 4000 : null
  );

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
    setRefining(true);
    try {
      const data = await api.post<{ job: Job }>(`/api/courses/${course.id}/refine`, { instruction: refineInstruction });
      setJob(data.job);
      setLogTail("");
      setManualQuality(null);
      setRefineInstruction("");
      await onRefresh();
      await loadJobs();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefining(false);
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

  const currentQuality = job?.quality || manualQuality;
  const selectedMaterials = splitLocalFiles(course.localFiles);

  return (
    <section className="detail-panel">
      <header className="detail-header">
        <div>
          <span className={statusClass(course.status)}>{statusLabel(course.status)}</span>
          <h3>{course.desiredContent || "未命名课程"}</h3>
          <p>
            {course.type === "trial" ? "试听课" : "正式课"} · {course.grade || "年级待填"} · {course.durationMinutes} 分钟
          </p>
        </div>
        <div className="button-row">
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
          <button className="ghost-button" disabled={polling} onClick={() => setEditing((value) => !value)}>
            <SlidersHorizontal size={17} />
            编辑设置
          </button>
          <button className="ghost-button danger-button" disabled={polling} onClick={() => onDeleteCourse(course).catch((err) => onError(err.message))}>
            <Trash2 size={17} />
            删除课程
          </button>
          <button className="primary-button" disabled={busy || polling} onClick={runCourse}>
            {busy || polling ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            调用 Codex
          </button>
        </div>
      </header>

      <div className="meta-strip">
        <span>
          <CalendarClock size={15} />
          {formatDate(course.lessonTime)}
        </span>
        <span>{course.score || "分数待填"}</span>
        <span>{course.province || "地区待填"}</span>
        <span>{course.lessonKind || "课程性质待填"}</span>
      </div>

      {editing ? (
        <CourseSettingsPanel
          course={course}
          onSaved={onRefresh}
          onCancel={() => setEditing(false)}
          onError={onError}
        />
      ) : null}

      <div className="detail-grid">
        <section className="file-panel">
          <div className="panel-title">
            <FileText size={18} />
            <h4>产物</h4>
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
              <button type="button" className="ghost-button" disabled={searchingMaterials || polling} onClick={searchCourseMaterials}>
                {searchingMaterials ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
              </button>
            </div>
            {materialResults.length > 0 ? (
              <div className="material-pick-list compact">
                {materialResults.slice(0, 5).map((result) => (
                  <button
                    type="button"
                    key={result.material.path}
                    disabled={polling}
                    onClick={() => selectCourseMaterial(result.material.path)}
                  >
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
                    disabled={polling}
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
          <div className="file-list">
            {files.length === 0 ? (
              <div className="quiet-empty">等待生成文件</div>
            ) : (
              files.map((file) => (
                <div
                  key={file.path}
                  className={file.path === selectedFile?.path ? "file-row active" : "file-row"}
                >
                  <button className="file-select" onClick={() => setSelectedPath(file.path)}>
                    <span>{file.name}</span>
                    <small>{file.kind}</small>
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

          {currentQuality ? <QualityPanel quality={currentQuality} /> : null}

          {job ? (
            <div className="job-log">
              <div className="job-log-title">
                <span className={statusClass(job.status)}>{statusLabel(job.status)}</span>
                <small>{job.exitCode ?? ""}</small>
              </div>
              <pre>{logTail || "暂无日志"}</pre>
            </div>
          ) : null}

          {jobs.length > 0 ? <JobHistory jobs={jobs} /> : null}

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
            <button className="ghost-button" disabled={polling || refining || !refineInstruction.trim()}>
              {refining ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
              提交补充
            </button>
          </form>
        </section>

        <FilePreview file={selectedFile} />
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

function JobHistory({ jobs }: { jobs: Job[] }) {
  return (
    <section className="job-history">
      <strong>生成记录</strong>
      {jobs.slice(0, 6).map((historyJob, index) => (
        <div key={historyJob.id} className="history-row">
          <span className={statusClass(historyJob.status)}>{statusLabel(historyJob.status)}</span>
          <div>
            <small>
              {historyJob.refineInstruction ? "补充生成" : "首次生成"} · {formatDate(historyJob.createdAt)}
              {index === 0 ? " · 最新" : ""}
            </small>
            {historyJob.quality ? <small>质量评分 {historyJob.quality.score}</small> : null}
          </div>
        </div>
      ))}
    </section>
  );
}

function FilePreview({ file }: { file: CourseFile | null }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const markdownContent = useMemo(() => normalizeMarkdownMath(content), [content]);

  useEffect(() => {
    setContent("");
    setError("");
    if (!file || !["markdown", "text"].includes(file.kind)) return;
    api
      .get<{ content: string }>(`/api/files/content?path=${encodeURIComponent(file.path)}`)
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message));
  }, [file]);

  if (!file) {
    return (
      <section className="preview-panel empty-preview">
        <FileText size={26} />
        <h4>暂无可预览文件</h4>
      </section>
    );
  }

  const rawUrl = `/api/files/raw?path=${encodeURIComponent(file.path)}`;
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
      setUploadNotice(`已上传 ${allFiles.length} 个文件，已保存为待索引。需要检索这些新资料时，请点击“一键索引全库”。`);
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
  const browserEntries = useMemo(() => buildMaterialEntries(materials, uploadRoot, currentPath), [materials, uploadRoot, currentPath]);

  return (
    <section className="materials-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">资料库</p>
          <h2>本地 RAG 索引</h2>
          <span>{uploadRoot || "资料库/网页上传"}</span>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={reindex} disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
            一键索引全库
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

      <div className="stat-row">
        <div>
          <Boxes size={18} />
          <strong>{indexedCount}</strong>
          <span>已索引文件</span>
        </div>
        <div>
          <FileText size={18} />
          <strong>{chunkCount}</strong>
          <span>资料片段</span>
        </div>
      </div>

      {reindexJob ? (
        <section className="reindex-status">
          <div>
            <strong>
              {reindexJob.status === "running"
                ? "正在索引全库"
                : reindexJob.status === "completed"
                ? "全库索引完成"
                : reindexJob.status === "failed"
                ? "全库索引失败"
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
              <strong>{result.material.title}</strong>
              <small>{result.material.path}</small>
              <span className="result-reason">{result.reason}</span>
              <p>{result.excerpt}</p>
            </article>
          ))}
        </section>
      ) : null}

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
                    ? `${entry.material.chunkCount} 段`
                    : entry.material.status === "needs_conversion"
                    ? "待转换"
                    : entry.material.status === "pending"
                    ? "待索引"
                    : entry.material.status}
                  </span>
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
  );
}

function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
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
