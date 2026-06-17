import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config, logsDir, materialRoot } from "./config.js";
import { listCourseFiles } from "./files.js";
import { assessCourseQuality } from "./quality.js";
import { searchRag } from "./rag.js";
import type { Course, Job, Student } from "./types.js";
import type { Store } from "./store.js";
import { newId, nowIso } from "./store.js";

const activeJobs = new Map<string, ChildProcess>();

interface CodexJobOptions {
  refineInstruction?: string;
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

function buildRagContext(store: Store, course: Course) {
  const query = [
    course.stage,
    course.grade,
    course.province,
    course.textbook,
    course.lessonKind,
    course.desiredContent,
    course.notes
  ]
    .filter(Boolean)
    .join(" ");

  return searchRag(store, query, 8);
}

function readSmallFile(filePath: string, maxChars = 8000) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  return content.slice(-maxChars);
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

export function buildCodexPrompt(store: Store, student: Student, course: Course, options: CodexJobOptions = {}) {
  const skillDir = packagedSkillDir(course.type);
  const skillMd = path.join(skillDir, "SKILL.md");
  const ragResults = buildRagContext(store, course);
  const ragContext =
    ragResults.length === 0
      ? "本地 RAG 暂无命中资料。仍需按 skill 要求搜索本地资料库和可靠网页来源。"
      : ragResults
          .map((result, index) => {
            return [
              `【RAG ${index + 1}】${result.chunk.title}`,
              `路径：${toRunnerPath(result.chunk.path)}`,
              `相关度：${result.score}`,
              `摘录：${result.excerpt}`
            ].join("\n");
          })
          .join("\n\n");

  const basePrompt = `
请使用项目内置 Codex skill：${skillName(course.type)}，为下面学生准备一节${courseTypeLabel(course.type)}。

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
3. 必须生成 skill 要求的四个用户可用产物：老师逐字稿.md、知识点详解.md、课堂课件.pdf、课后反馈.md
4. 不要修改 lesson-prep-web 项目文件，不要移动无关历史备课文件
5. 如果信息不足，请按 skill 规则使用 [待确认]，但仍生成可上课的初稿
6. 资料库根目录是 ${toRunnerPath(materialRoot)}
7. 优先参考下面的 RAG 命中资料；仍需按 skill 要求做本地资料库检索和可靠网页真题检索
8. Markdown 里的数学公式必须规范：
   - 行内公式统一使用美元符号包裹，例如 $\\vec{a}=(2,-1)$、$X\\sim N(\\mu,\\sigma^2)$
   - 独立展示公式统一使用双美元符号块
   - 不要把 LaTeX 公式写成普通括号形式，例如不要写 (\\vec{a}=(2,-1))、(E(X)=n\\cdot\\frac{M}{N})
   - 不要留下未包裹的 LaTeX 片段，例如不要写「求 \\vec{a}\\cdot\\vec{b}」，必须写成「求 $\\vec{a}\\cdot\\vec{b}$」
   - 不要混用 \\(...\\)、\\[...\\] 和普通括号包公式；如果引用资料里有这种写法，写入最终 md 前必须改成美元符号格式
   - 向量命令优先写成带花括号形式，例如 \\vec{a}、\\vec{b}

学生信息：
- 学生姓名：${student.name}
- 学生长期备注：${student.notes || "[无]"}
- 历史薄弱点：${student.weakPoints || "[无]"}
- 常错题型：${student.commonMistakes || "[无]"}
- 家长沟通记录：${student.parentNotes || "[无]"}
- 下次课建议：${student.nextLessonSuggestion || "[无]"}
- 学段：${course.stage || "[待确认]"}
- 年级：${course.grade || "[待确认]"}
- 当前分数/水平：${course.score || "[待确认]"}
- 省市/试卷地区：${course.province || "[待确认]"}
- 教材版本：${course.textbook || "[待确认]"}
- 课程类型：${courseTypeLabel(course.type)}
- 课程性质：${course.lessonKind || "[待确认]"}
- 想听/需要准备的内容：${course.desiredContent || "[待确认]"}
- 上课时间：${course.lessonTime || "[待确认]"}
- 课长：${course.durationMinutes || "[待确认]"} 分钟
- 用户提供的本地题目/资料路径：${course.localFiles ? mapRunnerPaths(course.localFiles) : "[无]"}
- 其他备注：${course.notes || "[无]"}

本地 RAG 命中资料：
${ragContext}

请完成备课并在最后简短列出生成的文件路径。`.trim();

  if (!options.refineInstruction) return basePrompt;

  return `
这是一次基于既有课程目录的补充生成，不是从零重做。

补充要求：
${options.refineInstruction}

处理原则：
1. 先阅读课程目录里已经生成的文件，再补充内容少、缺项、讲解不够细或排版不够好的部分。
2. 尽量在原文件基础上增补和改写，不要无理由删除已有内容。
3. 仍需保持四个核心产物可用：老师逐字稿.md、知识点详解.md、课堂课件.pdf、课后反馈.md。
4. 如需重新编译 PDF，请确保课堂课件.pdf 可打开。

${buildExistingWorkContext(store, course)}

${basePrompt}`.trim();
}

function buildCodexExecArgs(workspace: string, lastMessagePath?: string) {
  const args = ["exec", "-C", workspace, "--sandbox", "danger-full-access"];
  if (lastMessagePath) args.push("--output-last-message", lastMessagePath);
  if (config.codexModel) args.push("--model", config.codexModel);
  args.push("-");
  return args;
}

function buildJobCommand(course: Course, lastMessagePath: string) {
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
    status: "queued",
    logPath,
    lastMessagePath,
    command: [runnerCommand.command, ...runnerCommand.args.map(quoteArg)].join(" "),
    args: runnerCommand.args,
    runner: runnerCommand.runner,
    refineInstruction: options.refineInstruction,
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
  if (activeJobs.has(jobId)) return;
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

  const prompt = buildCodexPrompt(store, student, course, {
    refineInstruction: job.refineInstruction
  });
  fs.writeFileSync(job.logPath, `# ${job.command}\n\n${prompt}\n\n--- CODEx OUTPUT ---\n`, "utf8");

  job.status = "running";
  job.startedAt = nowIso();
  course.status = "running";
  course.updatedAt = nowIso();
  store.save();

  const command = job.runner === "ssh" ? "ssh" : config.codexCommand;
  const child = spawn(command, job.args || [], {
    cwd: config.workspaceRoot,
    env: {
      ...process.env,
      PREP_WORKSPACE: config.workspaceRoot,
      PREP_MATERIAL_ROOT: materialRoot,
      LESSON_PREP_WEB_ROOT: config.projectRoot
    },
    shell: process.platform === "win32",
    windowsHide: true
  });
  activeJobs.set(jobId, child);

  child.stdin.write(prompt);
  child.stdin.end();

  const append = (chunk: Buffer | string) => {
    fs.appendFileSync(job.logPath, chunk.toString(), "utf8");
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.endedAt = nowIso();
    course.status = "failed";
    course.updatedAt = nowIso();
    activeJobs.delete(jobId);
    store.save();
    append(`\n[spawn error] ${error.message}\n`);
  });

