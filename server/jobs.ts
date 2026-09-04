import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config, logsDir, materialRoot } from "./config.js";
import { listCourseFiles } from "./files.js";
import { emitJobFinished } from "./jobEvents.js";
import { assessCourseQuality } from "./quality.js";
import {
  coreOutputFileNames,
  courseClassroomPdfFileName,
  courseTeachingPdfFileName,
  ensureCoursePdfFileNames,
  homeworkAnswerPdfFileName,
  homeworkPdfFileName,
  recoverCourseOutputDir
} from "./courseOutput.js";
import { formatOcrResultForPrompt, preprocessFilesWithOcr } from "./ocr.js";
import { buildMemoryPromptSection } from "./memory.js";
import { buildRagPlan, type RagPlan } from "./rag.js";
import type { Course, CoursePostClassSummary, Job, JobArtifactSnapshot, Student } from "./types.js";
import type { Store } from "./store.js";
import { newId, nowIso, sanitizeFilename } from "./store.js";

const activeJobs = new Map<string, Set<ChildProcess>>();
const CODEX_FORCE_KILL_GRACE_MS = 10_000;
const CODEX_TIMEOUT_EXIT_CODE = 124;

function hasActiveJob(jobId: string) {
  return (activeJobs.get(jobId)?.size || 0) > 0;
}

function registerJobChild(jobId: string, child: ChildProcess) {
  const children = activeJobs.get(jobId) || new Set<ChildProcess>();
  children.add(child);
  activeJobs.set(jobId, children);
}

function unregisterJobChild(jobId: string, child: ChildProcess) {
  const children = activeJobs.get(jobId);
  if (!children) return;
  children.delete(child);
  if (children.size === 0) activeJobs.delete(jobId);
}

interface CodexProcessOptions {
  job: Job;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  append: (chunk: Buffer | string) => void;
}

function terminateCodexChild(child: ChildProcess, force = false) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  child.kill(force ? "SIGKILL" : "SIGTERM");
}

function runCodexProcessAttempt(options: CodexProcessOptions) {
  return new Promise<{ code: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
      windowsHide: true
    });
    registerJobChild(options.job.id, child);

    let idleTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const armIdleTimer = () => {
      if (timedOut || config.codexIdleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        const seconds = Math.round(config.codexIdleTimeoutMs / 1000);
        options.append(`\n[watchdog] ${options.label} 连续 ${seconds} 秒无输出，终止当前 Codex 进程。\n`);
        terminateCodexChild(child);
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            options.append(`\n[watchdog] ${options.label} 未在宽限期内退出，执行强制终止。\n`);
            terminateCodexChild(child, true);
          }
        }, CODEX_FORCE_KILL_GRACE_MS);
      }, config.codexIdleTimeoutMs);
    };
    const onOutput = (chunk: Buffer | string) => {
      options.append(chunk);
      armIdleTimer();
    };

    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      unregisterJobChild(options.job.id, child);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      unregisterJobChild(options.job.id, child);
      resolve({ code, timedOut });
    });

    armIdleTimer();
    child.stdin.end(options.prompt);
  });
}

async function runCodexProcessWithRetry(options: CodexProcessOptions) {
  const attempts = config.codexIdleMaxRetries + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isJobCanceled(options.job)) return null;
    if (attempt > 1) {
      options.append(`\n[watchdog] ${options.label} 开始第 ${attempt} 次尝试（自动重试 ${attempt - 1}/${config.codexIdleMaxRetries}）。\n`);
    }
    const result = await runCodexProcessAttempt(options);
    if (isJobCanceled(options.job)) return null;
    if (!result.timedOut) return result.code;
    if (attempt < attempts) {
      options.append(`\n[watchdog] ${options.label} 因无输出超时，将自动重试。\n`);
    }
  }
  options.append(`\n[watchdog] ${options.label} 已用完 ${config.codexIdleMaxRetries} 次自动重试，按超时失败处理。\n`);
  return CODEX_TIMEOUT_EXIT_CODE;
}

function codexExitError(code: number | null) {
  if (code === CODEX_TIMEOUT_EXIT_CODE) {
    const seconds = Math.round(config.codexIdleTimeoutMs / 1000);
    return `Codex 连续 ${seconds} 秒无输出，自动重试 ${config.codexIdleMaxRetries} 次后仍超时。`;
  }
  return `Codex exited with code ${code}.`;
}

function isJobCanceled(job: Job) {
  return job.status === "canceled";
}

function isPdfImageRefineJob(job: Job) {
  return job.kind === "pdf-image-refine";
}

