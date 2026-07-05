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
import { recoverCourseOutputDir } from "./courseOutput.js";
import { assertWithinWorkspace, listCourseFiles, uniqueDestination } from "./files.js";
import { onJobFinished } from "./jobEvents.js";
import { cancelCodexJob, createCodexJob, recoverInterruptedJobs, runCodexJob } from "./jobs.js";
import { assessCourseQuality } from "./quality.js";
import {
  clearRagIndexCache,
  checkpointRagIndex,
  deleteMaterialFile,
  deleteMaterialFolder,
  getMaterialRagPreview,
  getRagStats,
  indexMaterialFile,
  ensureMaterialEmbeddings,
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
    fileSize: config.maxUploadFileBytes,
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

function normalizeLessonTime(value: unknown) {
  const raw = requiredString(value);
  if (!raw) return "";
  const year = new Date().getFullYear();
  const pad = (input: string | number) => String(input).padStart(2, "0");
  const isoLike = raw.match(/^\d{4}-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2}))?/);
  if (isoLike) {
    return `${year}-${pad(isoLike[1])}-${pad(isoLike[2])}T${pad(isoLike[3] || "00")}:${pad(isoLike[4] || "00")}`;
  }
  const monthDay = raw.match(/(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?(?:\s*(\d{1,2})[:：点时](\d{2})?)?/);
  if (monthDay) {
    return `${year}-${pad(monthDay[1])}-${pad(monthDay[2])}T${pad(monthDay[3] || "00")}:${pad(monthDay[4] || "00")}`;
  }
  const relativeDay = /(今天|明天|后天)/.exec(raw)?.[1];
  if (relativeDay) {
    const date = new Date();
    if (relativeDay === "明天") date.setDate(date.getDate() + 1);
    if (relativeDay === "后天") date.setDate(date.getDate() + 2);
    const time = raw.match(/(\d{1,2})[:：点时](\d{2})?/);
    const hours = time?.[1] || "00";
    const minutes = time?.[2] || "00";
    return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hours)}:${pad(minutes)}`;
  }
  return "";
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

function firstMatch(input: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    const value = match?.[1]?.trim();
    if (value) return value.replace(/[，。；;,.]$/, "").trim();
  }
  return "";
}

function inferCourseType(input: string): CourseType {
  if (/试听|体验|试讲|转化|首课/.test(input)) return "trial";
  return "formal";
}

function inferStage(input: string) {
  if (/初中|初一|初二|初三|七年级|八年级|九年级|中考/.test(input)) return "初中数学";
  if (/高等数学|大学数学/.test(input)) return "高等数学";
  return "高中数学";
}

function inferGrade(input: string) {
  return firstMatch(input, [
    /(高一|高二|高三|初一|初二|初三|七年级|八年级|九年级)/,
    /年级[:：\s]*(高一|高二|高三|初一|初二|初三|七年级|八年级|九年级)/
  ]);
}

function inferLessonKind(input: string) {
  if (/错题|复盘/.test(input)) return "错题复盘";
  if (/同步|校内|作业/.test(input)) return "同步巩固";
  if (/培优|拔高|拓展|竞赛/.test(input)) return "培优拓展";
  if (/冲刺|考前|一模|二模|期末|期中/.test(input)) return "考前冲刺";
  if (/答疑/.test(input)) return "作业答疑";
  return "专题提升";
}

function inferDuration(input: string) {
  const value = firstMatch(input, [/(\d{2,3})\s*(?:分钟|min)/i, /课长[:：\s]*(\d{2,3})/]);
  return parseDuration(value || (inferCourseType(input) === "trial" ? 60 : 90));
}

function inferLocalFiles(input: string) {
  return [...new Set(
    [...input.matchAll(/(?:\/root|~\/|\.\/)[^\s，。；;,]+/g)]
      .map((match) => match[0].trim())
      .filter(Boolean)
  )].join("\n");
}

function stripKnownLabels(input: string) {
  return input
    .replace(/学生[:：][^\n，。；;]+/g, "")
    .replace(/姓名[:：][^\n，。；;]+/g, "")
    .replace(/年级[:：][^\n，。；;]+/g, "")
    .replace(/分数[:：][^\n，。；;]+/g, "")
    .replace(/地区[:：][^\n，。；;]+/g, "")
    .replace(/教材[:：][^\n，。；;]+/g, "")
    .replace(/课长[:：][^\n，。；;]+/g, "")
    .replace(/时间[:：][^\n，。；;]+/g, "")
    .trim();
}

function createLessonDraftFromText(input: string) {
  const text = input.replace(/\r\n/g, "\n").trim();
  const studentName =
    firstMatch(text, [
      /学生(?:姓名)?[:：\s]*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{0,12})/,
      /姓名[:：\s]*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{0,12})/,
      /给([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{0,12})(?:同学)?(?:上|备|做|安排)/
    ]) || "待命名学生";
  const desiredContent =
    firstMatch(text, [
      /(?:想听|准备|备课内容|内容|专题|讲|学|复习|上)[:：\s]*([^\n。；;]{2,80})/,
      /(?:讲|复习|巩固|提升)([^\n。；;]{2,60})/
    ]) || stripKnownLabels(text).slice(0, 80) || "待确认备课内容";

  return {
    student: {
      name: studentName,
      stage: inferStage(text),
      notes: firstMatch(text, [/(?:学生情况|学生画像|备注)[:：\s]*([^\n]+)/]) || stripKnownLabels(text).slice(0, 300),
      weakPoints: firstMatch(text, [/(?:薄弱点|弱点|薄弱|不会|不熟|卡点)[:：\s]*([^\n]+)/]),
      commonMistakes: firstMatch(text, [/(?:常错|易错|错题|错误|问题)[:：\s]*([^\n]+)/]),
      parentNotes: firstMatch(text, [/(?:家长|沟通|老师反馈|反馈)[:：\s]*([^\n]+)/]),
      nextLessonSuggestion: firstMatch(text, [/(?:下次课|后续|以后|下一步)[:：\s]*([^\n]+)/])
    },
    course: {
      type: inferCourseType(text),
      stage: inferStage(text),
      grade: inferGrade(text),
      score: firstMatch(text, [/(?:分数|成绩|水平)[:：\s]*([^\n，。；;]+)/]),
      province: firstMatch(text, [/(?:地区|省市|试卷)[:：\s]*([^\n，。；;]+)/, /(新高考\s*[一二三IⅡIII]+卷?)/i]),
      textbook: firstMatch(text, [/(?:教材|版本)[:：\s]*([^\n，。；;]+)/]),
      lessonKind: inferLessonKind(text),
      desiredContent,
      lessonTime: normalizeLessonTime(firstMatch(text, [/(?:上课时间|时间|日期)[:：\s]*([^\n，。；;]+)/])),
      durationMinutes: inferDuration(text),
      localFiles: inferLocalFiles(text),
      notes: [
        "原始沟通/题目材料：",
        text,
        "",
        "请正式备课时从以上材料中提炼：本次课核心知识点、题目暴露的问题、讲解顺序、例题与变式、课堂检测和课后反馈重点。"
      ].join("\n")
    }
  };
}

function jsonFromModelText(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const raw = fenced || text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI did not return JSON.");
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

function pickString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function pickCourseType(value: unknown, fallback: CourseType): CourseType {
  return value === "trial" || /试听|体验/.test(String(value)) ? "trial" : value === "formal" || /正式/.test(String(value)) ? "formal" : fallback;
}

function mergeAiLessonDraft(input: string, ai: Record<string, unknown>) {
  const fallback = createLessonDraftFromText(input);
  const student = (ai.student || {}) as Record<string, unknown>;
  const course = (ai.course || {}) as Record<string, unknown>;
  return {
    student: {
      name: pickString(student.name) || fallback.student.name,
      stage: pickString(student.stage) || fallback.student.stage,
      notes: pickString(student.notes) || fallback.student.notes,
      weakPoints: pickString(student.weakPoints) || fallback.student.weakPoints,
      commonMistakes: pickString(student.commonMistakes) || fallback.student.commonMistakes,
      parentNotes: pickString(student.parentNotes) || fallback.student.parentNotes,
      nextLessonSuggestion: pickString(student.nextLessonSuggestion) || fallback.student.nextLessonSuggestion
    },
    course: {
      type: pickCourseType(course.type, fallback.course.type),
      stage: pickString(course.stage) || fallback.course.stage,
      grade: pickString(course.grade) || fallback.course.grade,
      score: pickString(course.score) || fallback.course.score,
      province: pickString(course.province) || fallback.course.province,
      textbook: pickString(course.textbook) || fallback.course.textbook,
      lessonKind: pickString(course.lessonKind) || fallback.course.lessonKind,
      desiredContent: pickString(course.desiredContent) || fallback.course.desiredContent,
      lessonTime: normalizeLessonTime(course.lessonTime) || fallback.course.lessonTime,
      durationMinutes: parseDuration(course.durationMinutes || fallback.course.durationMinutes),
      localFiles: pickString(course.localFiles) || fallback.course.localFiles,
      notes: pickString(course.notes) || fallback.course.notes
    }
  };
}

async function createLessonDraft(input: string) {
  if (config.lessonDraftAiProvider.toLowerCase() !== "ark" || !config.lessonDraftAiApiKey) {
    return createLessonDraftFromText(input);
  }
  try {
    const response = await fetch(config.lessonDraftAiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.lessonDraftAiApiKey}`
      },
      body: JSON.stringify({
        model: config.lessonDraftAiModel,
        messages: [
          {
            role: "system",
            content:
              [
                "你是备课需求结构化助手。只输出 JSON，不要解释。",
                "字段：student{name,stage,notes,weakPoints,commonMistakes,parentNotes,nextLessonSuggestion}, course{type,stage,grade,score,province,textbook,lessonKind,desiredContent,lessonTime,durationMinutes,localFiles,notes}。",
                "type 只能是 formal 或 trial。lessonTime 若用户没有明确日期时间就留空。localFiles 多路径用换行。",
                "用户输入通常会混合家长沟通、其他老师反馈、学生原题/错题、截图 OCR 文本、临时想法和备课要求。你需要先理解原始材料，再结构化。",
                "student.notes 写学生长期画像，例如学习习惯、课堂状态、接受能力、沟通方式、已知背景；weakPoints 写知识薄弱点；commonMistakes 写从题目和反馈中暴露出的常错题型、典型错误、方法问题；parentNotes 写家长或其他老师的原始诉求和关注点；nextLessonSuggestion 写后续连续课建议。",
                "desiredContent 要归纳成本次课最核心的备课主题，不能太散；course.notes 写本次备课的详细要求，必须保留题目内容或题目特征、课堂重点、讲解顺序、难度梯度、例题/变式/检测需求、产物要求、注意事项。",
                "如果原文只给了零散题目，你要从题目反推知识点、能力缺口和本次课应该怎么讲；如果信息不足，可以在 course.notes 里列出需要老师确认的问题，但不要编造学生事实。",
                "course.notes 建议用短条目组织，保证正式调用 Codex 时可以直接作为备课任务依据。"
              ].join("\n")
          },
          { role: "user", content: input }
        ],
        temperature: 0.1
      })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Ark draft parse failed: ${response.status}`);
    const payload = responseText ? JSON.parse(responseText) : {};
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Ark draft parse returned empty content.");
    return mergeAiLessonDraft(input, jsonFromModelText(content));
  } catch {
    return createLessonDraftFromText(input);
  }
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

function recoverCourseOutputForRequest(course: Course) {
  const job = course.jobId ? store.findJob(course.jobId) : undefined;
  const recovery = recoverCourseOutputDir(course, job);
  if (recovery.changed) {
    console.warn(`[course-output] ${recovery.reason}`);
    store.save();
  }
  return recovery;
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

function logRagReindex(message: string, details?: Record<string, unknown>) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  const line = `[rag-reindex] ${nowIso()} ${message}${suffix}`;
  console.log(line);
  try {
    const logPath = path.join(config.dataDir, "logs", "rag-reindex.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    // Logging should never interrupt the indexing queue.
  }
}

function runRagWorker(filePath: string) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const workerHeapMb = Math.max(256, Math.floor(config.ragWorkerMaxOldSpaceMb));
    const child = spawn(process.execPath, [`--max-old-space-size=${workerHeapMb}`, ragWorkerPath, filePath], {
      cwd: config.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, config.ragWorkerTimeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = stderr.trim();
      resolve({
        ok: false,
        error: signal === "SIGKILL"
          ? `worker timeout after ${Math.round(config.ragWorkerTimeoutMs / 1000)}s${detail ? `: ${detail}` : ""}`
          : `worker ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`
      });
    });
  });
}

async function indexMaterialCandidates(candidates: string[], failures: string[]) {
  ragReindexJob.total += candidates.length;
  logRagReindex("batch-start", { count: candidates.length, total: ragReindexJob.total });
  for (const filePath of candidates) {
    ragReindexJob.current = filePath;
    const startedAt = Date.now();
    logRagReindex("file-start", {
      processed: ragReindexJob.processed,
      total: ragReindexJob.total,
      file: filePath
    });
    const result = await runRagWorker(filePath);
    store.reload();
    clearRagIndexCache();
    ragReindexJob.processed += 1;
    const elapsedMs = Date.now() - startedAt;
    if (result.ok) {
      ragReindexJob.indexed += 1;
      logRagReindex("file-indexed", {
        processed: ragReindexJob.processed,
        total: ragReindexJob.total,
        elapsedMs,
        file: filePath
      });
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
      logRagReindex("file-failed", {
        processed: ragReindexJob.processed,
        total: ragReindexJob.total,
        elapsedMs,
        file: filePath,
        error
      });
    }
  }
  logRagReindex("batch-end", {
    processed: ragReindexJob.processed,
    total: ragReindexJob.total,
    indexed: ragReindexJob.indexed,
    failures: failures.length
  });
  try {
    const checkpoint = checkpointRagIndex();
    logRagReindex("wal-checkpoint", { mode: "TRUNCATE", result: checkpoint });
  } catch (error) {
    logRagReindex("wal-checkpoint-failed", {
      mode: "TRUNCATE",
      error: error instanceof Error ? error.message : String(error)
    });
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

async function startRagIncrementalJob(alreadyStarted = false) {
  if (ragReindexJob.status === "running" && !alreadyStarted) {
    ragIncrementalRequested = true;
    return;
  }
  if (!alreadyStarted) resetRagJob();
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

async function startRagEmbeddingJob(materialId = "") {
  if (ragReindexJob.status === "running") return;
  resetRagJob();
  try {
    store.reload();
    clearRagIndexCache();
    const materials = listMaterialCatalog(store)
      .filter((material) => material.status === "indexed" && (!materialId || material.id === materialId));
    ragReindexJob.total = materials.length;
    for (const material of materials) {
      ragReindexJob.current = material.path;
      logRagReindex("embedding-start", { material: material.path });
      const result = await ensureMaterialEmbeddings(store, material.id, (progress) => {
        ragReindexJob.current = `${material.path} (${progress.processed}/${progress.total})`;
      });
      ragReindexJob.processed += 1;
      ragReindexJob.indexed += result.created;
      logRagReindex("embedding-done", {
        material: material.path,
        total: result.total,
        existing: result.existing,
        created: result.created,
        embeddings: result.embeddings
      });
    }
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

app.post(
  "/api/ai-drafts/lesson",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = requiredString(req.body.input);
    if (input.length < 4) {
      res.status(400).json({ error: "请先输入备课需求。" });
      return;
    }
    const draft = await createLessonDraft(input);
    const now = nowIso();
    const student: Student = {
      id: "draft_student",
      name: draft.student.name,
      stage: draft.student.stage,
      notes: draft.student.notes,
      weakPoints: draft.student.weakPoints,
      commonMistakes: draft.student.commonMistakes,
      parentNotes: draft.student.parentNotes,
      nextLessonSuggestion: draft.student.nextLessonSuggestion,
      createdAt: now,
      updatedAt: now
    };
    const course: Course = {
      id: "draft_course",
      studentId: student.id,
      type: draft.course.type,
      stage: draft.course.stage,
      grade: draft.course.grade,
      score: draft.course.score,
      province: draft.course.province,
      textbook: draft.course.textbook,
      lessonKind: draft.course.lessonKind,
      desiredContent: draft.course.desiredContent,
      lessonTime: draft.course.lessonTime,
      durationMinutes: draft.course.durationMinutes,
      localFiles: draft.course.localFiles,
      notes: draft.course.notes,
      outputDir: makeOutputDir(student.name, draft.course.type, draft.course.lessonTime, draft.course.desiredContent),
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
    res.json({ draft: { student, course } });
  })
);

app.post("/api/ai-drafts/lesson/commit", requireAuth, (req, res) => {
  const studentInput = (req.body.student || {}) as Record<string, unknown>;
  const courseInput = (req.body.course || {}) as Record<string, unknown>;
  const name = requiredString(studentInput.name);
  if (!name) {
    res.status(400).json({ error: "学生姓名不能为空。" });
    return;
  }
  const desiredContent = requiredString(courseInput.desiredContent);
  if (!desiredContent) {
    res.status(400).json({ error: "想听的内容不能为空。" });
    return;
  }

  const now = nowIso();
  let student = requiredString(req.body.studentId) ? store.findStudent(requiredString(req.body.studentId)) : undefined;
  if (!student) {
    student = {
      id: newId("stu"),
      name,
      stage: requiredString(studentInput.stage),
      notes: requiredString(studentInput.notes),
      weakPoints: requiredString(studentInput.weakPoints),
      commonMistakes: requiredString(studentInput.commonMistakes),
      parentNotes: requiredString(studentInput.parentNotes),
      nextLessonSuggestion: requiredString(studentInput.nextLessonSuggestion),
      createdAt: now,
      updatedAt: now
    };
    store.addStudent(student);
    fs.mkdirSync(path.join(config.workspaceRoot, sanitizeFilename(student.name, "学生")), { recursive: true });
  } else {
    updateStudentFromBody(student, studentInput);
  }

  const type = courseInput.type === "trial" ? "trial" : "formal";
  const lessonTime = normalizeLessonTime(courseInput.lessonTime);
  const outputDir = makeOutputDir(student.name, type, lessonTime, desiredContent);
  fs.mkdirSync(outputDir, { recursive: true });
  const course: Course = {
    id: newId("course"),
    studentId: student.id,
    type,
    stage: requiredString(courseInput.stage, student.stage || "高中数学"),
    grade: requiredString(courseInput.grade),
    score: requiredString(courseInput.score),
    province: requiredString(courseInput.province),
    textbook: requiredString(courseInput.textbook),
    lessonKind: requiredString(courseInput.lessonKind),
    desiredContent,
    lessonTime,
    durationMinutes: parseDuration(courseInput.durationMinutes),
    localFiles: requiredString(courseInput.localFiles),
    notes: requiredString(courseInput.notes),
    outputDir,
    status: "draft",
    createdAt: now,
    updatedAt: now
  };
  store.addCourse(course);
  student.updatedAt = now;
  store.save();

  const job = createCodexJob(store, course);
  runCodexJob(store, job.id);
  res.json({ student, course: publicCourse(course), job });
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
  const lessonTime = normalizeLessonTime(req.body.lessonTime);
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
      course[field] = field === "lessonTime" ? normalizeLessonTime(body[field]) : requiredString(body[field]);
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
  recoverCourseOutputForRequest(course);
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
  recoverCourseOutputForRequest(course);
  const student = store.findStudent(course.studentId);
  const quality = assessCourseQuality(course, student?.name);
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
        void startRagIncrementalJob(true);
      });
    }
    res.json({ job: publicRagReindexJob(), stats: getRagStats(store) });
  })
);

app.get("/api/materials/reindex", requireAuth, (req, res) => {
  res.json({ job: publicRagReindexJob(), stats: getRagStats(store) });
});

app.post("/api/materials/embed", requireAuth, (req, res) => {
  const materialId = requiredString(req.body.materialId);
  if (ragReindexJob.status !== "running") {
    setImmediate(() => {
      void startRagEmbeddingJob(materialId);
    });
  }
  res.json({ job: publicRagReindexJob(), stats: getRagStats(store) });
});

app.get("/api/materials/convert-doc", requireAuth, (req, res) => {
  const docMaterials = store.data.materials.filter((material) => material.status === "needs_conversion" || material.path.toLowerCase().endsWith(".doc"));
  res.json({
    count: docMaterials.length,
    materials: docMaterials,
    message: "旧版 .doc 会在服务器安装 LibreOffice/soffice 后自动转换为临时 .docx 再索引；转换失败的文件会保留 needs_conversion 状态。"
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

app.get("/api/materials/search", requireAuth, asyncHandler(async (req, res) => {
  const query = requiredString(req.query.q);
  res.json({ results: await searchRag(store, query, 12) });
}));

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
  if (anyError.code === "LIMIT_FILE_SIZE") {
    const maxUploadFileMb = Math.round(config.maxUploadFileBytes / 1024 / 1024);
    res.status(413).json({ error: `单个文件过大，目前上限是 ${maxUploadFileMb}MB。可在 .env 里修改 MAX_UPLOAD_FILE_MB。` });
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
