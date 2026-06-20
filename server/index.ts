import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import {
  clearSessionCookie,
  createAdminUser,
  authMiddleware,
  setSessionCookie,
  updateUserCredentials,
  verifyPassword
} from "./auth.js";
import { backupFileName, createAppBackup } from "./backup.js";
import { config, ensureAppDirs, tempUploadDir, uploadRoot } from "./config.js";
import { createDiagnostics } from "./diagnostics.js";
import { syncCourseToFeishu } from "./feishuSync.js";
import { assertWithinWorkspace, listCourseFiles, uniqueDestination } from "./files.js";
import { onJobFinished } from "./jobEvents.js";
import { cancelCodexJob, createCodexJob, recoverInterruptedJobs, runCodexJob } from "./jobs.js";
import { assessCourseQuality } from "./quality.js";
import {
  clearRagIndexCache,
  deleteMaterialFile,
  deleteMaterialFolder,
  getMaterialRagPreview,
  getRagStats,
  indexMaterialFile,
  listMaterialCatalog,
  listMaterialFilesNeedingIndex,
  listMaterialCandidates,
  markMaterialIndexFailed,
  registerMaterialFile,
  resetMaterialRootIndex,
  searchRag
} from "./rag.js";
import { authRateLimit, clearAuthRateLimit, securityHeaders } from "./security.js";
import { Store, newId, nowIso, publicCourse, safeRelativeUploadPath, sanitizeFilename } from "./store.js";
import type { Course, CourseType, Student } from "./types.js";

ensureAppDirs();

const store = new Store();
recoverInterruptedJobs(store);
const currentFile = fileURLToPath(import.meta.url);
const serverDir = path.dirname(currentFile);
const ragWorkerPath = path.join(serverDir, "rag-worker.js");

const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
const upload = multer({
  dest: tempUploadDir,
  preservePath: true,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: config.maxUploadFiles
  }
});

app.use(securityHeaders);
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    }
  })
);

onJobFinished(syncCourseToFeishu);

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function requiredString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function routeParam(req: Request, name: string) {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function parseDuration(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 90;
  return Math.min(240, Math.max(20, Math.round(parsed)));
}

function lessonDateSlug(lessonTime: string) {
  if (lessonTime) return lessonTime.replace("T", "_").replace(/:/g, "-").slice(0, 16);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function makeOutputDir(studentName: string, courseType: CourseType, lessonTime: string, desiredContent: string) {
  const typeLabel = courseType === "trial" ? "试听课" : "正式课";
  const studentDir = path.join(config.workspaceRoot, sanitizeFilename(studentName, "学生"));
  const topic = sanitizeFilename(desiredContent || "备课", "备课");
  const baseName = `${lessonDateSlug(lessonTime)}_${typeLabel}_${topic}`;
  let outputDir = path.join(studentDir, baseName);
  let counter = 1;
  while (fs.existsSync(outputDir)) {
    outputDir = path.join(studentDir, `${baseName}-${counter}`);
    counter += 1;
  }
  return outputDir;
}

function readTail(filePath: string, maxChars = 12000) {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxChars * 2);
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  return buffer.toString("utf8").slice(-maxChars);
}

function uniqueNestedDestination(root: string, originalName: string) {
  const relative = safeRelativeUploadPath(originalName);
  const destination = assertWithinWorkspace(path.join(root, relative));
  const relativeToRoot = path.relative(root, destination);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Invalid upload path.");
  }
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  return uniqueDestination(parent, path.basename(destination));
}

function courseHasActiveJob(course: Course) {
  const job = course.jobId ? store.findJob(course.jobId) : null;
  return job?.status === "running" || job?.status === "queued";
}

function appendCourseLocalFiles(course: Course, paths: string[]) {
  const existing = new Set(
    course.localFiles
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  for (const filePath of paths) {
    if (filePath.trim()) existing.add(filePath.trim());
  }
  course.localFiles = [...existing].join("\n");
  course.updatedAt = nowIso();
}

function removeCourseLocalFiles(course: Course, paths: string[]) {
  const removing = new Set(paths.map((item) => item.trim()).filter(Boolean));
  course.localFiles = course.localFiles
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !removing.has(item))
    .join("\n");
  course.updatedAt = nowIso();
}