function fileSha256(filePath: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pdfArtifactInfo(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const stat = fs.statSync(filePath);
  return {
    sha256: fileSha256(filePath),
    size: stat.size,
    mtime: stat.mtime.toISOString()
  };
}

function capturePdfArtifactSnapshot(course: Course, studentName?: string): JobArtifactSnapshot {
  const finalPdfPath = path.join(course.outputDir, courseClassroomPdfFileName(course, studentName));
  const workPdfPath = path.join(course.outputDir, "_work", "课堂讲义.pdf");
  const finalPdf = pdfArtifactInfo(finalPdfPath);
  const workPdf = pdfArtifactInfo(workPdfPath);
  return {
    workPdfPath,
    workPdfSha256: workPdf.sha256,
    workPdfSize: workPdf.size,
    workPdfMtime: workPdf.mtime,
    finalPdfPath,
    finalPdfSha256: finalPdf.sha256,
    finalPdfSize: finalPdf.size,
    finalPdfMtime: finalPdf.mtime
  };
}

function isIsoAfter(value: string | undefined, baseline: string | undefined) {
  if (!value || !baseline) return false;
  return Date.parse(value) > Date.parse(baseline);
}

function validatePdfImageRefineArtifacts(job: Job, course: Course, studentName: string) {
  const after = capturePdfArtifactSnapshot(course, studentName);
  job.artifactAfter = after;

  const errors: string[] = [];
  if (!after.workPdfSha256) errors.push("未找到重新编译后的 _work/课堂讲义.pdf");
  if (!after.finalPdfSha256) errors.push("未找到最终课堂 PDF");
  if (after.workPdfSha256 && after.finalPdfSha256 && after.workPdfSha256 !== after.finalPdfSha256) {
    errors.push("工作 PDF 和最终 PDF 哈希不一致，可能没有把新 PDF 复制到最终路径");
  }
  if (after.workPdfSha256 && !isIsoAfter(after.workPdfMtime, job.startedAt)) {
    errors.push("_work/课堂讲义.pdf 不是本次任务开始后生成的");
  }
  if (after.finalPdfSha256 && !isIsoAfter(after.finalPdfMtime, job.startedAt)) {
    errors.push("最终 PDF 不是本次任务开始后生成的");
  }
  if (job.artifactBefore?.finalPdfSha256 && after.finalPdfSha256 === job.artifactBefore.finalPdfSha256) {
    errors.push("最终 PDF 哈希与任务开始前相同，说明没有产出新 PDF");
  }
  if (job.artifactBefore?.workPdfSha256 && after.workPdfSha256 === job.artifactBefore.workPdfSha256) {
    errors.push("工作 PDF 哈希与任务开始前相同，说明没有重新编译 PDF");
  }

  return errors;
}

interface CodexJobOptions {
  refineInstruction?: string;
  ocrContext?: string;
  kind?: Job["kind"];
  supplementalFiles?: string[];
  pdfRefinePages?: string;
}

function isLightweightRefineInstruction(refineInstruction?: string) {
  return (
    refineInstruction?.startsWith("这是一次“继续生成”") ||
    refineInstruction?.startsWith("这是系统根据质量检查自动发起的补救生成")
  ) || false;
}

function quoteArg(value: string) {
  if (/^[\w.:\-/\\]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function shQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function courseTypeLabel(type: Course["type"]) {
  return type === "trial" ? "试听课" : "正式课";
}

function skillName(type: Course["type"]) {
  return type === "trial" ? "trial-lesson-prep" : "formal-lesson-prep";
}

function packagedSkillDir(type: Course["type"]) {
  return path.join(config.projectRoot, "skills", skillName(type));
}

function runnerWorkspace() {
  if (config.codexRunner === "ssh" && config.codexRemoteWorkspace) return config.codexRemoteWorkspace;
  return config.workspaceRoot;
}

function toRunnerPath(filePath: string) {
  if (config.codexRunner !== "ssh" || !config.codexRemoteWorkspace) return filePath;

  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;

  const root = path.resolve(config.workspaceRoot);
  const resolved = path.resolve(trimmed);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return filePath;

  const relative = path.relative(root, resolved).split(path.sep).filter(Boolean);
  return relative.length === 0 ? config.codexRemoteWorkspace : path.posix.join(config.codexRemoteWorkspace, ...relative);
}

function toRunnerProjectPath(filePath: string) {
  if (config.codexRunner !== "ssh") return filePath;

  const projectRoot = path.resolve(config.projectRoot);
  const resolved = path.resolve(filePath);
  const isInsideProject = resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`);
  if (isInsideProject && config.codexRemoteProjectRoot) {
    const relative = path.relative(projectRoot, resolved).split(path.sep).filter(Boolean);
    return relative.length === 0 ? config.codexRemoteProjectRoot : path.posix.join(config.codexRemoteProjectRoot, ...relative);
  }

  return toRunnerPath(filePath);
}

function mapRunnerPaths(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => toRunnerPath(line))
    .join("\n");
}

function localFilePathsFromCourse(course: Course) {
  return course.localFiles
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^https?:\/\//i.test(item));
}

function readSmallFile(filePath: string, maxChars = 8000) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  return content.slice(-maxChars);
}

function courseSortTime(course: Course) {
  return Date.parse(course.lessonTime || course.createdAt || course.updatedAt || "") || 0;
}

function extractSection(text: string, headings: string[], maxChars = 3000) {
  if (!text.trim()) return "";
  const headingPattern = headings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = new RegExp(`(^|\\n)(#{1,4}\\s*)?(${headingPattern})[^\\n]*\\n`, "i").exec(text);
  if (!match || match.index < 0) return "";
  const start = match.index + match[0].length;
  const next = /\n#{1,4}\s+/.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return text.slice(start, end).trim().slice(0, maxChars);
}

function readCourseContextFile(course: Course, fileName: string, maxChars = 5000) {
  return readSmallFile(path.join(course.outputDir, fileName), maxChars).trim();
}

function compactWhitespace(value: string, maxChars: number) {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
}

function lessonMemoryLabel(course: Course) {
  const date = (course.lessonTime || course.createdAt || "").slice(0, 10) || "[日期待确认]";
  return `${date} ${courseTypeLabel(course.type)} ${course.desiredContent || "[主题待确认]"}`;
}

function appendAutoEntry(existing: string | undefined, course: Course, kind: string, body: string, maxEntries = 8) {
  const cleanBody = compactWhitespace(body, 1800);
  if (!cleanBody) return existing || "";
  const marker = `<!-- auto:${kind}:${course.id} -->`;
  const current = (existing || "").trim();

  const heading = "---\n自动课后沉淀：";
  const headingIndex = current.indexOf(heading);
  const manual = headingIndex >= 0 ? current.slice(0, headingIndex).trim() : current;
  const auto = headingIndex >= 0 ? current.slice(headingIndex + heading.length).trim() : "";
  const entries = auto
    .split(/\n\n(?=<!-- auto:)/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nextEntry = `${marker}\n【${lessonMemoryLabel(course)}】\n${cleanBody}`;
  const existingIndex = entries.findIndex((entry) => entry.includes(marker));
  if (existingIndex >= 0) {
    entries[existingIndex] = nextEntry;
  } else {
    entries.push(nextEntry);
  }
  const recentEntries = entries.slice(-maxEntries).join("\n\n");
  return [manual, recentEntries ? `${heading}\n${recentEntries}` : ""].filter(Boolean).join("\n\n");
}

function latestNonEmpty(...values: string[]) {
  return values.map((value) => compactWhitespace(value, 1800)).find(Boolean) || "";
}

export function buildPostClassSummaryDraft(course: Course): CoursePostClassSummary {
  const feedback = readCourseContextFile(course, "课后反馈.md", 12000);
  const continuity = readCourseContextFile(course, "_work/连续学习档案.md", 12000);
  const script = readCourseContextFile(course, "老师逐字稿.md", 10000);

  return {
    status: "draft",
    linkedPrevious: latestNonEmpty(
      extractSection(continuity, ["上节课承接", "与上节课的衔接", "本节承接目标"], 1600),
      extractSection(feedback, ["与上节课的衔接"], 1600)
    ),
    learned: latestNonEmpty(
      extractSection(continuity, ["本节课新增进展", "本节新增", "本节课目标", "本节承接目标"], 1800),
      extractSection(feedback, ["本节课主要学习内容", "学习内容"], 1800)
    ),
    mastered: latestNonEmpty(
      extractSection(feedback, ["知识掌握情况", "学生课堂表现"], 1800),
      extractSection(continuity, ["已掌握", "课堂表现", "本节课新增进展"], 1800)
    ),
    unresolved: latestNonEmpty(
      extractSection(continuity, ["需要回收的旧问题", "未解决问题", "待回收问题", "本节课待观察问题"], 1800),
      extractSection(feedback, ["课堂问题与改进方向", "待提升点"], 1800)
    ),
    commonMistakes: latestNonEmpty(
      extractSection(continuity, ["常错题型", "常见错误", "待回收问题"], 1800),
      extractSection(feedback, ["课堂问题与改进方向", "待提升点"], 1800)
    ),
    homework: latestNonEmpty(
      extractSection(feedback, ["课后作业"], 1600),
      extractSection(continuity, ["课后作业", "课后巩固"], 1600)
    ),
    nextLessonSuggestion: latestNonEmpty(
      extractSection(continuity, ["下节课建议", "下次课建议", "下一节建议", "课后沉淀给下节课"], 1800),
      extractSection(feedback, ["下节课建议", "后续建议", "学习建议"], 1800),
      extractSection(script, ["课程总结（结束前2分钟）", "课程总结"], 1800)
    ),
    teacherNotes: "",
    updatedAt: nowIso()
  };
}

export function applyPostClassSummaryToStudent(student: Student, course: Course, summary: CoursePostClassSummary) {
  const learned = summary.learned || "";
  const unresolved = summary.unresolved || summary.commonMistakes || "";
  const homework = summary.homework || "";
  const nextSuggestion = summary.nextLessonSuggestion || "";
  const linkedPrevious = summary.linkedPrevious || "";
  const teacherNotes = summary.teacherNotes || "";

  const memoryBody = [
    linkedPrevious ? `承接：${linkedPrevious}` : "",
    learned ? `已学/新增：${learned}` : "",
    unresolved ? `待回收/薄弱：${unresolved}` : "",
    homework ? `作业/巩固：${homework}` : "",
    nextSuggestion ? `下节课建议：${nextSuggestion}` : "",
    teacherNotes ? `老师补充：${teacherNotes}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  student.learningMemory = appendAutoEntry(student.learningMemory, course, "learningMemory", memoryBody, 12);

  if (unresolved) {
    student.weakPoints = appendAutoEntry(student.weakPoints, course, "weakPoints", unresolved, 8);
  }
  if (summary.commonMistakes || unresolved) {
    student.commonMistakes = appendAutoEntry(student.commonMistakes, course, "commonMistakes", summary.commonMistakes || unresolved, 8);
  }
  if (nextSuggestion) {
    student.nextLessonSuggestion = compactWhitespace(`【来自 ${lessonMemoryLabel(course)}】\n${nextSuggestion}`, 3000);
    student.learningRoadmap = appendAutoEntry(student.learningRoadmap, course, "learningRoadmap", `下一课建议：${nextSuggestion}`, 10);
  }
  student.updatedAt = nowIso();
}

function buildSinglePreviousCourseContext(course: Course, index: number) {
  const feedback = readCourseContextFile(course, "课后反馈.md", 7000);
  const script = readCourseContextFile(course, "老师逐字稿.md", 9000);
  const knowledge = readCourseContextFile(course, "知识点详解.md", 5000);

  const feedbackFocus = [
    extractSection(feedback, ["本节课主要学习内容", "学习内容"], 1600),
    extractSection(feedback, ["知识掌握情况"], 1600),
    extractSection(feedback, ["课堂问题与改进方向", "待提升点"], 1600),
    extractSection(feedback, ["课后作业"], 1400),
    extractSection(feedback, ["学习建议", "后续建议"], 1400)
  ]
    .filter(Boolean)
    .join("\n\n");

  const scriptSummary = extractSection(script, ["课程总结（结束前2分钟）", "课程总结"], 2200);
  const knowledgeScope = extractSection(knowledge, ["课程定位", "本节范围边界", "知识结构总览"], 1600);

  return [
    `### 历史课 ${index + 1}`,
    `- 课程ID：${course.id}`,
    `- 课型：${courseTypeLabel(course.type)} / ${course.lessonKind || "[待确认]"}`,
    `- 上课时间：${course.lessonTime || "[待确认]"}`,
    `- 主题：${course.desiredContent || "[待确认]"}`,
    `- 产物目录：${toRunnerPath(course.outputDir)}`,
    course.notes ? `- 当时备课要求摘录：${course.notes.slice(0, 1200)}` : "",
    feedbackFocus ? `\n课后反馈关键信息：\n${feedbackFocus}` : "",
    !feedbackFocus && feedback ? `\n课后反馈尾部摘录：\n${feedback.slice(-2800)}` : "",
    scriptSummary ? `\n老师逐字稿中的课程总结：\n${scriptSummary}` : "",
    knowledgeScope ? `\n知识点范围摘录：\n${knowledgeScope}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildStudentContinuityContext(store: Store, student: Student, course: Course) {
  const currentTime = courseSortTime(course) || Date.now();
  const previousCourses = store.data.courses
    .filter((item) => item.studentId === student.id && item.id !== course.id)
    .filter((item) => item.status === "completed")
    .filter((item) => {
      const itemTime = courseSortTime(item);
      return !itemTime || !currentTime || itemTime <= currentTime || item.createdAt < course.createdAt;
    })
    .sort((a, b) => courseSortTime(b) - courseSortTime(a))
    .slice(0, 3);

  const allStudentCourses = store.data.courses
    .filter((item) => item.studentId === student.id && item.id !== course.id)
    .sort((a, b) => courseSortTime(a) - courseSortTime(b));

  const courseTimeline =
    allStudentCourses.length > 0
      ? allStudentCourses
          .map(
            (item, index) =>
              `${index + 1}. ${item.lessonTime || item.createdAt || "[待确认]"} / ${courseTypeLabel(item.type)} / ${item.status} / ${item.desiredContent || "[待确认]"} / ${toRunnerPath(item.outputDir)}`
          )
          .join("\n")
      : "[无历史课程]";

  const previousDetails =
    previousCourses.length > 0
      ? previousCourses.map(buildSinglePreviousCourseContext).join("\n\n---\n\n")
      : "这是该学生在系统中的第一节已完成课，或暂无可用历史产物。请把本节课作为连续学习档案的起点，并明确本节课后要沉淀哪些诊断信息。";

  return `
学生目录：${toRunnerPath(path.join(config.workspaceRoot, sanitizeFilename(student.name, "学生")))}

学生长期档案：
- 学生姓名：${student.name || "[待确认]"}
- 学段/年级画像：${student.stage || "[待确认]"}
- 长期画像：${student.notes || "[无]"}
- 累计薄弱点：${student.weakPoints || "[无]"}
- 累计常错题型/方法问题：${student.commonMistakes || "[无]"}
- 家长/老师长期关注：${student.parentNotes || "[无]"}
- 系统记录的下次课建议：${student.nextLessonSuggestion || "[无]"}
- 自动连续学习记忆：${student.learningMemory || "[无]"}
- 长期学习路线图：${student.learningRoadmap || "[无]"}

该学生历史课程时间线：
${courseTimeline}

最近可承接课程详情：
${previousDetails}
`.trim();
}

function buildExistingWorkContext(store: Store, course: Course) {
  const files = listCourseFiles(course.outputDir)
    .map((file) => `- ${file.kind}: ${toRunnerPath(file.path)}`)
    .join("\n");
  const previousJob = store.data.jobs
    .filter((job) => job.courseId === course.id && job.status === "completed")
    .sort((a, b) => (b.endedAt || b.createdAt).localeCompare(a.endedAt || a.createdAt))[0];
  const previousMessage = previousJob?.lastMessagePath ? readSmallFile(previousJob.lastMessagePath) : "";

  return [
    files ? `现有产物文件：\n${files}` : "现有产物文件：暂无可预览文件。",
    previousMessage ? `上一次 Codex 最终回复摘录：\n${previousMessage}` : "上一次 Codex 最终回复摘录：暂无。"
  ].join("\n\n");
}

function buildAutoQualityRefineInstruction(course: Course, failedJob: Job, student?: Student) {
  const outputNames = coreOutputFileNames(course, student?.name).join("、");
  const issueLines =
    failedJob.quality?.items
      .filter((check) => check.status === "fail" || check.status === "warn")
      .slice(0, 12)
      .map((check) => `- ${check.label}：${check.message}`)
      .join("\n") || "- 质量检查未通过，但没有详细条目。";

  return `
这是系统根据质量检查自动发起的补救生成，不要从零重做。

本次只补救以下问题：
${issueLines}

补救要求：
1. 先阅读课程目录现有文件，保留可用内容。
2. 必须补齐或修正 _work/连续学习档案.md、_work/题目提取.md、_work/候选题池.md、_work/答案核对表.md、_work/课件生成计划.md、_work/逐字稿丰富清单.md。
3. 若题量不足，按 ${course.type === "trial" ? "试听课" : "正式课"} 和 ${course.durationMinutes} 分钟课长补充诊断、例题、变式、巩固、作业或口头微变式。
4. 若答案核对表缺项或有存疑题，逐题重算并写清最终答案、关键条件、关键步骤、易错点、核对结论。
5. 若逐字稿存在跳步或内容薄，按课堂页码逐页补老师说、追问、学生可能回答、纠错话术、板书或批注。
6. 若课堂 PDF 中有几何图、函数图、坐标系或统计图，必须检查并修正图像质量：图要足够大，点名不重叠，主线/辅助线层次清楚，立体图的平行、垂直、中点、截面、动点位置与题设一致；必要时拆成“原图 + 建系/向量图”两个图。
7. 最终产物必须全部可用：${outputNames}；最终产物不需要标注本地PDF来源，只有真题/模考题需要可靠来源。
`.trim();
}

function buildContinueInstruction(store: Store, course: Course, failedJob: Job, student?: Student) {
  const outputNames = coreOutputFileNames(course, student?.name).join("、");
  const logTail = failedJob.logPath ? readSmallFile(failedJob.logPath, 60000) : "";
  const lastMessage = failedJob.lastMessagePath ? readSmallFile(failedJob.lastMessagePath, 30000) : "";
  const existingFiles = listCourseFiles(course.outputDir)
    .map((file) => `- ${file.kind}: ${toRunnerPath(file.path)}`)
    .join("\n");

  return `
这是一次“继续生成”，不是从零重做。上一次 Codex 备课任务中断、失败或遇到限流后，用户要求继续。

继续目标：
1. 先阅读课程目录现有文件，保留已经可用的内容，不要删除已完成产物。
2. 读取上一次任务日志和 last message，确认已经完成到哪一步、已经读过哪些 PDF/题目、哪些文件已写出。
3. 从中断点继续完成缺失内容，最终仍需保证全部核心产物完整可用：${outputNames}。
4. 如果上次日志里已经识别了题目、答案核对、课堂主线或 PDF 页码，直接沿用并继续补全，不要重复大范围检索和重复读整份材料。
5. 如果已有部分 _work 文件或最终文件，先补缺和修正，再继续生成；不要因为继续任务而降低质量门禁。
6. 若上次失败原因是 429 Too Many Requests、网络中断、session 记录失败或进程退出，忽略该系统错误本身，继续完成备课内容。

课程目录现有文件：
${existingFiles || "[暂无]"}

上一次任务状态：
- jobId: ${failedJob.id}
- status: ${failedJob.status}
- exitCode: ${failedJob.exitCode ?? "[无]"}
- error: ${failedJob.error || "[无]"}
- startedAt: ${failedJob.startedAt || "[无]"}
- endedAt: ${failedJob.endedAt || "[无]"}

上一次 Codex 最终回复/last message：
${lastMessage || "[无]"}

上一次任务日志尾部：
${logTail || "[无]"}
`.trim();
}

function formatRagResult(result: RagPlan["selected"][number], index: number) {
  const question = result.question;
  const sourceText = question
    ? [
        `题号：${question.questionNumber || question.label}`,
        `来源状态：${question.sourceKind}`,
        question.examSource ? `考试来源：${question.examSource}` : "",
        `题型：${question.questionType}`,
        `难度：${question.difficulty}`,
        `教学角色：${question.teachingRoles.join("、")}`,
        question.hasAnswer ? "答案解析：有" : "答案解析：未检测到，需独立验算"
      ]
        .filter(Boolean)
        .join("；")
    : `资料片段：${result.snippet?.kind || "reference"}`;
  return [
    `【候选 ${index + 1}】${result.material.title}`,
    `路径：${toRunnerPath(result.material.path)}`,
    `相关度：${result.score}`,
    `命中原因：${result.reason}`,
    `匹配标签：${result.matchedTags.length > 0 ? result.matchedTags.join("、") : "[无]"}`,
    sourceText,
    question ? `题面摘录：${result.excerpt}` : `参考摘录：${result.excerpt}`
  ].join("\n");
}

function formatConfirmedAiDraft(student: Student, course: Course, memoryPromptSection?: string) {
  return `
用户确认后的 AI 草稿（这是本次调用 Codex 的主依据，已包含用户手动修改后的字段）：
- 学生姓名：${student.name || "[待确认]"}
- 学生长期画像：${student.notes || "[无]"}
- 薄弱点：${student.weakPoints || "[无]"}
- 常错题型/方法：${student.commonMistakes || "[无]"}
- 家长/老师沟通：${student.parentNotes || "[无]"}
- 下次课建议：${student.nextLessonSuggestion || "[无]"}
- 自动连续学习记忆：${student.learningMemory || "[无]"}
- 长期学习路线图：${student.learningRoadmap || "[无]"}
- 学段：${course.stage || "[待确认]"}
- 年级：${course.grade || "[待确认]"}
- 当前分数/水平：${course.score || "[待确认]"}
- 省市/试卷地区：${course.province || "[待确认]"}
- 教材版本：${course.textbook || "[待确认]"}
- 课程类型：${courseTypeLabel(course.type)}
- 课程性质：${course.lessonKind || "[待确认]"}
- 本次课程主题：${course.desiredContent || "[待确认]"}
- 上课时间：${course.lessonTime || "[待确认]"}
- 课长：${course.durationMinutes || "[待确认]"} 分钟
- 用户提供的本地题目/资料路径：${course.localFiles ? mapRunnerPaths(course.localFiles) : "[无]"}

AI 整理的备课执行要求 / 原始沟通材料（辅助依据，不能覆盖上面用户确认后的结构化字段）：
${course.notes || "[无]"}

系统记忆管理条目（长期保留，教师可人工增删改/停用；本段落是经筛选后写入 Prompt 的有效记忆）：
${memoryPromptSection || "暂无额外记忆条目。"}

数量与范围优先级：用户在课程主题、资料说明或补充要求中明确指定的题目数量、每类题型数量、资料覆盖范围和顺序是硬约束，优先于课长、历史学习建议、AI 草稿中的筛选建议和教学节奏判断。一份 PDF 或整套资料可以跨多次课讲完；必须先完整产出用户要求的题目集合，再另行给出分课建议，不能用课时长度删题。
`.trim();
}

async function buildRagContext(store: Store, course: Course, skipFullRag = false) {
  const ragPlan = skipFullRag ? null : await buildRagPlan(store, course, 8);
  const pool = ragPlan?.candidatePool;
  return !ragPlan
    ? "这是补充/继续生成任务：跳过本轮自动 RAG 重检索，优先使用质量检查结果、上一次日志、课程目录现有文件、用户上传资料路径和已提取题目继续完成。必要时只做最小范围补查。"
    : ragPlan.selected.length === 0
    ? "本地 RAG 暂无命中资料。仍需按 skill 要求搜索本地资料库和可靠网页来源。"
    : [
        `检索查询：${ragPlan.query || "[空]"}`,
        `意图标签：${ragPlan.intentTags.length > 0 ? ragPlan.intentTags.join("、") : "[未识别]"}`,
        "",
        "候选题池 - 可直接上课：",
        ...(pool && pool.direct.length > 0 ? pool.direct.map(formatRagResult) : ["[无]"]),
        "",
        "候选题池 - 可改编为变式/巩固：",
        ...(pool && pool.variants.length > 0 ? pool.variants.map(formatRagResult) : ["[无]"]),
        "",
        "候选题池 - 可做作业：",
        ...(pool && pool.homework.length > 0 ? pool.homework.map(formatRagResult) : ["[无]"]),
        "",
        "候选资料 - 知识点/解析参考：",
        ...(pool && pool.reference.length > 0 ? pool.reference.map(formatRagResult) : ["[无]"]),
        "",
        "综合入选候选：",
        ...ragPlan.selected.map(formatRagResult),
        ragPlan.rejected.length > 0
          ? [
              "",
              "未入选候选：",
              ...ragPlan.rejected.map((item) => `- ${item.title}（${item.score}）：${item.reason}`)
            ].join("\n")
          : ""
      ]
        .filter(Boolean)
        .join("\n\n");
}

export async function buildCodexPrompt(store: Store, student: Student, course: Course, options: CodexJobOptions = {}) {
  const skillDir = packagedSkillDir(course.type);
  const skillMd = path.join(skillDir, "SKILL.md");
  const classroomPdfName = courseClassroomPdfFileName(course, student.name);
  const teachingPdfName = courseTeachingPdfFileName(course, student.name);
  const finalOutputNames = coreOutputFileNames(course, student.name).join("、");
  const outputCountLabel = course.type === "formal" ? "七个" : "四个";
  const pdfFileRequirements =
    course.type === "formal"
      ? `- 原版学生课堂 PDF 文件名必须使用：${classroomPdfName}\n   - 新增教师授课一体版 PDF 文件名必须使用：${teachingPdfName}\n   - 学生课后作业 PDF 文件名必须使用：${homeworkPdfFileName}\n   - 教师参考答案 PDF 文件名必须使用：${homeworkAnswerPdfFileName}\n   - 四份 PDF 都必须生成且用途分离，不能互相覆盖。`
      : `- 课堂 PDF 文件名必须使用：${classroomPdfName}`;
  const formalPdfRules =
    course.type === "formal"
      ? `23. 正式课必须从同一份已核对题序生成两份 A4 竖版 PDF，不是 PPT：
   - ${classroomPdfName} 保持原来的学生课堂讲义形态：系统知识梳理 -> 题目/题组 -> 必要的套路总结；只放学生可见知识、题面、必要图形/表格/坐标系和干净书写留白，绝不放答案、完整过程、教师话术、提示揭晓页或来源说明。
   - ${teachingPdfName} 是教师授课一体版。按每道题或连续小题组依次编排：一级知识点 -> 二级知识点/二级结论 -> 二级结论来源、适用条件、逐步推导、每一步理由和失效边界 -> 对应题目与图 -> 老师自然逐字话术 -> 学生可能回答 -> 分层提示 -> 完整不跳步解答 -> 验算/充分性 -> 常见错误与纠正 -> 迁移追问。
   - 一级知识点必须先写本题依赖的定义、对象、符号、标准形式和基础性质；二级知识点必须写“如何推出来”，不能只列公式。相关知识紧邻对应题目，老师从一体版第 1 页顺序讲到最后，不需要打开 Markdown 或来回翻页。
   - 两份 PDF 必须使用相同的可见题号、题序、题面和关联图，统一写“第X题”，不显示本地 PDF 页码。
   - 先检查 OCR Markdown 或源文件提取目录。已有与题目对应且清晰、数学关系正确的原图时，必须直接复用或裁切原图；只有原图缺失、模糊、关系错误或用户明确要求时才程序化重画，并在 _work/课件生成计划.md 或 _work/答案核对表.md 记录原因。
   - 使用 skill 的 assets/tablet-beamer-template.tex 分别建立 _work/课堂讲义.tex 和 _work/授课一体版.tex，分别编译成 _work/课堂讲义.pdf 与 _work/授课一体版.pdf，再复制到两个指定最终文件名。
   - 为两份 PDF 分别生成 _work/课件页码映射.md 与 _work/授课一体版页码映射.md。页码映射只用于核对，不是 Markdown 分支开工的前置条件。
   - 几何/函数/统计图必须准确、足够大、标签不重叠。编译后检查两个 PDF 均非空、可打开、A4 尺寸合理，并用缩略 contact sheet 做整体视觉检查。`
      : `23. ${classroomPdfName} 的形态必须遵守所选 skill 的课堂 PDF 规则，使用 A4 竖版讲义模板，保留学生可见内容、必要图形和书写空间，并完成编译与缩略视觉检查。`;
  const continuityContext = buildStudentContinuityContext(store, student, course);
  const memoryPromptSection = buildMemoryPromptSection(store, student, course);
  const skipFullRag = isLightweightRefineInstruction(options.refineInstruction);
  const ragContext = await buildRagContext(store, course, skipFullRag);

  const basePrompt = `
请使用项目内置备课 skill：${skillName(course.type)}，为下面学生准备一节${courseTypeLabel(course.type)}。

项目内置 skill 位置：
- skill 目录：${toRunnerProjectPath(skillDir)}
- SKILL.md：${toRunnerProjectPath(skillMd)}

执行要求：
1. 先完整阅读上面的 SKILL.md。
2. 如果 SKILL.md 引用 references、scripts 或 assets，请按 skill 目录的相对路径读取和使用。
3. 不要依赖个人 ~/.codex/skills 里是否安装了同名 skill；以项目内置版本为准。

硬性要求：
1. 工作目录是 ${runnerWorkspace()}
2. 所有最终产物必须保存到这个课程目录：${toRunnerPath(course.outputDir)}
   - 课程目录已由系统按文件系统长度限制安全命名。必须直接使用上面的现成路径，不要从完整课程主题重新拼接目录，也不要另建同级目录。
3. 必须生成 skill 要求的${outputCountLabel}用户可用产物：${finalOutputNames}
   ${pdfFileRequirements}
   - 不要把课堂 PDF 保存为旧固定名“课堂课件.pdf”。
4. 不要修改 lesson-prep-web 项目文件，不要移动无关历史备课文件
5. 如果信息不足，请按 skill 规则使用 [待确认]，但仍生成可上课的初稿
6. 资料库根目录是 ${toRunnerPath(materialRoot)}
7. 优先阅读并使用“用户提供的本地题目/资料路径”中的文件；这些是人工指定资料，优先级高于自动 RAG
8. 按下面的 RAG 检索计划使用入选资料：先阅读路径，再判断哪些题型/讲法适合本课；不要只复制摘录
9. 仍需按 skill 要求做本地资料库检索和可靠网页真题检索，必要时补充 RAG 未覆盖的真题
10. 大任务固定使用多 Agent/子任务分工；备课任务默认拆成四个工作流：题目提取、答案核对、课件生成、逐字稿和内容丰富。主 Agent 负责分派、整合和最终质量门禁，不能跳过答案核对、题量补充和逐字稿扩写。
11. 必须使用“同一学生连续学习上下文”。先判断这是不是该学生第一节课；如果有历史课，必须阅读最近历史课的关键信息，提炼“上节课已解决什么、仍需回收什么、这节课如何承接、下节课如何延伸”。不能把本节课写成与历史无关的全新孤立备课。
12. 必须先生成中间工作文件，再生成全部最终产物；中间文件放在课程目录的 _work/ 下：
   - _work/连续学习档案.md：整理同一学生历史课摘要、本节承接目标、需要回收的旧问题、复习检测安排、本节新目标、课后沉淀给下节课的建议。若无历史课，也要写“首课连续档案起点”。
   - _work/题目提取.md：列出从用户上传 PDF/图片、本地资料、RAG、网页真题中提取的题目，标注教学角色、难度、是否真题、是否进入课件、图形/文字是否清晰；如果 skill 内部沿用旧名 _work/题目索引.md，也要保证同等信息完整。
   - _work/候选题池.md：把本地资料、RAG、网页真题整理成候选题池，区分可直接上课、可改编成变式、只适合作参考、不采用。
   - _work/答案核对表.md：逐题写最终答案、关键条件、关键步骤、易错点、核对结论；不能出现未核对题。
   - _work/课件生成计划.md：${course.type === "formal" ? "分别规划原版学生讲义与授课一体版的模块/页序、题号、图形来源、留白和内容边界" : "按课堂 PDF 页序写每页内容、题目编号、图形/表格需求和留白安排"}；页码映射是生成后的核对文件，不是逐字稿或知识详解开始生成的前置条件。
   - _work/逐字稿丰富清单.md：按页面/题目列出逐字稿需要覆盖的教师话术、追问、预设学生回答、纠错话术、板书或批注提示、补充变式；如果已有 _work/内容丰富清单.md，也要覆盖这些信息。
13. 采用两阶段内部流程：第一阶段完成连续学习档案、题目提取、候选题池、答案核对、课程骨架；第二阶段让 PDF 分支与 Markdown 分支异步并行，最后检查全部产物。逐字稿和知识点详解按统一题序/课件生成计划生成，不等待 PDF 页码映射。
14. 内容必须充实：题目序列要覆盖上节内容回收、诊断、例题、变式、巩固、课后作业，逐字稿要按课堂页码逐页展开讲法、追问、学生可能反应、纠错话术和板书提示；不能只生成少量题或简略提纲。
14A. 正式课默认另生成4道课后题及完整参考答案。除非用户明确指定其他数量，否则必须严格为4题。题目必须基于本节最新课程内容、已核对题序和对应 OCR/本地资料，覆盖本节核心方法与边界检查，但不得机械照抄课堂原题。每题都要在 _work/答案核对表.md 中独立核验。学生版只放题目、必要图形和书写空间；答案版写完整过程、条件、边界、验算与最终结论。
15. 所有最终产物必须体现连续性：
   - 老师逐字稿.md：开头加入“上节课承接与本节落点”或“首课诊断起点”，写清旧问题回收题、旧方法迁移到新知识的桥、下节课钩子；结尾的课程总结必须给出“本节沉淀给下节课的信息”。
   - 知识点详解.md：加入“前后课程衔接”小节，说明本节知识依赖上节哪些基础、为下节哪些题型铺路。
   - 原版课堂 PDF：如有历史课，在题目序列前安排 1 个短小的学生可见旧知回收题，不放教师历史说明或答案。
   ${course.type === "formal" ? "- 授课一体版 PDF：同一旧知回收题旁写出教师话术、预期回答、纠正和进入新课的桥。" : ""}
   - 课后反馈.md：除原有结构外，必须写“与上节课的衔接”和“下节课建议”，方便下一次继续备课读取。
16. 资料详细程度与学生分数段无关：无论学生多少分，“知识点详解.md”和“老师逐字稿.md”都必须按最高备课密度写，让老师拿着资料直接讲，不会在“这一步为什么可以这样做”上卡壳。“60分学生能听懂”只是语言清晰度和前置铺垫的最低门槛，不是降低资料深度的理由。
17. 知识点详解必须区分“一般结论”和“二级结论”：
   - 一般结论（定义、标准方程、基本符号、课本直接性质）可以直接给出，但必须写清成立条件、符号含义和易错边界。
   - 二级结论（焦半径、通径、焦点弦、弦长公式、中点弦/点差法、角相等转斜率、定点定值整理、参数法少算一个根、韦达条件转换、面积/距离快捷表达等）必须详细写出“从哪里来、逐步推导、每一步为什么成立、什么时候不能用、课堂怎么讲”。不能只列公式或只说“由结论得”。推导时必须拆到最小可教学步骤，展开、移项、通分、因式分解、除以非零量、开方、代入定义、检查参数范围都要分开写。
18. 题目过程必须“一小步都不能跳”，比普通板书更细。每道题都要说明：为什么这样设、为什么这样消元、为什么能用这个公式/结论、每一步代数如何展开和化简、哪里需要验算或讨论特殊情况。禁止用“显然”“直接可得”“代入整理得”“通分化简得”“由韦达可得”“联立解得”跳过关键过程；必须写出中间等式链和操作理由，尤其是通分、因式分解、韦达代入、向量/角度/斜率转换。
19. 如果题目使用了二级结论，必须在题目解答处复述必要推导或明确指向“知识点详解.md”中对应推导，并检查本题是否满足适用条件。
20. 课长最低题量标准：40-60分钟试听课至少包含旧知回收或诊断/陷阱题、模型题、同类验证题、变式或真题风格题、课后练习；90分钟正式课至少包含旧知回收、完整的诊断、例题、指导练习、独立变式、巩固检查和作业题组。若因用户指定资料太少而少于标准，必须在最终说明或逐字稿中说明原因并补充口头微变式或作业。
21. 来源规则：最终产物不需要标注本地PDF、本地页码或普通改编题来源；只有真题、官方考试题、模考题必须核验来源，写清年份、地区、试卷/考试名称、题号或URL。不能把本地题、改编题、资料库题伪称为真题。
22. 最终自检重点是：连续学习档案是否写清承接关系、答案是否已经核对、解法是否跳步、二级结论是否有推导、知识点是否足够支撑老师不卡壳地讲、题量是否不足、逐字稿是否只是提纲。发现问题要先修正再结束。
${formalPdfRules}
23A. ${classroomPdfName} 还必须遵守以下原版学生课堂讲义细则：
   - 使用项目 skill 的 assets/tablet-beamer-template.tex 作为模板；该模板虽然保留历史文件名，但内容是 A4 竖版讲义模板。
   - 页面标题使用正常课堂讲义抬头，例如“[课程主题]课堂讲义”；不要写学生/日期副标题，也不要把“学校试卷风”“A4竖版”“题目与留白”等样式说明写进正式 PDF。
   - PDF 顺序必须是：知识点展示页 -> 题目页/题组页 -> 常用套路模板总结页。
   - 知识点展示页必须像教辅书的“基础知识梳理”完整展开，不是课前导入提纲，也不是只服务后面几道题的局部提示。先把本专题学生上课会听到的基本知识系统写全，再进入题目页；内容详实且不留书写空白。
   - 知识点展示页只写抽象通用内容：定义/对象/符号、成立条件和范围、公式或性质、图像/几何/表格表征、判定方法、常见题型信号、易错边界。不要引用后面题目的题号、具体函数式、具体数字、局部题目条件、完整解题过程、答案或教师话术。
   - 知识点展示页宁可多页也不要薄。每个核心知识对象至少按“是什么、什么时候能用、怎么表示或画图、能推出什么、怎么判定、哪里容易错”展开；一页放不下就继续加知识点页，不能压缩成几条空泛总结。
   - 函数专题要覆盖函数定义、定义域、值域、对应法则、相同函数判定、解析式/图像/表格/文字表示、图像点的含义、单调性、奇偶性或对称性、最值、零点、端点、参数影响等适用内容。二次函数要覆盖一般式/顶点式/交点式、开口方向、对称轴、顶点、判别式、根、与 x 轴交点、单调区间、区间最值和图像示意。最值要明确“区间最值通常来自端点值、内部极值点、不可导点或边界临界点”，并写清极值的必要条件和充分条件。零点要用图像说明与 x 轴交点，并区分穿过、相切、无交点和含参临界状态。
   - PDF 的题目页只放学生需要看到的题目、条件、必要图形、表格、坐标系和干净书写留白；不要放答案、完整过程、提示页、关键步骤 reveal 页或教师来源说明；书写留白不要画横线框框。
   - 智能混排：大题通常一题一页；同类小题可以合并一页，但必须保留足够书写空间。
   - 先检查 OCR Markdown 或源文件提取目录是否已有与该题对应的原始图片。原图清晰且数学关系正确时，必须直接复用或裁切原图，不要自行重画。只有原图缺失、模糊、数学关系错误或用户明确要求时，才用 TikZ、pgfplots、Asymptote 或 LaTeX 表格补画，并在 _work 文件中记录重画原因；不要省略与解题相关的图像。
   - 立体几何图优先使用坐标驱动绘图：若环境有 Asymptote 则优先用 Asymptote；否则用 TikZ 固定斜投影。无论用哪种工具，都必须先定义真实 3D 坐标或明确投影基，再投影到页面，不能凭肉眼摆点。
   - 几何图像质量是硬性要求，不能只画“能看见的大概图”。立体几何图必须满足：主体图宽通常不小于正文宽度的 45%，复杂图不小于 55%；点名不压线、不重叠、不贴边；实线表示可见棱和题目主线，虚线只表示被遮挡棱或辅助线，主线线宽要明显高于辅助线；关键点、动点、中点、垂足、截面或指定平面要用不同线型或浅色填充突出；大面积平面填充必须足够淡，不能遮挡主线、动点和点名；题目需要建系时，优先画“原几何图 + 建系/向量示意图”两个图，而不是把所有辅助线塞进一个图。
   - 立体几何图必须保证平行、垂直、中点、等长、棱柱/棱锥关系与题设一致；禁止随手摆点造成 $D,E,M,N$ 等点的位置关系不准确。若透视会遮挡点名或主线，调整视角、降低面填充、加粗主线或拆图，不能让图形靠猜。
   - 生成 PDF 后必须渲染至少所有含图题页并目视检查：图是否足够大、点名是否清楚、关键线段/平面是否突出、是否有遮挡或比例误导。若检查不通过，必须回到 TeX 重画并重新编译，不要把“很小但能看”的图作为最终产物。
   - 最后的“常用套路模板总结”不能硬总结：只有本节课题型确实有高频可迁移套路时才总结；每条写清适用题型/识别信号、使用条件、操作顺序和容易失效的情况。
24. Markdown 里的数学公式必须规范：
   - 行内公式统一使用美元符号包裹，例如 $\\vec{a}=(2,-1)$、$X\\sim N(\\mu,\\sigma^2)$
   - 独立展示公式统一使用双美元符号块
   - 不要把 LaTeX 公式写成普通括号形式，例如不要写 (\\vec{a}=(2,-1))、(E(X)=n\\cdot\\frac{M}{N})
   - 不要留下未包裹的 LaTeX 片段，例如不要写「求 \\vec{a}\\cdot\\vec{b}」，必须写成「求 $\\vec{a}\\cdot\\vec{b}$」
   - 不要混用 \\(...\\)、\\[...\\] 和普通括号包公式；如果引用资料里有这种写法，写入最终 md 前必须改成美元符号格式
   - 向量命令优先写成带花括号形式，例如 \\vec{a}、\\vec{b}
25. 只负责生成上面列出的本地核心产物；不要在备课生成任务内部调用 lark-cli。任务完成后，宿主服务会用当前机器已登录的 lark-cli user 身份统一完成飞书上传、日程创建和消息通知。

${formatConfirmedAiDraft(student, course, memoryPromptSection)}

OCR 预处理结果（若有）：
${options.ocrContext || "[无。若 PDF 是扫描件，优先运行 PaddleOCR 后读取 OCR Markdown；不要为了识别整份扫描件而逐页调用视觉模型。]"}

同一学生连续学习上下文：
${continuityContext}

本地 RAG 检索计划：
${ragContext}

请完成备课并在最后简短列出生成的文件路径，路径必须位于指定课程目录下。`.trim();

  if (!options.refineInstruction) return basePrompt;

  return `
这是一次基于既有课程目录的补充生成，不是从零重做。

补充要求：
${options.refineInstruction}

处理原则：
1. 先阅读课程目录里已经生成的文件，再补充内容少、缺项、讲解不够细或排版不够好的部分。
2. 尽量在原文件基础上增补和改写，不要无理由删除已有内容。
3. 仍需保持全部核心产物可用：${finalOutputNames}。
4. 如需重新编译 PDF，请确保所有要求的 PDF 均可打开。

${buildExistingWorkContext(store, course)}

${basePrompt}`.trim();
}

export function buildCodexExecArgs(workspace: string, lastMessagePath?: string) {
  const args = ["exec", "--skip-git-repo-check", "-C", workspace, "--sandbox", "danger-full-access"];
  if (lastMessagePath) args.push("--output-last-message", lastMessagePath);
  if (config.codexModel) args.push("--model", config.codexModel);
  if (config.codexReasoningEffort) args.push("-c", `model_reasoning_effort="${config.codexReasoningEffort}"`);
  args.push("-");
  return args;
}

async function prepareCourseOcrContext(
  course: Course,
  append: (chunk: Buffer | string) => void,
  supplementalFiles?: string[]
) {
  const files = supplementalFiles?.length ? supplementalFiles : localFilePathsFromCourse(course);
  if (files.length === 0) return "[无用户本地文件需要 OCR]";
  const ocrRoot = path.join(course.outputDir, "_work", "ocr");
  const results = await preprocessFilesWithOcr(files, ocrRoot, (message) => append(`${message}\n`));
  if (results.length === 0) return "[没有可 OCR 的 PDF/图片文件]";
  return results.map((result) => formatOcrResultForPrompt(result, 14000)).join("\n\n---\n\n");
}

function compactStageText(value: string, maxChars = 8000) {
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[内容过长，已截断 ${text.length - maxChars} 个字符]`;
}

function stageCommonHeader(student: Student, course: Course) {
  const skillDir = packagedSkillDir(course.type);
  const skillMd = path.join(skillDir, "SKILL.md");
  const classroomPdfName = courseClassroomPdfFileName(course, student.name);
  const teachingPdfName = courseTeachingPdfFileName(course, student.name);
  return `
你是备课工作台的分阶段执行 Agent。本阶段必须独立完成指定任务，不能假设上一轮对话存在。

项目内置 skill：
- skill 目录：${toRunnerProjectPath(skillDir)}
- SKILL.md：${toRunnerProjectPath(skillMd)}

固定路径：
- 工作目录：${runnerWorkspace()}
- 课程目录：${toRunnerPath(course.outputDir)}
- _work 目录：${toRunnerPath(path.join(course.outputDir, "_work"))}
- 原版学生课堂 PDF 文件名：${classroomPdfName}
${course.type === "formal" ? `- 教师授课一体版 PDF 文件名：${teachingPdfName}` : ""}

执行边界：
1. 必须先读取项目内置 SKILL.md 及其直接引用的 reference/template 文件中与本阶段相关的内容。
2. 优先读取 PaddleOCR 生成的 combined.md 和 _work 中已整理的题目文件；不要对已 OCR 的 PDF 再运行 pdftotext/pdf-parse，也不要为了识别整份 PDF 逐页调用视觉模型。
3. 不要调用 lark-cli，不要修改 lesson-prep-web 项目文件，不要移动历史备课文件。
4. 本阶段最终回复只列出生成/修改的文件路径和短摘要，不要粘贴大段正文。
5. 如需启动自定义子agent，必须使用上下文隔离的fork并直接传入完成任务所需路径与边界；不得让自定义agent继承完整父线程历史。
`.trim();
}

function buildStageOnePrompt(student: Student, course: Course, continuityContext: string, ragContext: string, ocrContext: string, memoryPromptSection?: string) {
  return `
${stageCommonHeader(student, course)}

阶段 1：资料预处理、题目提取、答案核对、课程骨架。

本阶段只生成中间工作文件，不生成最终产物，不编译 PDF。

必须生成/更新：
- _work/连续学习档案.md
- _work/题目提取.md
- _work/题目索引.md（可与题目提取同内容或更适合索引）
- _work/候选题池.md
- _work/答案核对表.md
- _work/课程骨架.md
- _work/课件生成计划.md
- _work/逐字稿丰富清单.md
- _work/内容丰富清单.md（可与逐字稿丰富清单同内容或补充内容密度检查）

工作要求：
1. 本地 PDF/图片资料优先。若 OCR 已识别，必须读 OCR Markdown；若 OCR 不清楚，只标注“不清楚/需人工确认”，不要用 pdftotext/pdf-parse 替代 PaddleOCR，也不要反复逐页看图。
2. RAG 资料只作为候选题、变式、作业或知识点参考；不能把本地题伪称真题。
3. 每道进入课堂或作业的题必须在 _work/答案核对表.md 里写最终答案、关键条件、关键步骤、易错点、核对结论。
4. 课件生成计划必须分别规划原版学生课堂讲义与教师授课一体版：两者共用同一题序、题号、题面和关联图；学生版规划知识梳理、题面、留白且不放答案；一体版按“一级知识点 -> 二级结论及推导 -> 对应题目与图 -> 逐字话术 -> 完整解答 -> 条件/错误/迁移”规划。不写 TeX。
5. 逐字稿丰富清单只列每页必须覆盖的话术/追问/纠错/板书要求，不写完整逐字稿。
6. 用户明确指定的题量和题型覆盖必须逐项落实到“本课统一题序”及后续两份 PDF。若要求“每个题型一道题”，每个识别出的题型都必须有一道完整题面并进入正式题序；只放在索引、候选池、后续路线、可选拓展或条件作业中均不算完成。课长只能用于建议分课节奏，不能用于删题。
7. 正式课在阶段1同时确定课后作业题序。用户未指定作业数量时固定选4题；题目必须由本节最新内容、OCR/本地资料和课堂核心题型改编或迁移，不得与课堂原题完全相同。把4题完整题面、选题意图、答案、条件与边界核验写入 _work/答案核对表.md，并在 _work/课件生成计划.md 单列“课后作业与答案版”。

用户确认后的 AI 草稿：
${formatConfirmedAiDraft(student, course, memoryPromptSection)}

同一学生连续学习上下文：
${continuityContext}

OCR 预处理结果：
${ocrContext}

本地 RAG 检索计划：
${ragContext}
`.trim();
}

function buildPdfStagePrompt(student: Student, course: Course) {
  const classroomPdfName = courseClassroomPdfFileName(course, student.name);
  const teachingPdfName = courseTeachingPdfFileName(course, student.name);
  return `
${stageCommonHeader(student, course)}

阶段 2：从同一已核对题序生成两份 A4 竖版 PDF。

只允许生成/更新：
- _work/课堂讲义.tex
- _work/课堂讲义.pdf
- ${classroomPdfName}
- _work/课件页码映射.md
- _work/授课一体版.tex
- _work/授课一体版.pdf
- ${teachingPdfName}
- _work/授课一体版页码映射.md
- _work/课后作业.tex
- _work/课后作业.pdf
- ${homeworkPdfFileName}
- _work/课后作业答案.tex
- _work/课后作业答案.pdf
- ${homeworkAnswerPdfFileName}
- 必要的 _work/rendered 或 _work/rendered_final 检查图片

必须读取：
- _work/题目提取.md 或 _work/题目索引.md
- _work/答案核对表.md
- _work/课程骨架.md
- _work/课件生成计划.md
- 项目 skill 的 assets/tablet-beamer-template.tex

要求：
1. 四份 PDF 都是 A4 竖版数学文档，不是 PPT；必须全部产出且用途分离。
2. ${classroomPdfName} 保持原来的学生课堂讲义：系统知识梳理、题面、必要图形/表格/坐标系和干净留白；不要放答案、教师话术、提示揭晓、来源说明或完整过程。
3. ${teachingPdfName} 是教师唯一需要打开的授课文档。按每道题或连续小题组固定编排：一级知识点；二级知识点/二级结论；结论来源、适用条件、逐步推导、每一步理由和失效边界；对应题目与图；老师自然逐字话术；学生可能回答；分层提示；完整不跳步解答；验算/充分性；常见错误与纠正；迁移追问。相关知识必须紧邻对应题目，不能把全部知识放前面、全部答案放最后。
4. 两份 PDF 的“第X题”题号、题序、题面和关联图必须一致。分别写 _work/课件页码映射.md 和 _work/授课一体版页码映射.md。
5. 先检查 OCR Markdown 或源文件提取目录是否已有该题原图；若原图清晰且数学关系正确，必须直接复用或裁切，不能自行重画。只有原图缺失、模糊、关系错误或用户明确要求时才用 TikZ/pgfplots/Asymptote 程序化补画，并在 _work/课件生成计划.md 记录具体原因。
6. 题面、答案和题序以阶段 1 的 _work 文件为准；不要直接解析原 PDF，不要运行 pdftotext/pdf-parse。
7. 分别编译课堂讲义与授课一体版 TeX（通常各两遍），复制到两个指定最终文件名。用 pdfinfo 检查页数、非空和 A4 尺寸；用低分辨率 contact sheet 检查整体排版、图片清晰度和标签重叠，不要逐页放大进入模型上下文。
8. 另按阶段1已核对的作业题序生成 ${homeworkPdfFileName} 与 ${homeworkAnswerPdfFileName}。默认严格4题；学生版不得出现答案或提示，答案版必须完整不跳步。两份作业 PDF 分别由 _work/课后作业.tex 和 _work/课后作业答案.tex 编译，并做 pdfinfo 与 contact sheet 检查。
9. 不要写老师逐字稿.md、知识点详解.md、课后反馈.md；Markdown 分支正在并行执行，两边只通过阶段 1 的统一题序和课件生成计划对齐，不互相等待。
`.trim();
}

function buildKnowledgeStagePrompt(student: Student, course: Course) {
  return `
${stageCommonHeader(student, course)}

阶段 3：生成知识点详解.md。

只允许生成/更新：
- 知识点详解.md

必须读取：
- _work/连续学习档案.md
- _work/题目提取.md 或 _work/题目索引.md
- _work/答案核对表.md
- _work/课程骨架.md
- _work/课件生成计划.md
- _work/课件页码映射.md（如果已经存在，可用于事后校对，不等待）

要求：
1. 这是教师备课详解，不是学生讲义。
2. 必须包含“前后课程衔接”或“首课诊断起点”。
3. 一般结论写清成立条件、符号含义和易错边界。
4. 二级结论必须写来源、推导、每一步为什么成立、什么时候不能用、课堂怎么讲。
5. 解题过程不能跳步，尤其是设参、范围、非零/正负、等号、端点、整数边界和舍根。
6. PDF 分支正在并行生成；不要等待任何 PDF 或页码映射，也不要读取/渲染 PDF。以 _work/课件生成计划.md 的统一题序和题目范围为准。
7. 不要改 PDF，不要写老师逐字稿.md 或课后反馈.md。
`.trim();
}

function buildScriptStagePrompt(student: Student, course: Course) {
  return `
${stageCommonHeader(student, course)}

阶段 4：生成老师逐字稿.md 和课后反馈.md，并做轻量收尾。

必须生成/更新：
- 老师逐字稿.md
- 课后反馈.md

可补充/同步：
- _work/内容丰富清单.md
- _work/逐字稿丰富清单.md

必须读取：
- 知识点详解.md
- _work/连续学习档案.md
- _work/题目提取.md 或 _work/题目索引.md
- _work/答案核对表.md
- _work/课件生成计划.md
- _work/课件页码映射.md（如果已经存在，可用于事后校对，不等待）
- _work/授课一体版页码映射.md（如果已经存在，可用于事后校对，不等待）
- _work/逐字稿丰富清单.md 或 _work/内容丰富清单.md

要求：
1. 老师逐字稿必须按 _work/课件生成计划.md 的统一题序展开。若页码映射已存在可补充引用；若不存在就按“第X题”建立稳定锚点，绝对不要等待 PDF 或页码映射。
2. 逐字稿不是答案合集，必须能让老师照着讲。
3. 课后反馈必须写成可直接发送的完整成稿，只保留以下六个标签块，标签和顺序不得改变：“【学生姓名】：”、“【上课日期】：”、“【授课科目】：”、“【本节课核心内容】”、“【学生课堂掌握情况】”、“【课后作业】：”。日期使用 YYYY-MM-DD；掌握情况写两条编号内容，第一条具体说明本课知识掌握与待巩固点，第二条说明整体课堂状态。未提供更具体作业时写“根据课堂内容上传题目图片。”不得添加标题、示例、额外栏目、填写说明、[课后填写]、[待确认]、“待补充”或空栏目。默认学生课堂参与积极、配合度较好；掌握情况采用稳妥表述并结合实际课题写具体，不要虚构精确正确率、具体错题数或家长反应。
4. Markdown 公式统一使用 $...$ 和 $$...$$，不要使用 \\(...\\) 或 \\[...\\]，不要代码围栏。
5. 最后只检查老师逐字稿.md、知识点详解.md、课后反馈.md 和必要 _work 文件；不要检查、渲染或等待 PDF。
`.trim();
}

function buildPdfImageRefinePrompt(student: Student, course: Course, pages: string, instruction: string) {
  const classroomPdfName = courseClassroomPdfFileName(course, student.name);
  const workDir = path.join(course.outputDir, "_work");
  const texPath = path.join(workDir, "课堂讲义.tex");
  const workPdfPath = path.join(workDir, "课堂讲义.pdf");
  const finalPdfPath = path.join(course.outputDir, classroomPdfName);
  const renderedDir = path.join(workDir, "pdf-image-refine");

  return `
你是备课工作台的“PDF 图形/版面定点修订 Agent”。这是一个独立短任务，不是完整备课，不要读取课程大上下文。

固定路径：
- 工作目录：${runnerWorkspace()}
- 课程目录：${toRunnerPath(course.outputDir)}
- TeX 源文件：${toRunnerPath(texPath)}
- 工作 PDF：${toRunnerPath(workPdfPath)}
- 最终 PDF：${toRunnerPath(finalPdfPath)}
- 临时渲染目录：${toRunnerPath(renderedDir)}

用户指定页码：
${pages}

用户修改要求：
${instruction}

执行边界：
1. 只允许读取/修改 TeX 源文件、工作 PDF、最终 PDF，以及临时渲染目录中的图片。不要读取老师逐字稿、知识点详解、课后反馈、题目提取、答案核对表、RAG、OCR 或历史课程文件。
2. 目标是精确修订用户指定页码上的图形、标签、坐标系、留白、遮挡、比例或局部版面。不要重写整份 PDF，不要重排无关页面，不要改题目顺序。
3. 如果需要看图，只渲染用户指定页码。优先生成低分辨率 contact sheet/缩略图；只有用户指定页码范围内的页面可以单独查看。禁止查看未指定页面，禁止把整份 PDF 逐页带入模型上下文。
4. 可以用 pdfinfo、xelatex、pdftoppm、montage 等本地命令。不要用 pdftotext 解析题目内容，不要调用 OCR，不要调用 lark-cli，不要修改 lesson-prep-web 项目文件。
5. 修改后用 XeLaTeX 编译，确认 PDF 存在、页数合理，并把最新 _work/课堂讲义.pdf 复制到最终 PDF 路径：${toRunnerPath(finalPdfPath)}。
6. 最终回复只列出修改过的文件路径、处理的页码和简短摘要；不要粘贴 TeX 大段正文。

立体几何图专项要求：
1. 必须先在 TeX 中定位目标页对应的 TikZ/Asymptote/绘图宏，理解已有点名、真实 3D 坐标或投影基，再修改。不要凭肉眼直接拖点，不要用随手二维摆点替代空间关系。
2. 如果当前图是 TikZ 斜投影，优先显式定义投影函数，例如把真实点 $(x,y,z)$ 投影为 $(x+a y,\ z+b y)$ 或本文件已有的投影宏。新增点、垂足、中点、截面点必须从真实坐标计算后投影。
3. 保证题设关系不被改坏：平行线仍平行，垂直关系可读，中点/等长/棱柱/棱锥/正方体/长方体关系准确；线面距、点面距、截面、法向量、建系辅助线不能画成暗示错误结论的形状。
4. 点名处理要专业：标签不能压线、压点、互相重叠、贴页面边缘；优先用 anchor、xshift/yshift、pin 或统一 label offset 调整。若两个点名天然太近，先调整视角或拆图，不要把字硬塞进去。
5. 线型层次要清楚：可见棱和题目主线用实线且略粗；隐藏棱只在有助读图时用虚线；辅助线、垂线、投影线、坐标轴、法向量用更轻的线型或浅色；关键线段/平面/截面可淡填充，但填充不能遮住点名和主线。
6. 图形大小和留白要稳定：复杂立体图不要小于正文宽度约 55%；如果一个图里同时有原几何、建系、垂线、截面、法向量导致拥挤，优先拆成“原图 + 建系/向量示意图”或“原图 + 截面/投影图”。
7. 修改指定页时要控制影响范围：尽量新建局部宏或只改该题图环境；如果必须改全局投影宏，要检查同宏影响的其他指定页，且不要波及未指定页。
8. 若用户指出“某几页某些点/线/面有问题”，优先解决这些具体现象；不要借机重画整套 PDF 风格。输出前简述你改了哪些点、线、标签或投影参数。
`.trim();
}

async function runCodexStage(
  job: Job,
  stageName: string,
  prompt: string,
  append: (chunk: Buffer | string) => void,
  extraEnv: Record<string, string>
) {
  const lastMessagePath = path.join(logsDir, `${job.id}.${stageName}.last.md`);
  const args = buildCodexExecArgs(config.workspaceRoot, lastMessagePath);
  append(`\n\n--- CODEX STAGE: ${stageName} ---\n`);
  append(`# ${config.codexCommand} ${args.map(quoteArg).join(" ")}\n\n`);
  append(`${prompt}\n\n--- STAGE OUTPUT ---\n`);
  fs.rmSync(lastMessagePath, { force: true });

  const code = await runCodexProcessWithRetry({
    job,
    label: `stage ${stageName}`,
    command: config.codexCommand,
    args,
    cwd: config.workspaceRoot,
    env: {
      ...process.env,
      ...extraEnv,
      PREP_WORKSPACE: config.workspaceRoot,
      PREP_MATERIAL_ROOT: materialRoot,
      LESSON_PREP_WEB_ROOT: config.projectRoot
    },
    prompt,
    append
  });
  if (code === null || isJobCanceled(job)) return null;
  if (code !== CODEX_TIMEOUT_EXIT_CODE && fs.existsSync(lastMessagePath)) {
    fs.copyFileSync(lastMessagePath, job.lastMessagePath);
  }
  append(`\n--- END STAGE: ${stageName} exit=${code} ---\n`);
  return code;
}

async function runStagedCodexJob(
  store: Store,
  job: Job,
  student: Student,
  course: Course,
  append: (chunk: Buffer | string) => void,
  extraEnv: Record<string, string>
) {
  fs.mkdirSync(path.join(course.outputDir, "_work"), { recursive: true });
  append("# staged lesson prep\n\n");
  append("Staged mode is enabled. Each phase runs in a fresh Codex session to avoid long-context slowdown.\n\n");

  const ocrContext = await prepareCourseOcrContext(course, append);
  const continuityContext = buildStudentContinuityContext(store, student, course);
  const memoryPromptSection = buildMemoryPromptSection(store, student, course);
  const ragContext = await buildRagContext(store, course, false);
  const foundationCode = await runCodexStage(
    job,
    "stage-1-foundation",
    buildStageOnePrompt(student, course, continuityContext, ragContext, ocrContext, memoryPromptSection),
    append,
    extraEnv
  );
  if (foundationCode === null || foundationCode !== 0 || isJobCanceled(job)) return foundationCode;

  append("\n[system] Stage 1 completed. Starting PDF branch and Markdown branch in parallel.\n");

  const pdfBranch = runCodexStage(job, "stage-2-pdf", buildPdfStagePrompt(student, course), append, extraEnv);
  const markdownBranch = (async () => {
    if (isJobCanceled(job)) return null;
    const knowledgeCode = await runCodexStage(job, "stage-3-knowledge", buildKnowledgeStagePrompt(student, course), append, extraEnv);
    if (knowledgeCode === null || knowledgeCode !== 0 || isJobCanceled(job)) return knowledgeCode;
    return runCodexStage(job, "stage-4-script-feedback", buildScriptStagePrompt(student, course), append, extraEnv);
  })();

  const [pdfCode, markdownCode] = await Promise.all([pdfBranch, markdownBranch]);
  if (isJobCanceled(job)) return null;
  if (markdownCode === null || markdownCode !== 0) return markdownCode;
  if (pdfCode === null || pdfCode !== 0) return pdfCode;
  return 0;
}

async function buildLessonFeishuEnv() {
  const parentFolderToken =
    process.env.LESSON_FEISHU_PARENT_FOLDER_TOKEN || process.env.FEISHU_LESSON_PARENT_FOLDER_TOKEN || "LY9efBiWjlEAQWdqPrucuLl4nic";
  return {
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER || "1",
    LARKSUITE_CLI_REMOTE_META: process.env.LARKSUITE_CLI_REMOTE_META || "off",
    LESSON_FEISHU_PARENT_FOLDER_TOKEN: parentFolderToken,
    FEISHU_LESSON_PARENT_FOLDER_TOKEN: parentFolderToken,
    FEISHU_LESSON_CALENDAR_ENABLED: process.env.FEISHU_LESSON_CALENDAR_ENABLED || "true",
    FEISHU_LESSON_CALENDAR_ID: process.env.FEISHU_LESSON_CALENDAR_ID || "",
    FEISHU_LESSON_CALENDAR_ATTENDEE_IDS: process.env.FEISHU_LESSON_CALENDAR_ATTENDEE_IDS || ""
  };
}

function buildJobCommand(course: Course, lastMessagePath: string) {
  // Codex SSH runner
  if (config.codexRunner === "ssh") {
    if (!config.codexSshHost) throw new Error("CODEX_RUNNER=ssh requires CODEX_SSH_HOST.");
    const remoteWorkspace = runnerWorkspace();
    const remoteOutputDir = toRunnerPath(course.outputDir);
    const target = config.codexSshUser ? `${config.codexSshUser}@${config.codexSshHost}` : config.codexSshHost;
    const codexArgs = buildCodexExecArgs(remoteWorkspace);
    const remoteEnv = [
      `PREP_WORKSPACE=${shQuote(remoteWorkspace)}`,
      `PREP_MATERIAL_ROOT=${shQuote(toRunnerPath(materialRoot))}`
    ];
    if (config.codexRemoteProjectRoot) {
      remoteEnv.push(`LESSON_PREP_WEB_ROOT=${shQuote(config.codexRemoteProjectRoot)}`);
    }
    const remoteCommand = [
      "mkdir",
      "-p",
      shQuote(remoteOutputDir),
      "&&",
      ...remoteEnv,
      shQuote(config.codexRemoteCommand),
      ...codexArgs.map(shQuote)
    ].join(" ");
    const args = [];
    if (config.codexSshPort) args.push("-p", String(config.codexSshPort));
    if (config.codexSshKey) args.push("-i", config.codexSshKey);
    args.push(target, remoteCommand);
    return { command: "ssh", args, runner: "ssh" as const };
  }

  // Codex 本地 runner
  return {
    command: config.codexCommand,
    args: buildCodexExecArgs(config.workspaceRoot, lastMessagePath),
    runner: "local" as const
  };
}

export function createCodexJob(store: Store, course: Course, options: CodexJobOptions = {}) {
  const jobId = newId("job");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${jobId}.log`);
  const lastMessagePath = path.join(logsDir, `${jobId}.last.md`);
  const runnerCommand = buildJobCommand(course, lastMessagePath);

  const job: Job = {
    id: jobId,
    courseId: course.id,
    kind: options.kind,
    status: "queued",
    logPath,
    lastMessagePath,
    command: [runnerCommand.command, ...runnerCommand.args.map(quoteArg)].join(" "),
    args: runnerCommand.args,
    runner: runnerCommand.runner,
    refineInstruction: options.refineInstruction,
    supplementalFiles: options.supplementalFiles,
    pdfRefinePages: options.pdfRefinePages,
    createdAt: nowIso()
  };

  store.addJob(job);
  course.jobId = job.id;
  course.status = "queued";
  course.updatedAt = nowIso();
  store.save();
  return job;
}

export function runCodexJob(store: Store, jobId: string) {
  if (hasActiveJob(jobId)) return;
  const job = store.findJob(jobId);
  if (!job) return;
  const course = store.findCourse(job.courseId);
  const student = course ? store.findStudent(course.studentId) : null;
  if (!course || !student) {
    job.status = "failed";
    job.error = "Course or student was not found.";
    job.endedAt = nowIso();
    store.save();
    return;
  }

  fs.mkdirSync(course.outputDir, { recursive: true });
  ensureCoursePdfFileNames(course, student.name);

  job.status = "running";
  job.startedAt = nowIso();
  if (isPdfImageRefineJob(job)) {
    job.artifactBefore = capturePdfArtifactSnapshot(course, student.name);
  }
  course.status = "running";
  course.updatedAt = nowIso();
  store.save();

  const append = (chunk: Buffer | string) => {
    fs.appendFileSync(job.logPath, chunk.toString(), "utf8");
  };

  const failBeforeSpawn = (error: Error) => {
    const currentJob = store.findJob(jobId) || job;
    const currentCourse = store.findCourse(currentJob.courseId) || course;
    currentJob.status = "failed";
    currentJob.error = error.message;
    currentJob.endedAt = nowIso();
    currentCourse.status = "failed";
    currentCourse.updatedAt = nowIso();
    activeJobs.delete(jobId);
    store.save();
    append(`\n[spawn error] ${error.message}\n`);
    emitJobFinished(store, currentCourse, currentJob);
  };

  const finishWithExitCode = (code: number | null) => {
    activeJobs.delete(jobId);
    const currentJob = store.findJob(jobId) || job;
    const currentCourse = store.findCourse(currentJob.courseId) || course;
    const currentStudent = store.findStudent(currentCourse.studentId) || student;
    if (currentJob.status === "canceled") {
      store.save();
      return;
    }
    const recovery = recoverCourseOutputDir(currentCourse, currentJob);
    if (recovery.changed) {
      append(`\n[system] ${recovery.reason}\n`);
    }
    ensureCoursePdfFileNames(currentCourse, currentStudent.name);
    const files = listCourseFiles(currentCourse.outputDir);
    currentJob.exitCode = code;
    currentJob.endedAt = nowIso();
    if (isPdfImageRefineJob(currentJob)) {
      const artifactErrors = code === 0 ? validatePdfImageRefineArtifacts(currentJob, currentCourse, currentStudent.name) : [];
      if (code === 0 && artifactErrors.length === 0) {
        currentJob.status = "completed";
        currentCourse.status = "completed";
      } else {
        currentJob.status = "failed";
        currentCourse.status = "failed";
        currentJob.error = code === 0 ? `PDF 修订任务未产出有效新 PDF：${artifactErrors.join("；")}` : codexExitError(code);
        append(`\n[artifact validation failed] ${currentJob.error}\n`);
      }
      currentCourse.updatedAt = nowIso();
      store.save();
      emitJobFinished(store, currentCourse, currentJob);
      return;
    }
    currentJob.quality = assessCourseQuality(currentCourse, currentStudent.name);
    const qualityFailed = currentJob.quality.status === "fail";
    const shouldAutoRefine = code === 0 && files.length > 0 && qualityFailed && !currentJob.refineInstruction;
    if (shouldAutoRefine) {
      currentJob.status = "failed";
      currentJob.error = "生成质量检查未通过，系统已自动发起补救生成。";
      currentCourse.updatedAt = nowIso();
      store.save();
      const refineJob = createCodexJob(store, currentCourse, {
        refineInstruction: buildAutoQualityRefineInstruction(currentCourse, currentJob, currentStudent)
      });
      runCodexJob(store, refineJob.id);
      return;
    }
    if (code === 0 && files.length > 0 && !qualityFailed) {
      currentJob.status = "completed";
      currentCourse.status = "completed";
      if (currentCourse.postClassSummary?.status !== "confirmed") {
        currentCourse.postClassSummary = buildPostClassSummaryDraft(currentCourse);
      }
    } else {
      currentJob.status = "failed";
      currentCourse.status = "failed";
      currentJob.error =
        code === 0 && qualityFailed
          ? "生成质量检查未通过，请查看缺失文件或异常项。"
          : code === 0
          ? "Codex exited successfully, but no previewable course files were found."
          : codexExitError(code);
    }
    currentCourse.updatedAt = nowIso();
    store.save();
    emitJobFinished(store, currentCourse, currentJob);
  };

  void (async () => {
    let lessonFeishuEnv: Record<string, string> = {};
    try {
      lessonFeishuEnv = await buildLessonFeishuEnv();
    } catch (error) {
      append(
        `\n[feishu env warning] failed to prepare lark-cli sync env: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }

    const shouldUseStaged =
      config.codexStagedLessonPrep &&
      job.runner === "local" &&
      !isPdfImageRefineJob(job) &&
      !job.refineInstruction &&
      !course.codexPromptOverride;

    if (shouldUseStaged) {
      fs.writeFileSync(job.logPath, `# staged ${job.command}\n\n`, "utf8");
      const code = await runStagedCodexJob(store, job, student, course, append, lessonFeishuEnv);
      if (code === null) {
        store.save();
        return;
      }
      finishWithExitCode(code);
      return;
    }

    const shouldPrepareOcr = !isPdfImageRefineJob(job) && (!job.refineInstruction || Boolean(job.supplementalFiles?.length));
    const ocrContext = shouldPrepareOcr
      ? await prepareCourseOcrContext(course, append, job.supplementalFiles)
      : undefined;
    const prompt = isPdfImageRefineJob(job)
      ? buildPdfImageRefinePrompt(student, course, job.pdfRefinePages || "[未指定]", job.refineInstruction || "")
      : course.codexPromptOverride && !job.refineInstruction
      ? course.codexPromptOverride
      : await buildCodexPrompt(store, student, course, {
          refineInstruction: job.refineInstruction,
          ocrContext
        });
    fs.appendFileSync(job.logPath, `\n# ${job.command}\n\n${prompt}\n\n--- CODEx OUTPUT ---\n`, "utf8");

    const command = job.runner === "ssh" ? "ssh" : config.codexCommand;
    const code = await runCodexProcessWithRetry({
      job,
      label: "Codex job",
      command,
      args: job.args || [],
      cwd: config.workspaceRoot,
      env: {
        ...process.env,
        ...lessonFeishuEnv,
        PREP_WORKSPACE: config.workspaceRoot,
        PREP_MATERIAL_ROOT: materialRoot,
        LESSON_PREP_WEB_ROOT: config.projectRoot
      },
      prompt,
      append
    });
    if (code === null) {
      store.save();
      return;
    }
    finishWithExitCode(code);
  })().catch(failBeforeSpawn);
}

export function cancelCodexJob(store: Store, jobId: string) {
  const job = store.findJob(jobId);
  if (!job) return { ok: false, status: 404, error: "Job not found." };
  const course = store.findCourse(job.courseId);
  if (job.status !== "queued" && job.status !== "running") {
    return { ok: false, status: 409, error: "该任务当前不能取消。" };
  }

  job.status = "canceled";
  job.error = "用户取消生成。";
  job.endedAt = nowIso();
  if (course) {
    course.status = "canceled";
    course.updatedAt = nowIso();
  }

  const children = activeJobs.get(jobId);
  if (children && children.size > 0) {
    fs.appendFileSync(job.logPath, "\n[system] 用户取消生成。\n", "utf8");
    for (const child of children) {
      terminateCodexChild(child);
    }
  }

  activeJobs.delete(jobId);
  store.save();
  return { ok: true, job, course };
}

export function continueCodexJob(store: Store, jobId: string) {
  const failedJob = store.findJob(jobId);
  if (!failedJob) return { ok: false, status: 404, error: "Job not found." };
  const course = store.findCourse(failedJob.courseId);
  if (!course) return { ok: false, status: 404, error: "Course not found." };
  const runningJob = course.jobId ? store.findJob(course.jobId) : null;
  if (runningJob?.status === "running" || runningJob?.status === "queued") {
    return { ok: false, status: 409, error: "This course already has a running job." };
  }
  if (failedJob.status === "running" || failedJob.status === "queued") {
    return { ok: false, status: 409, error: "该任务还在运行，不能继续。" };
  }

  const student = store.findStudent(course.studentId);
  if (student && hasSuccessfulStagedCompletion(failedJob)) {
    const recovery = recoverCourseOutputDir(course, failedJob);
    ensureCoursePdfFileNames(course, student.name);
    const files = fs.existsSync(course.outputDir) ? listCourseFiles(course.outputDir) : [];
    const quality = assessCourseQuality(course, student.name);
    if (files.length > 0 && quality.status !== "fail") {
      failedJob.status = "completed";
      failedJob.exitCode = 0;
      failedJob.endedAt = inferredJobEndTime(failedJob);
      failedJob.quality = quality;
      delete failedJob.error;
      course.jobId = failedJob.id;
      course.status = "completed";
      course.updatedAt = failedJob.endedAt;
      if (course.postClassSummary?.status !== "confirmed") {
        course.postClassSummary = buildPostClassSummaryDraft(course);
      }
      fs.appendFileSync(
        failedJob.logPath,
        `\n[recovery] 已检测到全部生成阶段成功，直接用现有产物完成任务。${recovery.reason ? ` ${recovery.reason}` : ""}\n`,
        "utf8"
      );
      store.save();
      emitJobFinished(store, course, failedJob);
      return { ok: true, job: failedJob, course, recovered: true };
    }
  }

  const job = createCodexJob(store, course, {
    refineInstruction: buildContinueInstruction(store, course, failedJob, student)
  });
  return { ok: true, job, course, recovered: false };
}

const stagedCompletionMarkers = [
  "--- END STAGE: stage-1-foundation exit=0 ---",
  "--- END STAGE: stage-2-pdf exit=0 ---",
  "--- END STAGE: stage-3-knowledge exit=0 ---",
  "--- END STAGE: stage-4-script-feedback exit=0 ---"
];

function hasSuccessfulStagedCompletion(job: Job) {
  if (!fs.existsSync(job.logPath)) return false;
  const log = fs.readFileSync(job.logPath, "utf8");
  if (!log.startsWith("# staged ")) return false;
  return stagedCompletionMarkers.every((marker) => log.includes(marker));
}

function inferredJobEndTime(job: Job) {
  const mtimes = [job.logPath, job.lastMessagePath]
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.statSync(filePath).mtimeMs);
  return mtimes.length > 0 ? new Date(Math.max(...mtimes)).toISOString() : nowIso();
}

export function recoverInterruptedJobs(store: Store) {
  for (const job of store.data.jobs) {
    if (job.status === "running" || job.status === "queued") {
      const course = store.findCourse(job.courseId);
      const student = course ? store.findStudent(course.studentId) : undefined;
      if (course && student && hasSuccessfulStagedCompletion(job)) {
        const recovery = recoverCourseOutputDir(course, job);
        ensureCoursePdfFileNames(course, student.name);
        const files = fs.existsSync(course.outputDir) ? listCourseFiles(course.outputDir) : [];
        const quality = assessCourseQuality(course, student.name);
        if (files.length > 0 && quality.status !== "fail") {
          job.status = "completed";
          job.exitCode = 0;
          job.endedAt = inferredJobEndTime(job);
          job.quality = quality;
          delete job.error;
          if (course.jobId === job.id) {
            course.status = "completed";
            course.updatedAt = job.endedAt;
            if (course.postClassSummary?.status !== "confirmed") {
              course.postClassSummary = buildPostClassSummaryDraft(course);
            }
          }
          if (recovery.changed) {
            fs.appendFileSync(job.logPath, `\n[recovery] ${recovery.reason}\n`, "utf8");
          }
          continue;
        }
      }

      job.status = "failed";
      job.error = "Server restarted before this job finished.";
      job.endedAt = nowIso();
      if (course?.jobId === job.id && (course.status === "running" || course.status === "queued")) {
        course.status = "failed";
        course.updatedAt = nowIso();
      }
    }
  }
  store.save();
}