  child.on("close", (code) => {
    activeJobs.delete(jobId);
    if (job.status === "canceled") {
      store.save();
      return;
    }
    const files = listCourseFiles(course.outputDir);
    job.exitCode = code;
    job.endedAt = nowIso();
    job.quality = assessCourseQuality(course);
    const qualityFailed = job.quality.status === "fail";
    if (code === 0 && files.length > 0 && !qualityFailed) {
      job.status = "completed";
      course.status = "completed";
    } else {
      job.status = "failed";
      course.status = "failed";
      job.error =
        code === 0 && qualityFailed
          ? "生成质量检查未通过，请查看缺失文件或异常项。"
          : code === 0
          ? "Codex exited successfully, but no previewable course files were found."
          : `Codex exited with code ${code}.`;
    }
    course.updatedAt = nowIso();
    store.save();
  });
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

  const child = activeJobs.get(jobId);
  if (child) {
    fs.appendFileSync(job.logPath, "\n[system] 用户取消生成。\n", "utf8");
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  }

  activeJobs.delete(jobId);
  store.save();
  return { ok: true, job, course };
}

export function recoverInterruptedJobs(store: Store) {
  for (const job of store.data.jobs) {
    if (job.status === "running" || job.status === "queued") {
      job.status = "failed";
      job.error = "Server restarted before this job finished.";
      job.endedAt = nowIso();
      const course = store.findCourse(job.courseId);
      if (course && (course.status === "running" || course.status === "queued")) {
        course.status = "failed";
        course.updatedAt = nowIso();
      }
    }
  }
  store.save();
}