const ragReindexJob = {
  status: "idle" as "idle" | "running" | "completed" | "failed",
  total: 0,
  processed: 0,
  current: "",
  indexed: 0,
  error: "",
  startedAt: "",
  endedAt: ""
};
let ragIncrementalRequested = false;

function publicRagReindexJob() {
  return { ...ragReindexJob };
}

function runRagWorker(filePath: string) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=192", ragWorkerPath, filePath], {
      cwd: config.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = stderr.trim();
      resolve({
        ok: false,
        error: `worker ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`
      });
    });
  });
}

async function indexMaterialCandidates(candidates: string[], failures: string[]) {
  ragReindexJob.total += candidates.length;
  for (const filePath of candidates) {
    ragReindexJob.current = filePath;
    const result = await runRagWorker(filePath);
    store.reload();
    clearRagIndexCache();
    ragReindexJob.processed += 1;
    if (result.ok) {
      ragReindexJob.indexed += 1;
    } else {
      const error = result.error || "索引进程失败";
      try {
        markMaterialIndexFailed(store, filePath, error);
        store.reload();
        clearRagIndexCache();
      } catch {
        // Keep the indexing job moving even if recording the failed file fails.
      }
      failures.push(`${path.basename(filePath)}: ${error}`);
    }
  }
}

function resetRagJob() {
  Object.assign(ragReindexJob, {
    status: "running",
    total: 0,
    processed: 0,
    current: "",
    indexed: 0,
    error: "",
    startedAt: nowIso(),
    endedAt: ""
  });
}

async function startRagReindexJob(alreadyStarted = false) {
  if (ragReindexJob.status === "running" && !alreadyStarted) return;
  if (!alreadyStarted) resetRagJob();
  try {
    store.reload();
    clearRagIndexCache();
    const materialRoot = path.join(config.workspaceRoot, "资料库");
    const candidates = listMaterialCandidates(materialRoot);
    resetMaterialRootIndex(store, materialRoot);
    store.reload();
    clearRagIndexCache();
    const failures: string[] = [];
    await indexMaterialCandidates(candidates, failures);
    ragReindexJob.error = failures.length > 0 ? `${failures.length} 个文件索引失败：${failures.slice(0, 3).join("；")}` : "";
    ragReindexJob.status = "completed";
    ragReindexJob.endedAt = nowIso();
  } catch (error) {
    ragReindexJob.status = "failed";
    ragReindexJob.error = error instanceof Error ? error.message : String(error);
    ragReindexJob.endedAt = nowIso();
  } finally {
    ragReindexJob.current = "";
    if (ragIncrementalRequested) {
      ragIncrementalRequested = false;
      void startRagIncrementalJob();
    }
  }
}

async function startRagIncrementalJob() {
  if (ragReindexJob.status === "running") {
    ragIncrementalRequested = true;
    return;
  }
  resetRagJob();
  try {
    const failures: string[] = [];
    do {
      ragIncrementalRequested = false;
      store.reload();
      clearRagIndexCache();
      const candidates = listMaterialFilesNeedingIndex(store, path.join(config.workspaceRoot, "资料库"));
      await indexMaterialCandidates(candidates, failures);
    } while (ragIncrementalRequested);
    ragReindexJob.error = failures.length > 0 ? `${failures.length} 个文件索引失败：${failures.slice(0, 3).join("；")}` : "";
    ragReindexJob.status = "completed";
    ragReindexJob.endedAt = nowIso();
  } catch (error) {
    ragReindexJob.status = "failed";
    ragReindexJob.error = error instanceof Error ? error.message : String(error);
    ragReindexJob.endedAt = nowIso();
  } finally {
    ragReindexJob.current = "";
  }
}

