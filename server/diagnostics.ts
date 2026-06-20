import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, materialRoot, uploadRoot } from "./config.js";
import { getRagStats } from "./rag.js";
import { nowIso } from "./store.js";
import type { Store } from "./store.js";

export type DiagnosticStatus = "ok" | "warn" | "fail";

export interface DiagnosticItem {
  key: string;
  label: string;
  status: DiagnosticStatus;
  message: string;
  detail?: string;
}

function item(
  key: string,
  label: string,
  status: DiagnosticStatus,
  message: string,
  detail?: string
): DiagnosticItem {
  return { key, label, status, message, detail };
}

function existsDir(target: string) {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

function existsFile(target: string) {
  return fs.existsSync(target) && fs.statSync(target).isFile();
}

function checkCommand(command: string) {
  const result = spawnSync(command, ["--version"], {
    cwd: config.workspaceRoot,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  };
}

function checkPackagedSkills() {
  const checks: DiagnosticItem[] = [];
  for (const skillName of ["trial-lesson-prep", "formal-lesson-prep"]) {
    const skillDir = path.join(config.projectRoot, "skills", skillName);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!existsFile(skillMd)) {
      checks.push(item(`skill-${skillName}`, skillName, "fail", "项目内置 skill 缺失。", skillMd));
      continue;
    }
    checks.push(item(`skill-${skillName}`, skillName, "ok", "项目内置 skill 已打包。", skillDir));
  }
  return checks;
}

function checkCodex() {
  if (config.codexRunner === "ssh") {
    if (!config.codexSshHost || !config.codexRemoteWorkspace) {
      return item("codex-runner", "Codex Runner", "fail", "SSH 模式缺少远程主机或远程工作区配置。");
    }
    return item(
      "codex-runner",
      "Codex Runner",
      "ok",
      `SSH 模式：${config.codexSshUser ? `${config.codexSshUser}@` : ""}${config.codexSshHost}`,
      config.codexRemoteWorkspace
    );
  }

  const result = checkCommand(config.codexCommand);
  if (!result.ok) {
    return item("codex-command", "Codex CLI", "fail", `命令不可用：${config.codexCommand}`, result.output || "请在服务器安装并登录 Codex CLI。");
  }
  return item("codex-command", "Codex CLI", "ok", `命令可用：${config.codexCommand}`, result.output.split(/\r?\n/)[0]);
}

function recentFailedJob(store: Store) {
  return store.data.jobs
    .filter((job) => job.status === "failed")
    .sort((a, b) => (b.endedAt || b.createdAt).localeCompare(a.endedAt || a.createdAt))[0];
}

export function createDiagnostics(store: Store) {
  const ragStats = getRagStats(store);
  const checks: DiagnosticItem[] = [
    existsDir(config.workspaceRoot)
      ? item("workspace", "备课工作区", "ok", "工作区可访问。", config.workspaceRoot)
      : item("workspace", "备课工作区", "fail", "工作区不可访问。", config.workspaceRoot),
    existsDir(materialRoot)
      ? item("materials", "资料库", "ok", "资料库目录可访问。", materialRoot)
      : item("materials", "资料库", "warn", "资料库目录暂不存在，上传或重建索引时会创建。", materialRoot),
    existsDir(uploadRoot)
      ? item("uploads", "网页上传目录", "ok", "网页上传目录可访问。", uploadRoot)
      : item("uploads", "网页上传目录", "warn", "网页上传目录暂不存在。", uploadRoot),
    existsDir(config.dataDir)
      ? item("data", "应用数据目录", "ok", "应用数据目录可访问。", config.dataDir)
      : item("data", "应用数据目录", "fail", "应用数据目录不可访问。", config.dataDir),
    checkCodex(),
    ...checkPackagedSkills()
  ];

  const failedJob = recentFailedJob(store);
  if (failedJob) {
    checks.push(
      item(
        "recent-failed-job",
        "最近失败任务",
        "warn",
        failedJob.error || "存在失败的 Codex 任务。",
        `${failedJob.id} · ${failedJob.endedAt || failedJob.createdAt}`
      )
    );
  }

  const status: DiagnosticStatus = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
    ? "warn"
    : "ok";

  return {
    status,
    checkedAt: nowIso(),
    config: {
      projectRoot: config.projectRoot,
      workspaceRoot: config.workspaceRoot,
      materialRoot,
      dataDir: config.dataDir,
      codexRunner: config.codexRunner,
      codexAutoRun: config.codexAutoRun,
      maxUploadFiles: config.maxUploadFiles,
      ragMaxReindexFiles: config.ragMaxReindexFiles,
      trustProxy: config.trustProxy,
      secureCookies: config.secureCookies,
      enableHsts: config.enableHsts,
      authRateLimitMax: config.authRateLimitMax,
      authRateLimitWindowMs: config.authRateLimitWindowMs
    },
    counts: {
      users: store.data.users.length,
      students: store.data.students.length,
      courses: store.data.courses.length,
      jobs: store.data.jobs.length,
      runningJobs: store.data.jobs.filter((job) => job.status === "running" || job.status === "queued").length,
      materials: ragStats.materials,
      indexedMaterials: ragStats.indexedMaterials,
      ragChunks: ragStats.chunks
    },
    checks
  };
}
