import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { config, ensureAppDirs, logsDir, tempUploadDir, uploadRoot } from "./config.js";
import { createDiagnostics } from "./diagnostics.js";
import { buildDashboardSnapshot } from "./dashboard.js";
import { buildLearningInsights } from "./insights.js";
import { resendCourseFeishuNotification, syncCourseToFeishu } from "./feishuSync.js";
import { courseClassroomPdfFileName, recoverCourseOutputDir } from "./courseOutput.js";
import { assertWithinWorkspace, listCourseFiles, uniqueDestination } from "./files.js";
import { onJobFinished } from "./jobEvents.js";
import {
  applyPostClassSummaryToStudent,
  buildPostClassSummaryDraft,
  cancelCodexJob,
  continueCodexJob,
  createCodexJob,
  recoverInterruptedJobs,
  runCodexJob
} from "./jobs.js";
import { assessCourseQuality } from "./quality.js";
import { readOcrMarkdown, runPaddleOcrForFile, sharedOcrOutputDir, type OcrFileResult } from "./ocr.js";
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
import {
  createLessonTemplate,
  deleteLessonTemplate,
  listLessonTemplates,
  updateLessonTemplate
} from "./templates.js";
import {
  fitFilenameComponent,
  Store,
  newId,
  nowIso,
  publicCourse,
  safeRelativeUploadPath,
  sanitizeFilename
} from "./store.js";
import type { Course, CoursePostClassSummary, CourseType, Material, Student } from "./types.js";

ensureAppDirs();

const store = new Store();
recoverInterruptedJobs(store);
const currentFile = fileURLToPath(import.meta.url);
const serverDir = path.dirname(currentFile);
const ragWorkerPath = path.join(serverDir, "rag-worker.js");
const aiDraftMaxImageBytes = 8 * 1024 * 1024;
const aiDraftMaxExtractedCharsPerFile = 12000;
const aiDraftMaxExtractedCharsTotal = 50000;

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

class AiDraftCodexError extends Error {
  logPath: string;

  constructor(message: string, logPath: string) {
    super(message);
    this.name = "AiDraftCodexError";
    this.logPath = logPath;
  }
}

interface AiDraftAttachmentContext {
  text: string;
  images: ChatContentPart[];
  summary: AiDraftAttachmentSummary;
}

type AiDraftAttachmentStatus = "ok" | "warn" | "error";

interface AiDraftAttachmentItem {
  name: string;
  kind: "pdf" | "image" | "text" | "other";
  status: AiDraftAttachmentStatus;
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

function timestampSlug(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function makeOutputDir(studentName: string, courseType: CourseType, lessonTime: string, desiredContent: string) {
  const typeLabel = courseType === "trial" ? "试听课" : "正式课";
  const studentDir = path.join(config.workspaceRoot, sanitizeFilename(studentName, "学生"));
  const topic = sanitizeFilename(desiredContent || "备课", "备课");
  const baseStem = `${lessonDateSlug(lessonTime)}_${typeLabel}_${topic}`;
  let outputDir = path.join(studentDir, fitFilenameComponent(baseStem));
  let counter = 1;
  while (fs.existsSync(outputDir)) {
    const suffix = `-${counter}`;
    outputDir = path.join(studentDir, fitFilenameComponent(baseStem, suffix));
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
    .replace(/学生情况[:：][^\n]+/g, "")
    .replace(/姓名[:：][^\n，。；;]+/g, "")
    .replace(/年级[:：][^\n，。；;]+/g, "")
    .replace(/分数[:：][^\n，。；;]+/g, "")
    .replace(/地区[:：][^\n，。；;]+/g, "")
    .replace(/教材[:：][^\n，。；;]+/g, "")
    .replace(/课长[:：][^\n，。；;]+/g, "")
    .replace(/时间[:：][^\n，。；;]+/g, "")
    .trim();
}

function inferStudentName(input: string) {
  const explicit = firstMatch(input, [
    /学生姓名[:：\s]*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{1,12})/,
    /姓名[:：\s]*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{1,12})/,
    /给([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{1,12})(?:同学)?(?:上|备|做|安排)/
  ]);
  if (explicit && !/情况|学生|姓名/.test(explicit)) return explicit;

  const situationLine = firstMatch(input, [/学生情况[:：\s]*([^\n]+)/]);
  if (situationLine) {
    const compact = situationLine.trim();
    const beforeGender = compact.match(/^([\u4e00-\u9fa5A-Za-z·]{2,12})\s*(?:男|女)\b/);
    if (beforeGender) return beforeGender[1];
    const beforeGrade = compact.match(/^([\u4e00-\u9fa5A-Za-z·]{2,12})\s*(?:初|高)[一二三123]/);
    if (beforeGrade) return beforeGrade[1];
    const firstToken = compact.split(/\s+/)[0];
    if (firstToken && !/情况|学生|姓名/.test(firstToken)) return firstToken;
  }

  return "待命名学生";
}

function inferScoreText(input: string) {
  return firstMatch(input, [
    /数学\s*([0-9]{1,3}(?:\.[0-9]+)?\s*分(?:[（(][^）)]*[）)])?)/,
    /(?:分数|成绩|水平)[:：\s]*([0-9]{1,3}(?:\.[0-9]+)?\s*分?(?:[（(][^）)]*[）)])?)/,
    /([0-9]{1,3}(?:\.[0-9]+)?\s*分(?:[（(][^）)]*[）)])?)/
  ]);
}

function inferDesiredContentFromText(input: string) {
  const explicit = firstMatch(input, [
    /上课内容[:：\s]*([^\n。；;]{2,80})/,
    /(?:想听|准备|备课内容|内容|专题|讲|学|复习|上)[:：\s]*([^\n。；;]{2,80})/,
    /(?:讲|复习|巩固|提升)([^\n。；;]{2,60})/
  ]);
  if (explicit) return explicit;
  return stripKnownLabels(input).slice(0, 80) || "待确认备课内容";
}

function buildFallbackCourseNotes(input: string) {
  const hasGeometry = /立体几何|空间几何|空间向量|线面|面面|二面角|线面角|点面距/.test(input);
  const localFiles = inferLocalFiles(input);
  const summary = hasGeometry
    ? [
        "本节课需要的内容总结：",
        "- 课程定位：40 分钟高中数学试听课，主题为立体几何薄弱巩固与查漏补缺。",
        "- 学生基础：高三，数学 102 分，整体中等；学校基础较好，课堂需要耐心引导和互动提问。",
        "- 备课主线：优先围绕上传考试 PDF 中的立体几何题，诊断其空间图形识别、定理调用、证明书写和计算转化问题。",
        "- 课堂结构建议：先用 PDF 中一道立体几何题做诊断，再提炼通用方法，随后安排同类变式或口头检查，最后总结后续正式课路径。",
        "- 核心讲法：不要只讲答案；要通过追问让学生说出线面关系、辅助线/建系选择、角与距离转化依据。",
        "- 若 PDF 草稿阶段未能识别题目，正式备课 Agent 必须先读取本地题目/资料路径中的 PDF，提取立体几何相关题作为课堂主线。"
      ]
    : [
        "本节课需要的内容总结：",
        "- 根据原始沟通材料整理学生背景、课堂目标、薄弱点、例题与变式需求。",
        "- 优先读取用户上传或填写的本地资料路径，正式备课时从材料中提取题目并做答案核对。",
        "- 课堂需要包含诊断、方法讲解、同类验证、总结反馈。"
      ];
  return [
    ...summary,
    localFiles ? `- 用户提供资料路径：\n${localFiles}` : "",
    "",
    "原始沟通/题目材料：",
    input
  ]
    .filter(Boolean)
    .join("\n");
}