app.get("/api/system", (req, res) => {
  const ragStats = getRagStats(store);
  res.json({
    setupRequired: store.data.users.length === 0,
    workspaceRoot: config.workspaceRoot,
    codexAutoRun: config.codexAutoRun,
    codexRunner: config.codexRunner,
    ragChunkCount: ragStats.chunks,
    ragQuestionCount: ragStats.questions,
    ragSnippetCount: ragStats.snippets
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    workspaceRoot: config.workspaceRoot,
    codexRunner: config.codexRunner
  });
});

app.post(
  "/api/setup",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const username = requiredString(req.body.username);
    const password = requiredString(req.body.password);
    if (store.data.users.length > 0) {
      res.status(409).json({ error: "Setup has already been completed." });
      return;
    }
    if (username.length < 2 || password.length < 8) {
      res.status(400).json({ error: "Username must be at least 2 chars and password at least 8 chars." });
      return;
    }
    const user = await createAdminUser(store, username, password);
    clearAuthRateLimit(req);
    setSessionCookie(res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  })
);

app.post(
  "/api/login",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const username = requiredString(req.body.username);
    const password = requiredString(req.body.password);
    const user = await verifyPassword(store, username, password);
    if (!user) {
      res.status(401).json({ error: "用户名或密码不正确。" });
      return;
    }
    clearAuthRateLimit(req);
    setSessionCookie(res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  })
);

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

const requireAuth = authMiddleware(store);

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: res.locals.user });
});

app.patch(
  "/api/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await updateUserCredentials(
      store,
      res.locals.user.id,
      requiredString(req.body.currentPassword),
      requiredString(req.body.username),
      requiredString(req.body.newPassword)
    );
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    setSessionCookie(res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  })
);

app.get(
  "/api/admin/backup",
  requireAuth,
  asyncHandler(async (req, res) => {
    const buffer = await createAppBackup(store);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${backupFileName()}"`);
    res.send(buffer);
  })
);

app.get("/api/admin/diagnostics", requireAuth, (req, res) => {
  res.json({ diagnostics: createDiagnostics(store) });
});

