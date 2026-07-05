import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { assertWithinWorkspace, listCourseFiles } from "./files.js";
import { nowIso } from "./store.js";
import type { Course, Job } from "./types.js";

export const legacyClassroomPdfFileName = "课堂课件.pdf";
export const fixedCoreOutputFileNames = ["老师逐字稿.md", "知识点详解.md", "课后反馈.md"] as const;

interface RecoveryCandidate {
  dir: string;
  score: number;
  newestMtimeMs: number;
  reason: string;
}

export interface CourseOutputRecoveryResult {
  changed: boolean;
  outputDir: string;
  reason?: string;
}

function sanitizeFilename(value: string, fallback: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function lessonDateSlug(lessonTime: string) {
  if (lessonTime) return lessonTime.replace("T", "_").replace(/:/g, "-").slice(0, 16);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function fallbackStudentName(course: Course) {
  const parent = path.basename(path.dirname(course.outputDir));
  return parent && parent !== "." ? parent : "学生";
}

export function courseClassroomPdfFileName(course: Course, studentName?: string) {
  const name = sanitizeFilename(studentName || fallbackStudentName(course), "学生");
  const time = lessonDateSlug(course.lessonTime);
  const topic = sanitizeFilename(course.desiredContent || "备课", "备课");
  return `${name}_${time}_${topic}.pdf`;
}

export function coreOutputFileNames(course: Course, studentName?: string) {
  return ["老师逐字稿.md", "知识点详解.md", courseClassroomPdfFileName(course, studentName), "课后反馈.md"];
}

function coreOutputSlots(course: Course, studentName?: string) {
  const pdfName = courseClassroomPdfFileName(course, studentName);
  return [
    { name: "老师逐字稿.md", aliases: [] },
    { name: "知识点详解.md", aliases: [] },
    { name: pdfName, aliases: pdfName === legacyClassroomPdfFileName ? [] : [legacyClassroomPdfFileName] },
    { name: "课后反馈.md", aliases: [] }
  ];
}

export function ensureCourseClassroomPdfFileName(course: Course, studentName?: string) {
  const expected = courseClassroomPdfFileName(course, studentName);
  const expectedPath = path.join(course.outputDir, expected);
  if (fs.existsSync(expectedPath)) return expected;

  const legacyPath = path.join(course.outputDir, legacyClassroomPdfFileName);
  if (legacyClassroomPdfFileName !== expected && fs.existsSync(legacyPath)) {
    fs.renameSync(legacyPath, expectedPath);
    return expected;
  }

  const rootPdfs = listCourseFiles(course.outputDir).filter(
    (file) => file.kind === "pdf" && !file.relativePath.includes(path.sep) && !file.relativePath.includes("/")
  );
  if (rootPdfs.length === 1) {
    fs.renameSync(rootPdfs[0].path, expectedPath);
  }
  return expected;
}

function containsCoreOutputs(outputDir: string, course: Course) {
  try {
    const files = listCourseFiles(outputDir);
    const names = new Set(
      files
        .filter((file) => !file.relativePath.replace(/\\/g, "/").startsWith("_attachments/"))
        .map((file) => file.name)
    );
    return coreOutputSlots(course).every((slot) => [slot.name, ...slot.aliases].some((name) => names.has(name)));
  } catch {
    return false;
  }
}

function jobStartedAtMs(job?: Job) {
  const value = job?.startedAt || job?.createdAt || "";
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function coreOutputStats(outputDir: string, course: Course, job?: Job) {
  let newestMtimeMs = 0;
  let matchingFiles = 0;
  let afterJobStart = 0;
  const startedAtMs = jobStartedAtMs(job);
  for (const slot of coreOutputSlots(course)) {
    const filePath = [slot.name, ...slot.aliases].map((name) => path.join(outputDir, name)).find((candidate) => fs.existsSync(candidate));
    if (!filePath) continue;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) continue;
    matchingFiles += 1;
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (!startedAtMs || stat.mtimeMs + 10_000 >= startedAtMs) afterJobStart += 1;
  }
  return { newestMtimeMs, matchingFiles, afterJobStart };
}

function isInsideWorkspace(filePath: string) {
  const root = path.resolve(config.workspaceRoot);
  const resolved = path.resolve(filePath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function extractAbsoluteDirs(text: string) {
  const dirs = new Set<string>();
  const absolutePathPattern = /\/[^\s"'`，。；、：]+/g;
  for (const match of text.matchAll(absolutePathPattern)) {
    const raw = match[0].replace(/[)\].,;:。；，、]+$/g, "");
    if (!raw || !isInsideWorkspace(raw)) continue;
    const resolved = path.resolve(raw);
    const dir = path.extname(resolved) ? path.dirname(resolved) : resolved;
    dirs.add(dir);
  }
  return [...dirs];
}

function readJobLastMessageDirs(job?: Job) {
  if (!job?.lastMessagePath || !fs.existsSync(job.lastMessagePath)) return [];
  const text = fs.readFileSync(job.lastMessagePath, "utf8").slice(-20_000);
  return extractAbsoluteDirs(text);
}

function walkCandidateDirs(root: string, maxDepth = 2) {
  const dirs: string[] = [];
  if (!fs.existsSync(root)) return dirs;

  function walk(dir: string, depth: number) {
    dirs.push(dir);
    if (depth >= maxDepth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(root, 0);
  return dirs;
}

function scoreCandidate(dir: string, course: Course, job: Job | undefined, reason: string): RecoveryCandidate | null {
  const candidateCourse = { ...course, outputDir: dir };
  if (!containsCoreOutputs(dir, candidateCourse)) return null;
  const stats = coreOutputStats(dir, candidateCourse, job);
  if (stats.matchingFiles < coreOutputSlots(course).length) return null;
  if (jobStartedAtMs(job) && stats.afterJobStart < coreOutputSlots(course).length) return null;
  const specified = path.resolve(course.outputDir);
  const resolved = path.resolve(dir);
  const candidateName = path.basename(resolved);
  const specifiedName = path.basename(specified);
  const sameParent = path.dirname(resolved) === path.dirname(specified);
  const nameRelated =
    candidateName === specifiedName ||
    specifiedName.startsWith(candidateName) ||
    candidateName.startsWith(specifiedName) ||
    candidateName.includes(course.desiredContent.trim()) ||
    specifiedName.includes(candidateName);
  let score = 0;
  if (sameParent) score += 30;
  if (nameRelated) score += 30;
  if (reason === "last-message") score += 20;
  score += stats.afterJobStart * 5;
  score += stats.matchingFiles * 2;
  return {
    dir: resolved,
    score,
    newestMtimeMs: stats.newestMtimeMs,
    reason
  };
}

export function findRecoveredCourseOutputDir(course: Course, job?: Job) {
  const specified = assertWithinWorkspace(course.outputDir);
  const candidates = new Map<string, RecoveryCandidate>();
  const addCandidate = (dir: string, reason: string) => {
    if (!isInsideWorkspace(dir)) return;
    const resolved = path.resolve(dir);
    const scored = scoreCandidate(resolved, course, job, reason);
    if (!scored) return;
    const previous = candidates.get(resolved);
    if (!previous || scored.score > previous.score || scored.newestMtimeMs > previous.newestMtimeMs) {
      candidates.set(resolved, scored);
    }
  };

  addCandidate(specified, "specified");
  for (const dir of readJobLastMessageDirs(job)) addCandidate(dir, "last-message");

  const parent = path.dirname(specified);
  for (const dir of walkCandidateDirs(parent, 2)) addCandidate(dir, "sibling-scan");

  const ranked = [...candidates.values()].sort(
    (a, b) => b.score - a.score || b.newestMtimeMs - a.newestMtimeMs || a.dir.localeCompare(b.dir, "zh-CN")
  );
  return ranked[0]?.dir || "";
}

export function recoverCourseOutputDir(course: Course, job?: Job): CourseOutputRecoveryResult {
  const specified = assertWithinWorkspace(course.outputDir);
  if (containsCoreOutputs(specified, course)) {
    return { changed: false, outputDir: specified };
  }

  const recovered = findRecoveredCourseOutputDir(course, job);
  if (!recovered || path.resolve(recovered) === specified) {
    return { changed: false, outputDir: specified };
  }

  const previous = course.outputDir;
  course.outputDir = recovered;
  course.updatedAt = nowIso();
  return {
    changed: true,
    outputDir: recovered,
    reason: `课程产物目录已从 ${previous} 自动修正为 ${recovered}`
  };
}