function createLessonDraftFromText(input: string) {
  const text = input.replace(/\r\n/g, "\n").trim();
  const studentName = inferStudentName(text);
  const desiredContent = inferDesiredContentFromText(text);
  const hasGeometry = /立体几何|空间几何|空间向量|线面|面面|二面角|线面角|点面距/.test(text);

  return {
    student: {
      name: studentName,
      stage: inferStage(text),
      notes: firstMatch(text, [/(?:学生情况|学生画像|备注)[:：\s]*([^\n]+)/]) || stripKnownLabels(text).slice(0, 300),
      weakPoints: firstMatch(text, [/(?:薄弱点|弱点|薄弱|不会|不熟|卡点)[:：\s]*([^\n]+)/]) || (hasGeometry ? "立体几何薄弱，需要围绕考试题查漏补缺。" : ""),
      commonMistakes: firstMatch(text, [/(?:常错|易错|错题|错误|问题)[:：\s]*([^\n]+)/]),
      parentNotes: firstMatch(text, [/(?:家长|沟通|老师反馈|反馈)[:：\s]*([^\n]+)/]),
      nextLessonSuggestion: firstMatch(text, [/(?:下次课|后续|以后|下一步)[:：\s]*([^\n]+)/])
    },
    course: {
      type: inferCourseType(text),
      stage: inferStage(text),
      grade: inferGrade(text),
      score: inferScoreText(text),
      province: firstMatch(text, [/(?:地区|省市|试卷)[:：\s]*([^\n，。；;]+)/, /(新高考\s*[一二三IⅡIII]+卷?)/i]),
      textbook: firstMatch(text, [/(?:教材|版本)[:：\s]*([^\n，。；;]+)/]),
      lessonKind: hasGeometry ? "专题提升" : inferLessonKind(text),
      desiredContent: hasGeometry ? `立体几何薄弱巩固与考试 PDF 错题诊断` : desiredContent,
      lessonTime: normalizeLessonTime(firstMatch(text, [/(?:上课时间|时间|日期)[:：\s]*([^\n，。；;]+)/])),
      durationMinutes: inferDuration(text),
      localFiles: inferLocalFiles(text),
      notes: buildFallbackCourseNotes(text)
    }
  };
}