app.get("/api/students", requireAuth, (req, res) => {
  const coursesByStudent = new Map<string, number>();
  for (const course of store.data.courses) {
    coursesByStudent.set(course.studentId, (coursesByStudent.get(course.studentId) || 0) + 1);
  }
  res.json({
    students: store.data.students
      .map((student) => ({ ...student, courseCount: coursesByStudent.get(student.id) || 0 }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  });
});

app.post("/api/students", requireAuth, (req, res) => {
  const name = requiredString(req.body.name);
  if (!name) {
    res.status(400).json({ error: "学生姓名不能为空。" });
    return;
  }
  const now = nowIso();
  const student = {
    id: newId("stu"),
    name,
    stage: requiredString(req.body.stage),
    notes: requiredString(req.body.notes),
    createdAt: now,
    updatedAt: now
  };
  store.addStudent(student);
  fs.mkdirSync(path.join(config.workspaceRoot, sanitizeFilename(student.name, "学生")), { recursive: true });
  res.json({ student });
});

function updateStudentFromBody(student: Student, body: Record<string, unknown>) {
  const allowedStringFields = [
    "name",
    "stage",
    "notes",
    "weakPoints",
    "commonMistakes",
    "parentNotes",
    "nextLessonSuggestion"
  ] as const;
  for (const field of allowedStringFields) {
    if (field in body) student[field] = requiredString(body[field]);
  }
  student.updatedAt = nowIso();
}

app.patch("/api/students/:studentId", requireAuth, (req, res) => {
  const student = store.findStudent(routeParam(req, "studentId"));
  if (!student) {
    res.status(404).json({ error: "Student not found." });
    return;
  }
  if ("name" in req.body && !requiredString(req.body.name)) {
    res.status(400).json({ error: "学生姓名不能为空。" });
    return;
  }
  updateStudentFromBody(student, req.body);
  store.save();
  res.json({ student });
});

app.delete("/api/students/:studentId", requireAuth, (req, res) => {
  const student = store.findStudent(routeParam(req, "studentId"));
  if (!student) {
    res.status(404).json({ error: "Student not found." });
    return;
  }
  const courses = store.data.courses.filter((course) => course.studentId === student.id);
  if (courses.some(courseHasActiveJob)) {
    res.status(409).json({ error: "该学生有课程正在生成，暂时不能删除。" });
    return;
  }
  store.deleteStudent(student.id);
  res.json({ ok: true });
});

app.get("/api/students/:studentId/courses", requireAuth, (req, res) => {
  const student = store.findStudent(routeParam(req, "studentId"));
  if (!student) {
    res.status(404).json({ error: "Student not found." });
    return;
  }
  res.json({
    courses: store.data.courses
      .filter((course) => course.studentId === student.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicCourse)
  });
});

app.post("/api/students/:studentId/courses", requireAuth, (req, res) => {
  const student = store.findStudent(routeParam(req, "studentId"));
  if (!student) {
    res.status(404).json({ error: "Student not found." });
    return;
  }

  const type = req.body.type === "trial" ? "trial" : "formal";
  const lessonTime = requiredString(req.body.lessonTime);
  const desiredContent = requiredString(req.body.desiredContent);
  const now = nowIso();
  const outputDir = makeOutputDir(student.name, type, lessonTime, desiredContent);
  fs.mkdirSync(outputDir, { recursive: true });

  const course: Course = {
    id: newId("course"),
    studentId: student.id,
    type,
    stage: requiredString(req.body.stage, student.stage || "高中数学"),
    grade: requiredString(req.body.grade),
    score: requiredString(req.body.score),
    province: requiredString(req.body.province),
    textbook: requiredString(req.body.textbook),
    lessonKind: requiredString(req.body.lessonKind),
    desiredContent,
    lessonTime,
    durationMinutes: parseDuration(req.body.durationMinutes),
    localFiles: requiredString(req.body.localFiles),
    notes: requiredString(req.body.notes),
    outputDir,
    status: "draft",
    createdAt: now,
    updatedAt: now
  };

  store.addCourse(course);
  student.updatedAt = now;
  store.save();

  let job = null;
  const shouldRun = req.body.autoRun !== false && config.codexAutoRun;
  if (shouldRun) {
    job = createCodexJob(store, course);
    runCodexJob(store, job.id);
  }

  res.json({ course: publicCourse(course), job });
});

function updateCourseFromBody(course: Course, body: Record<string, unknown>) {
  const allowedStringFields = [
    "stage",
    "grade",
    "score",
    "province",
    "textbook",
    "lessonKind",
    "desiredContent",
    "lessonTime",
    "localFiles",
    "notes"
  ] as const;
  for (const field of allowedStringFields) {
    if (field in body) {
      course[field] = requiredString(body[field]);
    }
  }
  if ("durationMinutes" in body) {
    course.durationMinutes = parseDuration(body.durationMinutes);
  }
  if (body.type === "trial" || body.type === "formal") {
    course.type = body.type;
  }
  course.updatedAt = nowIso();
}

app.get("/api/courses/:courseId", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  res.json({ course: publicCourse(course) });
});

app.patch("/api/courses/:courseId", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能修改设置。" });
    return;
  }
  updateCourseFromBody(course, req.body);
  store.save();
  res.json({ course: publicCourse(course) });
});

app.delete("/api/courses/:courseId", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能删除。" });
    return;
  }
  store.deleteCourse(course.id);
  res.json({ ok: true });
});

app.post("/api/courses/:courseId/run", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  const runningJob = course.jobId ? store.findJob(course.jobId) : null;
  if (runningJob?.status === "running" || runningJob?.status === "queued") {
    res.status(409).json({ error: "This course already has a running job." });
    return;
  }
  const job = createCodexJob(store, course);
  runCodexJob(store, job.id);
  res.json({ job, course: publicCourse(course) });
});

app.post("/api/courses/:courseId/refine", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  const runningJob = course.jobId ? store.findJob(course.jobId) : null;
  if (runningJob?.status === "running" || runningJob?.status === "queued") {
    res.status(409).json({ error: "This course already has a running job." });
    return;
  }
  const instruction = requiredString(req.body.instruction);
  if (!instruction) {
    res.status(400).json({ error: "请填写需要补充或修改的要求。" });
    return;
  }
  const job = createCodexJob(store, course, { refineInstruction: instruction });
  runCodexJob(store, job.id);
  res.json({ job, course: publicCourse(course) });
});

app.post(
  "/api/courses/:courseId/attachments",
  requireAuth,
  upload.array("files"),
  asyncHandler(async (req, res) => {
    const course = store.findCourse(routeParam(req, "courseId"));
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const files = (req.files || []) as Express.Multer.File[];
    const attachmentsDir = path.join(course.outputDir, "_attachments");
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const saved: string[] = [];
    for (const file of files) {
      const destination = uniqueNestedDestination(attachmentsDir, file.originalname);
      await fs.promises.rename(file.path, destination);
      saved.push(destination);
    }
    appendCourseLocalFiles(course, saved);
    store.save();
    res.json({ files: saved, course: publicCourse(course) });
  })
);

app.post("/api/courses/:courseId/materials/select", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能修改资料选择。" });
    return;
  }
  const rawPaths: unknown[] = Array.isArray(req.body.paths) ? req.body.paths : [];
  const selected = rawPaths
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .map((value) => assertWithinWorkspace(value));
  appendCourseLocalFiles(course, selected);
  store.save();
  res.json({ course: publicCourse(course), selected });
});

app.post("/api/courses/:courseId/materials/remove", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能修改资料选择。" });
    return;
  }
  const rawPaths: unknown[] = Array.isArray(req.body.paths) ? req.body.paths : [];
  const selected = rawPaths
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  removeCourseLocalFiles(course, selected);
  store.save();
  res.json({ course: publicCourse(course), removed: selected });
});

app.get("/api/courses/:courseId/files", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  res.json({ files: listCourseFiles(course.outputDir) });
});

app.get("/api/courses/:courseId/jobs", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  const jobs = store.data.jobs
    .filter((job) => job.courseId === course.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ jobs });
});

app.post("/api/courses/:courseId/quality", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  const quality = assessCourseQuality(course);
  const job = course.jobId ? store.findJob(course.jobId) : null;
  if (job) job.quality = quality;
  store.save();
  res.json({ quality, job });
});

app.get("/api/jobs/:jobId", requireAuth, (req, res) => {
  const job = store.findJob(routeParam(req, "jobId"));
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  res.json({
    job,
    logTail: readTail(job.logPath)
  });
});

app.post("/api/jobs/:jobId/cancel", requireAuth, (req, res) => {
  const result = cancelCodexJob(store, routeParam(req, "jobId"));
  if (!result.ok) {
    res.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  res.json(result);
});

app.get("/api/files/content", requireAuth, (req, res) => {
  const filePath = requiredString(req.query.path);
  const resolved = assertWithinWorkspace(filePath);
  const stat = fs.statSync(resolved);
  if (stat.size > 5 * 1024 * 1024) {
    res.status(413).json({ error: "File is too large to preview as text." });
    return;
  }
  res.json({ content: fs.readFileSync(resolved, "utf8") });
});

app.get("/api/files/raw", requireAuth, (req, res) => {
  const filePath = requiredString(req.query.path);
  const resolved = assertWithinWorkspace(filePath);
  res.sendFile(resolved);
});

app.get("/api/materials", requireAuth, (req, res) => {
  const ragStats = getRagStats(store);
  const materials = listMaterialCatalog(store);
  res.json({
    materials: materials.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    chunkCount: ragStats.chunks,
    stats: ragStats,
    uploadRoot
  });
});

app.get("/api/materials/:materialId/preview", requireAuth, (req, res) => {
  const preview = getMaterialRagPreview(store, routeParam(req, "materialId"));
  if (!preview) {
    res.status(404).json({ error: "Material not found." });
    return;
  }
  res.json(preview);
});

app.post(
  "/api/materials/upload",
  requireAuth,
  upload.array("files"),
  asyncHandler(async (req, res) => {
    const files = (req.files || []) as Express.Multer.File[];
    fs.mkdirSync(uploadRoot, { recursive: true });
    const materials = [];
    for (const file of files) {
      const destination = uniqueNestedDestination(uploadRoot, file.originalname);
      await fs.promises.rename(file.path, destination);
      materials.push(registerMaterialFile(store, destination, file.mimetype));
    }
    void startRagIncrementalJob();
    const ragStats = getRagStats(store);
    res.json({ materials, queued: materials.length, chunkCount: ragStats.chunks, stats: ragStats, job: publicRagReindexJob() });
  })
);

app.post(
  "/api/materials/reindex",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (ragReindexJob.status !== "running") {
      resetRagJob();
      setImmediate(() => {
        void startRagReindexJob(true);
      });
    }
    res.json({ job: publicRagReindexJob(), stats: getRagStats(store) });
  })
);