function truncateForPrompt(value: string, maxChars: number) {
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[内容过长，已截断 ${text.length - maxChars} 个字符]`;
}

function fileExtension(file: Express.Multer.File) {
  return path.extname(file.originalname || "").toLowerCase();
}

function isImageUpload(file: Express.Multer.File) {
  const ext = fileExtension(file);
  return file.mimetype.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
}

function isPdfUpload(file: Express.Multer.File) {
  return file.mimetype === "application/pdf" || fileExtension(file) === ".pdf";
}

function isTextUpload(file: Express.Multer.File) {
  const ext = fileExtension(file);
  return file.mimetype.startsWith("text/") || [".txt", ".md", ".markdown", ".tex", ".csv"].includes(ext);
}

function uploadKind(file: Express.Multer.File): AiDraftAttachmentItem["kind"] {
  if (isPdfUpload(file)) return "pdf";
  if (isImageUpload(file)) return "image";
  if (isTextUpload(file)) return "text";
  return "other";
}

async function pdfToImageParts(file: Express.Multer.File, maxPages: number) {
  const outputDir = await fs.promises.mkdtemp(path.join(tempUploadDir, "ai-draft-pdf-"));
  const prefix = path.join(outputDir, "page");
  try {
    const args = ["-png", "-r", "150", "-f", "1"];
    if (maxPages > 0) args.push("-l", String(maxPages));
    args.push(file.path, prefix);
    const result = spawnSync("pdftoppm", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || "pdftoppm failed";
      throw new Error(detail);
    }

    const imageFiles = (await fs.promises.readdir(outputDir))
      .filter((name) => name.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (imageFiles.length === 0) throw new Error("PDF did not produce any page images.");

    const parts: ChatContentPart[] = [];
    for (const imageFile of imageFiles) {
      const imagePath = path.join(outputDir, imageFile);
      const stat = await fs.promises.stat(imagePath);
      if (stat.size > aiDraftMaxImageBytes) continue;
      const buffer = await fs.promises.readFile(imagePath);
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` }
      });
    }
    if (parts.length === 0) throw new Error("PDF page images exceeded the per-image size limit.");
    return parts;
  } finally {
    fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractAiDraftAttachmentText(file: Express.Multer.File) {
  const buffer = await fs.promises.readFile(file.path);
  if (isTextUpload(file)) return buffer.toString("utf8");
  return "";
}

async function saveAiDraftUploads(student: Student | undefined, files: Express.Multer.File[]) {
  if (!student || files.length === 0) return [];

  const uploadDir = path.join(config.workspaceRoot, sanitizeFilename(student.name, "学生"), "_uploads", "AI草稿", timestampSlug());
  fs.mkdirSync(uploadDir, { recursive: true });
  const saved: string[] = [];

  for (const file of files) {
    const destination = uniqueNestedDestination(uploadDir, file.originalname || "upload");
    await fs.promises.rename(file.path, destination);
    file.path = destination;
    saved.push(destination);
  }

  return saved;
}

function mergeLocalFilesText(current: string, paths: string[]) {
  const existing = new Set(
    current
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  for (const filePath of paths) {
    if (filePath.trim()) existing.add(filePath.trim());
  }
  return [...existing].join("\n");
}

function stableFileFingerprint(filePath: string) {
  const stat = fs.statSync(filePath);
  return createHash("sha1")
    .update(path.resolve(filePath))
    .update(String(stat.size))
    .update(String(Math.floor(stat.mtimeMs)))
    .digest("hex")
    .slice(0, 12);
}

function workspaceOwnerFromPath(filePath: string) {
  const relative = path.relative(path.resolve(config.workspaceRoot), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "未分类";
  return relative.split(path.sep).filter(Boolean)[0] || "未分类";
}

function materialAutoOcrPath(sourcePdfPath: string, title: string) {
  const owner = sanitizeFilename(workspaceOwnerFromPath(sourcePdfPath), "未分类");
  const base = sanitizeFilename(path.basename(title, path.extname(title)) || path.basename(sourcePdfPath, path.extname(sourcePdfPath)), "OCR资料");
  return path.join(uploadRoot, "自动OCR资料", owner, `${base}-${stableFileFingerprint(sourcePdfPath)}.md`);
}

function rewriteOcrMarkdownLinksForRag(markdown: string, ocrDir: string) {
  const absolutize = (value: string) => {
    if (!value || /^(?:https?:|data:|\/)/i.test(value)) return value;
    return path.join(ocrDir, value).replace(/\\/g, "/");
  };
  return markdown
    .replace(/src=(["'])([^"']+)\1/g, (_match, quote, value) => `src=${quote}${absolutize(value)}${quote}`)
    .replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (_match, prefix, value, suffix) => `${prefix}${absolutize(value)}${suffix}`);
}

function heuristicMaterialReview(filePath: string, markdown: string) {
  const sample = `${path.basename(filePath)}\n${markdown.slice(0, 20000)}`;
  const reusableSignals = [
    /第\s*\d+\s*讲/,
    /知识梳理|知识点|典型例题|例题|变式|练习|专题|考点|题型|讲义|教材|教辅|高考|模拟|试卷|答案|解析/,
    /方法总结|能力提升|巩固训练|课后作业/
  ];
  const privateSignals = [/家长|课堂表现|学生姓名|授课老师|课后反馈|微信|电话|手机号|一对一/];
  const signalScore = reusableSignals.reduce((sum, pattern) => sum + (pattern.test(sample) ? 1 : 0), 0);
  const privateScore = privateSignals.reduce((sum, pattern) => sum + (pattern.test(sample) ? 1 : 0), 0);
  return {
    shouldIndex: markdown.replace(/\s+/g, "").length >= 1500 && signalScore >= 1 && privateScore <= 1,
    reason: `heuristic reusable=${signalScore} private=${privateScore}`,
    title: path.basename(filePath, path.extname(filePath))
  };
}

function codexMaterialReview(filePath: string, markdown: string) {
  const lastMessagePath = path.join(tempUploadDir, `auto-rag-review-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  const prompt = [
    "你是数学备课资料库入库审核器。只输出 JSON，不要解释。",
    "判断这份 PaddleOCR Markdown 是否值得加入长期 RAG 资料库。",
    "应该入库：可复用的数学讲义、教辅、专题资料、题库、试卷、答案解析、知识点归纳。",
    "不要入库：单个学生的私人沟通、课堂反馈、隐私信息、临时草稿、明显只属于一次课的个人记录。",
    "输出格式：{\"shouldIndex\":true|false,\"title\":\"资料标题\",\"reason\":\"20字以内原因\"}",
    "",
    `文件路径：${filePath}`,
    "",
    markdown.slice(0, 12000)
  ].join("\n");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    config.workspaceRoot,
    "--sandbox",
    "danger-full-access",
    "--output-last-message",
    lastMessagePath
  ];
  if (config.codexModel) args.push("--model", config.codexModel);
  if (config.codexReasoningEffort) args.push("-c", `model_reasoning_effort="${config.codexReasoningEffort}"`);
  args.push("-");
  const result = spawnSync(config.codexCommand, args, {
    cwd: config.workspaceRoot,
    input: prompt,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    shell: process.platform === "win32",
    windowsHide: true,
    env: {
      ...process.env,
      PREP_WORKSPACE: config.workspaceRoot,
      LESSON_PREP_WEB_ROOT: config.projectRoot
    }
  });
  const text = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, "utf8") : result.stdout || "";
  fs.promises.rm(lastMessagePath, { force: true }).catch(() => undefined);
  if (result.error || result.status !== 0 || !text.trim()) throw new Error(result.error?.message || result.stderr || "Codex review failed.");
  const parsed = jsonFromModelText(text) as Record<string, unknown>;
  return {
    shouldIndex: Boolean(parsed.shouldIndex),
    reason: typeof parsed.reason === "string" ? parsed.reason : "codex review",
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : path.basename(filePath, path.extname(filePath))
  };
}

async function maybeRegisterOcrMarkdownMaterial(sourcePdfPath: string, originalName: string, ocrResult: OcrFileResult) {
  if (ocrResult.status !== "ok" || !ocrResult.combinedMarkdownPath || !fs.existsSync(ocrResult.combinedMarkdownPath)) {
    return { queued: false, message: "OCR Markdown 不可用，未加入 RAG。" };
  }

  const rawMarkdown = fs.readFileSync(ocrResult.combinedMarkdownPath, "utf8").trim();
  if (!rawMarkdown) return { queued: false, message: "OCR Markdown 为空，未加入 RAG。" };

  let review = heuristicMaterialReview(sourcePdfPath, rawMarkdown);
  try {
    review = codexMaterialReview(sourcePdfPath, rawMarkdown);
  } catch (error) {
    console.warn(`[auto-rag] Codex review failed, using heuristic: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!review.shouldIndex) {
    return { queued: false, message: `未自动加入 RAG：${review.reason}` };
  }

  const destination = materialAutoOcrPath(sourcePdfPath, review.title || originalName);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const ocrDir = path.dirname(ocrResult.combinedMarkdownPath);
  const ragMarkdown = [
    `# ${review.title || path.basename(sourcePdfPath, path.extname(sourcePdfPath))}`,
    "",
    `- 来源 PDF：${sourcePdfPath}`,
    `- PaddleOCR Markdown：${ocrResult.combinedMarkdownPath}`,
    `- OCR 页数：${ocrResult.pageCount ?? "未知"}`,
    `- OCR 字符数：${ocrResult.textChars ?? rawMarkdown.length}`,
    `- 入库判断：${review.reason}`,
    "",
    "---",
    "",
    rewriteOcrMarkdownLinksForRag(rawMarkdown, ocrDir),
    ""
  ].join("\n");
  fs.writeFileSync(destination, ragMarkdown, "utf8");
  registerMaterialFile(store, destination, "text/markdown");
  store.save();
  void startRagIncrementalJob();
  return { queued: true, message: `已把 OCR 合并 Markdown 加入 RAG 队列：${destination}` };
}

async function buildAiDraftAttachmentContext(files: Express.Multer.File[]): Promise<AiDraftAttachmentContext> {
  const textBlocks: string[] = [];
  const images: ChatContentPart[] = [];
  const items: AiDraftAttachmentItem[] = [];
  let extractedChars = 0;

  for (const file of files) {
    const name = file.originalname || "未命名文件";
    const kind = uploadKind(file);
    const savedPath = assertWithinWorkspace(file.path);
    if (isPdfUpload(file)) {
      try {
        const ocrOutputDir = sharedOcrOutputDir(file.path);
        const ocrResult = await runPaddleOcrForFile(file.path, ocrOutputDir);
        if (ocrResult.status === "ok") {
          const autoRag = await maybeRegisterOcrMarkdownMaterial(file.path, name, ocrResult);
          const remaining = Math.max(0, aiDraftMaxExtractedCharsTotal - extractedChars);
          const clipped = readOcrMarkdown(ocrResult, Math.min(aiDraftMaxExtractedCharsPerFile, remaining));
          extractedChars += clipped.length;
          items.push({
            name,
            kind,
            status: "ok",
            message: `上传成功，已保存到学生目录，并通过 PaddleOCR 提取 ${clipped.length} 个字符供草稿分析。${autoRag.message}`,
            pages: ocrResult.pageCount,
            size: file.size,
            savedPath
          });
          textBlocks.push(
            [
              `### ${name}`,
              `保存路径：${savedPath}`,
              `OCR Markdown：${ocrResult.combinedMarkdownPath}`,
              `RAG：${autoRag.message}`,
              clipped
            ].join("\n")
          );
          continue;
        }

        if (config.lessonDraftAiProvider.toLowerCase() === "codex") {
          items.push({
            name,
            kind,
            status: "warn",
            message: `上传成功，已保存到学生目录；未提取到有效 PDF 文本，OCR 未可用：${ocrResult.message}`,
            size: file.size,
            savedPath,
            retryable: true
          });
          textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[PDF 未提取到有效文本，OCR 未可用：${ocrResult.message}。草稿阶段不要卡住读取整份 PDF；请先根据用户文字生成结构化草稿，并在 notes/commonMistakes 中写明正式备课时必须按该路径继续读取考试题。]`);
          continue;
        }

        const pdfImages = await pdfToImageParts(file, Math.max(1, config.lessonDraftPdfImagePages));
        images.push(...pdfImages);
        items.push({
          name,
          kind,
          status: "ok",
          message: `上传成功，已保存到学生目录；未提取到文本，已转前 ${pdfImages.length} 页图片供草稿分析。`,
          pages: pdfImages.length,
          size: file.size,
          savedPath
        });
        textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[PDF 未提取到文本，已转前 ${pdfImages.length} 页图片发送给模型。完整文件请后续备课 Agent 按路径读取。]`);
        continue;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        items.push({
          name,
          kind,
          status: "warn",
          message: `上传成功，已保存到学生目录；PDF 草稿解析失败，将只保留文件路径：${message}`,
          size: file.size,
          savedPath
        });
        textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[PDF 草稿解析失败：${message}。正式备课时请按路径读取该文件。]`);
        continue;
      }
    }

    if (isImageUpload(file)) {
      if (file.size > aiDraftMaxImageBytes) {
        items.push({
          name,
          kind,
          status: "error",
          message: `图片超过 ${Math.round(aiDraftMaxImageBytes / 1024 / 1024)}MB，未发送给模型。`,
          size: file.size,
          savedPath
        });
        textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[图片未发送：文件超过 ${Math.round(aiDraftMaxImageBytes / 1024 / 1024)}MB]`);
        continue;
      }
      const buffer = await fs.promises.readFile(file.path);
      const mimeType = file.mimetype || "image/jpeg";
      images.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` }
      });
      items.push({
        name,
        kind,
        status: "ok",
        message: "上传成功，已保存到学生目录，并作为图片发送给模型。",
        size: file.size,
        savedPath
      });
      textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[已作为图片发送给模型，请结合图片内容提炼题目、错因和备课需求]`);
      continue;
    }

    try {
      const extracted = await extractAiDraftAttachmentText(file);
      if (!extracted.trim()) {
        items.push({
          name,
          kind,
          status: "warn",
          message: "上传成功，但未提取到文本；若是扫描版 PDF，请改传图片。",
          size: file.size,
          savedPath
        });
        textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[未能提取文本。如果这是扫描版 PDF，请改传截图或图片。]`);
        continue;
      }
      const remaining = Math.max(0, aiDraftMaxExtractedCharsTotal - extractedChars);
      if (remaining <= 0) {
        items.push({
          name,
          kind,
          status: "warn",
          message: "上传成功，但文本总量超过上限，未加入本次分析。",
          size: file.size,
          savedPath
        });
        textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[文本未加入：上传文件文本总量已达到上限]`);
        continue;
      }
      const clipped = truncateForPrompt(extracted, Math.min(aiDraftMaxExtractedCharsPerFile, remaining));
      extractedChars += clipped.length;
      items.push({
        name,
        kind,
        status: "ok",
        message: `上传成功，已保存到学生目录，并提取 ${clipped.length} 个字符发送给模型。`,
        size: file.size,
        savedPath
      });
      textBlocks.push(`### ${name}\n保存路径：${savedPath}\n${clipped}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      items.push({
        name,
        kind,
        status: "error",
        message: `文件解析失败：${message}`,
        size: file.size,
        savedPath
      });
      textBlocks.push(`### ${name}\n保存路径：${savedPath}\n[文件解析失败：${message}]`);
    }
  }

  return {
    text: textBlocks.length > 0 ? `\n\n上传文件内容：\n${textBlocks.join("\n\n")}` : "",
    images,
    summary: {
      fileCount: files.length,
      imageCount: images.length,
      items
    }
  };
}

function removeTempUploadFiles(files: Express.Multer.File[]) {
  const tempRoot = path.resolve(tempUploadDir);
  for (const file of files) {
    const resolved = path.resolve(file.path);
    if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) continue;
    fs.promises.unlink(file.path).catch(() => undefined);
  }
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

function quoteShellForLog(value: string) {
  if (/^[\w.:\-/\\]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildCodexDraftPrompt(input: string) {
  return `
你是备课工作台的“结构化草稿”助手，只负责整理字段，不要正式备课，不要生成课件、逐字稿、PDF 或课后反馈。

请根据下面的原始沟通材料和上传文件路径，输出严格 JSON。不要解释，不要使用 Markdown 代码块。字段不能空泛，尤其 course.notes 必须像“备课任务摘要”一样可直接交给正式备课 Agent。

如果材料里有本地 PDF/图片/文档路径，你可以按路径读取文件，只需要提炼学生信息、课程信息、题目主题、薄弱点和后续正式备课需要注意的点；不要完整解题，不要做完整课程。如果 PDF 暂时无法读取，也必须根据文字需求生成“本节课需要的内容总结”，并明确正式备课时优先读取该 PDF。

JSON 结构必须是：
{
  "student": {
    "name": "",
    "stage": "",
    "notes": "",
    "weakPoints": "",
    "commonMistakes": "",
    "parentNotes": "",
    "nextLessonSuggestion": ""
  },
  "course": {
    "type": "trial",
    "stage": "",
    "grade": "",
    "score": "",
    "province": "",
    "textbook": "",
    "lessonKind": "",
    "desiredContent": "",
    "lessonTime": "",
    "durationMinutes": 40,
    "localFiles": "",
    "notes": ""
  }
}

字段要求：
- type 只能是 "trial" 或 "formal"。
- lessonTime 若能确定日期时间，请输出 ISO 或可解析的中文/数字时间；不能确定就留空。
- localFiles 必须保留真实本地文件路径，多路径用换行。不要写“学生上传的 PDF”这种泛称。
- student.name 必须是真实姓名，不要输出“学生情况”“情况”“学生”等标签词。
- score 只写分数和水平，例如“102分（中等）”，不要把后面的分析句子并进去。
- desiredContent 归纳成本次课最核心主题，例如“立体几何薄弱巩固与考试 PDF 错题诊断”。
- 用户明确给出的题目数量、每类题型数量、资料覆盖范围和顺序必须原样保留在 desiredContent 和 course.notes 中，属于硬约束。不得因为课长、学生基础或教学节奏而缩减、延期、改成条件式安排；一份 PDF 或一套资料可以供多次课使用。
- course.notes 必须包含“本节课需要的内容总结”，至少写清：
  1. 课程定位和课长；
  2. 学生基础、性格/课堂引导要求；
  3. 本节课知识主线；
  4. 上传 PDF 在正式备课中的用途；
  5. 建议课堂顺序；
  6. 例题、变式、检测和课后反馈重点。
- 若文件读不到或无法识别具体题目，在 commonMistakes 或 notes 中明确写“需正式备课时读取路径继续分析”，不要编造题目。

原始材料：
${input}
`.trim();
}

function buildCodexDraftContinuePrompt(previousLog: string) {
  return `
你正在继续一次中断或未完成的“AI 备课草稿”结构化任务。

下面是上一次 Codex 草稿任务的日志，里面可能包含已经读到的 PDF 题面、页面观察、stdout/stderr、错误信息、last message 或部分 JSON。

请继续利用这些上下文完成结构化草稿。不要重新正式备课，不要生成课件、逐字稿、PDF 或课后反馈。只输出严格 JSON，不要解释，不要 Markdown 代码块。

如果日志中已经有足够信息，请直接整理成最终 JSON；如果日志里已有完整 JSON，请校正后原样输出。JSON 结构仍为：
{
  "student": {
    "name": "",
    "stage": "",
    "notes": "",
    "weakPoints": "",
    "commonMistakes": "",
    "parentNotes": "",
    "nextLessonSuggestion": ""
  },
  "course": {
    "type": "trial",
    "stage": "",
    "grade": "",
    "score": "",
    "province": "",
    "textbook": "",
    "lessonKind": "",
    "desiredContent": "",
    "lessonTime": "",
    "durationMinutes": 40,
    "localFiles": "",
    "notes": ""
  }
}

course.notes 必须包含“本节课需要的内容总结”，写清课程定位、学生基础、知识主线、PDF 用途、课堂顺序、例题/变式/检测/反馈重点。

上一次日志：
${previousLog}
`.trim();
}

function readAiDraftLog(logPath: string) {
  const resolved = path.resolve(logPath);
  const logsRoot = path.resolve(logsDir);
  if (!resolved.startsWith(`${logsRoot}${path.sep}`) || !path.basename(resolved).startsWith("ai-draft-codex-")) {
    throw new Error("Invalid draft continuation log path.");
  }
  if (!fs.existsSync(resolved)) throw new Error("Draft continuation log was not found.");
  return fs.readFileSync(resolved, "utf8");
}

function parseDraftFromLog(input: string, logContent: string) {
  const parsedMarker = "## parsed json source";
  const parsedIndex = logContent.lastIndexOf(parsedMarker);
  if (parsedIndex >= 0) {
    const source = logContent.slice(parsedIndex + parsedMarker.length).split("\n## parse error")[0]?.trim() || "";
    if (source) return mergeAiLessonDraft(input, jsonFromModelText(source));
  }

  const lastMessageMarker = "## last message";
  const lastMessageIndex = logContent.lastIndexOf(lastMessageMarker);
  if (lastMessageIndex >= 0) {
    const source = logContent.slice(lastMessageIndex + lastMessageMarker.length).split("\n## parsed json source")[0]?.trim() || "";
    if (source) return mergeAiLessonDraft(input, jsonFromModelText(source));
  }

  return mergeAiLessonDraft(input, jsonFromModelText(logContent));
}

function runCodexLessonDraftPrompt(prompt: string, mergeInput: string, logPrefix = "ai-draft-codex") {
  fs.mkdirSync(tempUploadDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const logId = `${logPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const logPath = path.join(logsDir, `${logId}.log`);
  const lastMessagePath = path.join(tempUploadDir, `${logId}.last.md`);
  const args = ["exec", "--skip-git-repo-check", "-C", config.workspaceRoot, "--sandbox", "danger-full-access", "--output-last-message", lastMessagePath];
  if (config.codexModel) args.push("--model", config.codexModel);
  if (config.codexReasoningEffort) args.push("-c", `model_reasoning_effort="${config.codexReasoningEffort}"`);
  args.push("-");

  const startedAt = new Date();
  fs.writeFileSync(
    logPath,
    [
      `# ${config.codexCommand} ${args.map(quoteShellForLog).join(" ")}`,
      "",
      `startedAt=${startedAt.toISOString()}`,
      `cwd=${config.workspaceRoot}`,
      `timeoutMs=${config.lessonDraftCodexTimeoutMs > 0 ? config.lessonDraftCodexTimeoutMs : "none"}`,
      `lastMessagePath=${lastMessagePath}`,
      "",
      "## prompt",
      prompt,
      "",
      "## process result",
      "[running]"
    ].join("\n"),
    "utf8"
  );
  const result = spawnSync(config.codexCommand, args, {
    cwd: config.workspaceRoot,
    input: prompt,
    encoding: "utf8",
    timeout: config.lessonDraftCodexTimeoutMs > 0 ? config.lessonDraftCodexTimeoutMs : undefined,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PREP_WORKSPACE: config.workspaceRoot,
      LESSON_PREP_WEB_ROOT: config.projectRoot
    },
    shell: process.platform === "win32",
    windowsHide: true
  });

  try {
    const endedAt = new Date();
    const lastMessage = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, "utf8") : "";
    fs.appendFileSync(
      logPath,
      [
        "",
        `endedAt=${endedAt.toISOString()}`,
        `durationMs=${endedAt.getTime() - startedAt.getTime()}`,
        `status=${String(result.status)}`,
        `signal=${String(result.signal)}`,
        `error=${result.error ? result.error.message : ""}`,
        "",
        "## stdout",
        result.stdout || "",
        "",
        "## stderr",
        result.stderr || "",
        "",
        "## last message",
        lastMessage,
        "",
        "## parsed json source",
        lastMessage.trim() || result.stdout?.trim() || ""
      ].join("\n"),
      "utf8"
    );
    const content = lastMessage.trim() || result.stdout?.trim() || "";
    if (content) {
      try {
        const draft = mergeAiLessonDraft(mergeInput, jsonFromModelText(content));
        if (result.error || result.status !== 0) {
          fs.appendFileSync(
            logPath,
            [
              "",
              "## recovered despite process error",
              result.error ? result.error.message : `Codex exited with code ${result.status}`
            ].join("\n"),
            "utf8"
          );
        }
        return draft;
      } catch (error) {
        fs.appendFileSync(
          logPath,
          [
            "",
            "## parse error",
            error instanceof Error ? error.stack || error.message : String(error)
          ].join("\n"),
          "utf8"
        );
        if (!result.error && result.status === 0) {
          throw new AiDraftCodexError(`Codex 草稿返回内容不是可解析 JSON：${error instanceof Error ? error.message : String(error)}`, logPath);
        }
      }
    }

    if (result.error) throw new AiDraftCodexError(result.error.message, logPath);
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || `Codex exited with code ${result.status}`;
      throw new AiDraftCodexError(detail, logPath);
    }
    if (!content) throw new AiDraftCodexError("Codex draft returned empty content.", logPath);
    try {
      return mergeAiLessonDraft(mergeInput, jsonFromModelText(content));
    } catch (error) {
      fs.appendFileSync(
        logPath,
        [
          "",
          "## parse error",
          error instanceof Error ? error.stack || error.message : String(error)
        ].join("\n"),
        "utf8"
      );
      throw new AiDraftCodexError(`Codex 草稿返回内容不是可解析 JSON：${error instanceof Error ? error.message : String(error)}`, logPath);
    }
  } finally {
    fs.promises.unlink(lastMessagePath).catch(() => undefined);
  }
}

function runCodexLessonDraft(input: string) {
  return runCodexLessonDraftPrompt(buildCodexDraftPrompt(input), input);
}

function continueCodexLessonDraft(logPath: string) {
  const logContent = readAiDraftLog(logPath);
  try {
    return parseDraftFromLog(logContent, logContent);
  } catch {
    const clippedLog = logContent.length > 120000 ? logContent.slice(-120000) : logContent;
    return runCodexLessonDraftPrompt(buildCodexDraftContinuePrompt(clippedLog), logContent, "ai-draft-codex-continue");
  }
}

function latestCompletedAiDraftForStudent(student: Student) {
  if (!fs.existsSync(logsDir)) return null;
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const candidates = fs
    .readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("ai-draft-codex-") && entry.name.endsWith(".log"))
    .map((entry) => {
      const logPath = path.join(logsDir, entry.name);
      return { logPath, mtimeMs: fs.statSync(logPath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 40);

  for (const candidate of candidates) {
    try {
      const logContent = fs.readFileSync(candidate.logPath, "utf8");
      if (!logContent.includes("## parsed json source") || !logContent.includes("endedAt=")) continue;
      const draft = parseDraftFromLog(logContent, logContent);
      if (draft.student.name.trim() !== student.name.trim()) continue;
      const response = draftResponse(draft);
      const studentRoot = path.resolve(config.workspaceRoot, sanitizeFilename(student.name, "学生"));
      const savedPdfPaths = response.course.localFiles
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => {
          const resolved = path.resolve(value);
          return (
            resolved.startsWith(`${studentRoot}${path.sep}`) &&
            path.extname(resolved).toLowerCase() === ".pdf" &&
            fs.existsSync(resolved)
          );
        });
      const attachments: AiDraftAttachmentSummary = {
        fileCount: savedPdfPaths.length,
        imageCount: 0,
        items: savedPdfPaths.map((savedPath) => ({
          name: path.basename(savedPath),
          kind: "pdf",
          status: "ok",
          message: "已从服务端完成记录恢复，PDF 和 OCR 结果无需重新上传。",
          size: fs.statSync(savedPath).size,
          savedPath,
          retryable: false
        }))
      };
      return {
        draft: response,
        attachments,
        logPath: candidate.logPath,
        completedAt: new Date(candidate.mtimeMs).toISOString()
      };
    } catch {
      continue;
    }
  }
  return null;
}

function draftResponse(draft: ReturnType<typeof createLessonDraftFromText>, savedPaths: string[] = []) {
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
    localFiles: mergeLocalFilesText(draft.course.localFiles, savedPaths),
    notes: draft.course.notes,
    outputDir: makeOutputDir(student.name, draft.course.type, draft.course.lessonTime, draft.course.desiredContent),
    status: "draft",
    createdAt: now,
    updatedAt: now
  };
  return { student, course };
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

async function createLessonDraft(
  input: string,
  attachmentContext: AiDraftAttachmentContext = { text: "", images: [], summary: { fileCount: 0, imageCount: 0, items: [] } }
) {
  const modelInput = `${input}${attachmentContext.text}`;
  if (config.lessonDraftAiProvider.toLowerCase() === "codex") {
    return runCodexLessonDraft(modelInput);
  }
  if (config.lessonDraftAiProvider.toLowerCase() !== "ark" || !config.lessonDraftAiApiKey) {
    return createLessonDraftFromText(modelInput);
  }
  try {
    const userContent: string | ChatContentPart[] =
      attachmentContext.images.length > 0
        ? [{ type: "text", text: modelInput }, ...attachmentContext.images]
        : modelInput;
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
                "用户明确指定的题目数量、每类题型数量、资料覆盖范围和顺序是硬约束，必须原样保留。不得以课长、学生基础或教学节奏为理由自行减少、延期或改成条件式安排；一份 PDF 或一套资料可以供多次课使用。",
                "如果原文只给了零散题目，你要从题目反推知识点、能力缺口和本次课应该怎么讲；如果信息不足，可以在 course.notes 里列出需要老师确认的问题，但不要编造学生事实。",
                "course.notes 建议用短条目组织，保证正式调用 AI 备课 Agent 时可以直接作为备课任务依据。"
              ].join("\n")
          },
          { role: "user", content: userContent }
        ],
        temperature: 0.1
      })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Ark draft parse failed: ${response.status}`);
    const payload = responseText ? JSON.parse(responseText) : {};
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Ark draft parse returned empty content.");
    return mergeAiLessonDraft(modelInput, jsonFromModelText(content));
  } catch {
    return createLessonDraftFromText(modelInput);
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
  return new Promise<{ ok: boolean; material?: Material; error?: string }>((resolve) => {
    const workerHeapMb = Math.max(256, Math.floor(config.ragWorkerMaxOldSpaceMb));
    const child = spawn(process.execPath, [`--max-old-space-size=${workerHeapMb}`, ragWorkerPath, filePath], {
      cwd: config.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 100_000) stdout = stdout.slice(-100_000);
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
        try {
          const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
          const parsed = JSON.parse(line) as { material?: Material };
          if (!parsed.material) throw new Error("worker returned no material record");
          resolve({ ok: true, material: parsed.material });
        } catch (error) {
          resolve({
            ok: false,
            error: `worker output parse failed: ${error instanceof Error ? error.message : String(error)}`
          });
        }
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
    clearRagIndexCache();
    ragReindexJob.processed += 1;
    const elapsedMs = Date.now() - startedAt;
    if (result.ok && result.material) {
      store.upsertMaterial(result.material);
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
  const ragQuestionCount = store.data.materials.reduce((sum, material) => sum + (material.questionCount || 0), 0);
  const ragSnippetCount = store.data.materials.reduce((sum, material) => sum + (material.snippetCount || 0), 0);
  res.json({
    setupRequired: store.data.users.length === 0,
    workspaceRoot: config.workspaceRoot,
    codexAutoRun: config.codexAutoRun,
    codexRunner: config.codexRunner,
    ragChunkCount: ragQuestionCount + ragSnippetCount,
    ragQuestionCount,
    ragSnippetCount
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

app.get("/api/dashboard", requireAuth, (req, res) => {
  store.reload();
  res.json({ dashboard: buildDashboardSnapshot(store.data) });
});

app.get("/api/insights", requireAuth, (req, res) => {
  store.reload();
  res.json({ insights: buildLearningInsights(store.data) });
});

app.get("/api/templates", requireAuth, (req, res) => {
  res.json({ templates: listLessonTemplates(store) });
});

app.post("/api/templates", requireAuth, (req, res) => {
  try {
    res.status(201).json({ template: createLessonTemplate(store, req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/templates/:templateId", requireAuth, (req, res) => {
  try {
    const template = updateLessonTemplate(store, routeParam(req, "templateId"), req.body || {});
    if (!template) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    res.json({ template });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/templates/:templateId", requireAuth, (req, res) => {
  const deleted = deleteLessonTemplate(store, routeParam(req, "templateId"));
  if (!deleted) {
    res.status(404).json({ error: "Template not found." });
    return;
  }
  res.json({ deleted: true });
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
    "nextLessonSuggestion",
    "learningMemory",
    "learningRoadmap"
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
  upload.array("files"),
  asyncHandler(async (req, res) => {
    const input = requiredString(req.body.input);
    const files = (req.files || []) as Express.Multer.File[];
    if (input.length < 4 && files.length === 0) {
      res.status(400).json({ error: "请先输入备课需求。" });
      return;
    }
    const existingStudent = requiredString(req.body.studentId) ? store.findStudent(requiredString(req.body.studentId)) : undefined;
    if (files.length > 0 && !existingStudent) {
      res.status(404).json({ error: "上传文件需要先选择有效学生。" });
      removeTempUploadFiles(files);
      return;
    }
    let attachmentContext: AiDraftAttachmentContext;
    let savedPaths: string[] = [];
    try {
      savedPaths = await saveAiDraftUploads(existingStudent, files);
      attachmentContext = await buildAiDraftAttachmentContext(files);
    } finally {
      removeTempUploadFiles(files);
    }
    console.info(
      `[ai-draft] files=${attachmentContext.summary.fileCount} images=${attachmentContext.summary.imageCount} ` +
        attachmentContext.summary.items.map((item) => `${item.status}:${item.name}:${item.savedPath || ""}:${item.message}`).join(" | ")
    );
    const draft = await createLessonDraft(input || "请根据上传文件生成备课草稿。", attachmentContext);
    const { student, course } = draftResponse(draft, savedPaths);
    res.json({ draft: { student, course }, attachments: attachmentContext.summary });
  })
);

app.post(
  "/api/ai-drafts/lesson/continue",
  requireAuth,
  asyncHandler(async (req, res) => {
    const logPath = requiredString(req.body.logPath);
    if (!logPath) {
      res.status(400).json({ error: "缺少可继续的草稿日志路径。" });
      return;
    }
    const draft = continueCodexLessonDraft(logPath);
    const { student, course } = draftResponse(draft);
    res.json({
      draft: { student, course },
      attachments: { fileCount: 0, imageCount: 0, items: [] },
      continuedFrom: logPath
    });
  })
);

app.get("/api/ai-drafts/lesson/recovery", requireAuth, (req, res) => {
  const student = store.findStudent(requiredString(req.query.studentId));
  if (!student) {
    res.status(404).json({ error: "Student not found." });
    return;
  }
  res.json({ recovery: latestCompletedAiDraftForStudent(student) });
});

app.post(
  "/api/ai-drafts/lesson/attachments/ocr-retry",
  requireAuth,
  asyncHandler(async (req, res) => {
    const student = store.findStudent(requiredString(req.body.studentId));
    if (!student) {
      res.status(404).json({ error: "Student not found." });
      return;
    }

    const requestedPath = requiredString(req.body.savedPath);
    if (!requestedPath) {
      res.status(400).json({ error: "缺少要重试的 PDF 路径。" });
      return;
    }

    const savedPath = assertWithinWorkspace(requestedPath);
    const studentUploadRoot = path.resolve(
      config.workspaceRoot,
      sanitizeFilename(student.name, "学生"),
      "_uploads",
      "AI草稿"
    );
    if (!savedPath.startsWith(`${studentUploadRoot}${path.sep}`)) {
      res.status(403).json({ error: "只能重试该学生 AI 草稿目录内的 PDF。" });
      return;
    }
    if (path.extname(savedPath).toLowerCase() !== ".pdf" || !fs.existsSync(savedPath) || !fs.statSync(savedPath).isFile()) {
      res.status(404).json({ error: "PDF 文件不存在或格式不正确。" });
      return;
    }

    const ocrResult = await runPaddleOcrForFile(savedPath, sharedOcrOutputDir(savedPath));
    const size = fs.statSync(savedPath).size;
    const name = path.basename(savedPath);
    if (ocrResult.status !== "ok") {
      res.json({
        item: {
          name,
          kind: "pdf",
          status: "warn",
          message: `OCR 重试失败：${ocrResult.message}`,
          size,
          savedPath,
          retryable: true
        } satisfies AiDraftAttachmentItem
      });
      return;
    }

    const autoRag = await maybeRegisterOcrMarkdownMaterial(savedPath, name, ocrResult);
    res.json({
      item: {
        name,
        kind: "pdf",
        status: "ok",
        message: `OCR 重试成功：已提取 ${ocrResult.textChars ?? 0} 个字符。${autoRag.message}`,
        pages: ocrResult.pageCount,
        size,
        savedPath,
        retryable: false
      } satisfies AiDraftAttachmentItem,
      ocrMarkdownPath: ocrResult.combinedMarkdownPath
    });
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
      .sort((a, b) => courseTimelineValue(b) - courseTimelineValue(a) || b.createdAt.localeCompare(a.createdAt))
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
    codexPromptOverride: requiredString(req.body.codexPromptOverride),
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
    "notes",
    "codexPromptOverride"
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

function courseTimelineValue(course: Course) {
  return Date.parse(course.lessonTime || course.createdAt || course.updatedAt || "") || 0;
}

function postClassString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePostClassSummary(input: unknown, fallback?: CoursePostClassSummary): CoursePostClassSummary {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const now = nowIso();
  const status = body.status === "confirmed" ? "confirmed" : body.status === "draft" ? "draft" : fallback?.status || "draft";
  return {
    status,
    linkedPrevious: "linkedPrevious" in body ? postClassString(body.linkedPrevious) : fallback?.linkedPrevious || "",
    learned: "learned" in body ? postClassString(body.learned) : fallback?.learned || "",
    mastered: "mastered" in body ? postClassString(body.mastered) : fallback?.mastered || "",
    unresolved: "unresolved" in body ? postClassString(body.unresolved) : fallback?.unresolved || "",
    commonMistakes: "commonMistakes" in body ? postClassString(body.commonMistakes) : fallback?.commonMistakes || "",
    homework: "homework" in body ? postClassString(body.homework) : fallback?.homework || "",
    nextLessonSuggestion: "nextLessonSuggestion" in body ? postClassString(body.nextLessonSuggestion) : fallback?.nextLessonSuggestion || "",
    teacherNotes: "teacherNotes" in body ? postClassString(body.teacherNotes) : fallback?.teacherNotes || "",
    updatedAt: now,
    confirmedAt: status === "confirmed" ? fallback?.confirmedAt : undefined
  };
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

app.post(
  "/api/courses/:courseId/refine",
  requireAuth,
  upload.array("files"),
  asyncHandler(async (req, res) => {
    const files = (req.files || []) as Express.Multer.File[];
    const course = store.findCourse(routeParam(req, "courseId"));
    if (!course) {
      removeTempUploadFiles(files);
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const runningJob = course.jobId ? store.findJob(course.jobId) : null;
    if (runningJob?.status === "running" || runningJob?.status === "queued") {
      removeTempUploadFiles(files);
      res.status(409).json({ error: "This course already has a running job." });
      return;
    }
    const requestedInstruction = requiredString(req.body.instruction);
    if (!requestedInstruction && files.length === 0) {
      res.status(400).json({ error: "请填写补充要求或上传需要补充的资料。" });
      return;
    }

    const attachmentsDir = path.join(course.outputDir, "_attachments", "补充资料", timestampSlug());
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const saved: string[] = [];
    try {
      for (const file of files) {
        const destination = uniqueNestedDestination(attachmentsDir, file.originalname || "upload");
        await fs.promises.rename(file.path, destination);
        saved.push(destination);
      }
    } finally {
      removeTempUploadFiles(files);
    }
    appendCourseLocalFiles(course, saved);
    const instruction =
      requestedInstruction || "请读取本次上传的补充资料，在保留现有成果的基础上补充并完善本节备课内容。";
    const job = createCodexJob(store, course, {
      refineInstruction: instruction,
      supplementalFiles: saved
    });
    runCodexJob(store, job.id);
    res.json({ job, files: saved, course: publicCourse(course) });
  })
);

app.post("/api/courses/:courseId/pdf-image-refine", requireAuth, (req, res) => {
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
  const pages = requiredString(req.body.pages).slice(0, 200);
  const instruction = requiredString(req.body.instruction);
  if (!pages) {
    res.status(400).json({ error: "请填写要修改的 PDF 页码，例如 4 或 3,7-8。" });
    return;
  }
  if (!instruction) {
    res.status(400).json({ error: "请填写 PDF 图形/版面的具体修改要求。" });
    return;
  }
  const student = store.findStudent(course.studentId);
  const texPath = path.join(course.outputDir, "_work", "课堂讲义.tex");
  const workPdfPath = path.join(course.outputDir, "_work", "课堂讲义.pdf");
  const finalPdfPath = path.join(course.outputDir, courseClassroomPdfFileName(course, student?.name));
  if (!fs.existsSync(texPath) || (!fs.existsSync(workPdfPath) && !fs.existsSync(finalPdfPath))) {
    res.status(400).json({ error: "当前课程还没有可修订的课堂讲义 TeX/PDF，请先完成 PDF 生成。" });
    return;
  }
  const job = createCodexJob(store, course, {
    kind: "pdf-image-refine",
    pdfRefinePages: pages,
    refineInstruction: instruction
  });
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

app.get("/api/courses/:courseId/post-class", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  recoverCourseOutputForRequest(course);
  const summary = course.postClassSummary || buildPostClassSummaryDraft(course);
  res.json({ summary, course: publicCourse(course) });
});

app.post("/api/courses/:courseId/post-class/draft", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能更新课后沉淀。" });
    return;
  }
  recoverCourseOutputForRequest(course);
  course.postClassSummary = buildPostClassSummaryDraft(course);
  course.updatedAt = nowIso();
  store.save();
  res.json({ summary: course.postClassSummary, course: publicCourse(course) });
});

app.patch("/api/courses/:courseId/post-class", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能更新课后沉淀。" });
    return;
  }
  course.postClassSummary = normalizePostClassSummary(req.body.summary || req.body, course.postClassSummary);
  course.updatedAt = nowIso();
  store.save();
  res.json({ summary: course.postClassSummary, course: publicCourse(course) });
});

app.post("/api/courses/:courseId/post-class/confirm", requireAuth, (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能确认课后沉淀。" });
    return;
  }
  const student = store.findStudent(course.studentId);
  if (!student) {
    res.status(404).json({ error: "Student not found." });
    return;
  }
  const summary = normalizePostClassSummary(req.body.summary || req.body, course.postClassSummary || buildPostClassSummaryDraft(course));
  summary.status = "confirmed";
  summary.confirmedAt = nowIso();
  course.postClassSummary = summary;
  course.updatedAt = nowIso();
  applyPostClassSummaryToStudent(student, course, summary);
  store.save();
  res.json({ summary, course: publicCourse(course), student });
});

app.post("/api/courses/:courseId/feishu/notify", requireAuth, async (req, res) => {
  const course = store.findCourse(routeParam(req, "courseId"));
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  if (courseHasActiveJob(course)) {
    res.status(409).json({ error: "该课程正在生成，暂时不能重发飞书消息。" });
    return;
  }

  try {
    const notification = await resendCourseFeishuNotification(store, course);
    res.json({ course: publicCourse(course), notification });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
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

app.post("/api/jobs/:jobId/continue", requireAuth, (req, res) => {
  const result = continueCodexJob(store, routeParam(req, "jobId"));
  if (!result.ok) {
    res.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  if (!result.job || !result.course) {
    res.status(500).json({ error: "继续生成任务创建失败。" });
    return;
  }
  if (!result.recovered) runCodexJob(store, result.job.id);
  res.json({ job: result.job, course: publicCourse(result.course) });
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
  if (error instanceof AiDraftCodexError) {
    res.status(503).json({
      error: `${error.message}。可以点击“继续生成草稿”从上次日志继续。`,
      draftContinue: {
        logPath: error.logPath
      }
    });
    return;
  }
  res.status(500).json({ error: error.message });
});

app.listen(config.port, () => {
  console.log(`Lesson prep web is running at http://localhost:${config.port}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
});