app.get("/api/materials/reindex", requireAuth, (req, res) => {
  res.json({ job: publicRagReindexJob(), stats: getRagStats(store) });
});

app.get("/api/materials/convert-doc", requireAuth, (req, res) => {
  const docMaterials = store.data.materials.filter((material) => material.status === "needs_conversion" || material.path.toLowerCase().endsWith(".doc"));
  res.json({
    count: docMaterials.length,
    materials: docMaterials,
    message: "旧版 .doc 暂不在服务器内自动转换。请用 Word/WPS/LibreOffice 批量另存为 .docx，然后回到资料库点击一键索引全库。"
  });
});

app.delete(
  "/api/materials/folder",
  requireAuth,
  asyncHandler(async (req, res) => {
    const folderPath = requiredString(req.query.path);
    const deleted = await deleteMaterialFolder(store, folderPath);
    if (!deleted) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    const ragStats = getRagStats(store);
    res.json({ deleted, chunkCount: ragStats.chunks, stats: ragStats });
  })
);

app.delete(
  "/api/materials/:materialId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const deleted = await deleteMaterialFile(store, routeParam(req, "materialId"));
    if (!deleted) {
      res.status(404).json({ error: "Material not found." });
      return;
    }
    const ragStats = getRagStats(store);
    res.json({ deleted, chunkCount: ragStats.chunks, stats: ragStats });
  })
);

app.get("/api/materials/search", requireAuth, (req, res) => {
  const query = requiredString(req.query.q);
  res.json({ results: searchRag(store, query, 12) });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `API not found: ${req.method} ${req.originalUrl}` });
});

async function attachFrontend() {
  if (process.env.NODE_ENV === "production" || config.runningFromDist) {
    const clientDir = path.join(config.projectRoot, "dist", "client");
    app.use(express.static(clientDir));
    app.get(/.*/, (req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
    return;
  }

  const { createServer } = await import("vite");
  const vite = await createServer({
    root: config.projectRoot,
    server: { middlewareMode: true },
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use(/.*/, async (req, res, next) => {
    try {
      const templatePath = path.join(config.projectRoot, "index.html");
      const template = fs.readFileSync(templatePath, "utf8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (error) {
      vite.ssrFixStacktrace(error as Error);
      next(error);
    }
  });
}

await attachFrontend();

app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const anyError = error as Error & { code?: string };
  if (anyError.code === "LIMIT_FILE_COUNT") {
    res.status(413).json({ error: `一次上传文件数量超过限制，目前上限是 ${config.maxUploadFiles} 个。可在 .env 里修改 MAX_UPLOAD_FILES。` });
    return;
  }
  if (anyError.name === "SyntaxError" && "body" in anyError) {
    res.status(400).json({ error: "请求 JSON 格式不正确。" });
    return;
  }
  res.status(500).json({ error: error.message });
});

app.listen(config.port, () => {
  console.log(`Lesson prep web is running at http://localhost:${config.port}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
});
