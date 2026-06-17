import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CODEX_SMOKE_PORT || 4288);
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-prep-codex-smoke-"));
const workspaceRoot = path.join(tempRoot, "workspace");
const dataDir = path.join(tempRoot, "data");
const codexCommand = process.env.CODEX_COMMAND || "codex";
const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS || 10 * 60 * 1000);

let cookieJar = "";
let serverOutput = "";
let child;

function log(message) {
  console.log(`[codex-smoke] ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function checkCodexCommand() {
  const result = spawnSync(codexCommand, ["--version"], {
    cwd: projectRoot,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Codex command failed: ${codexCommand}\n${output || "Install and login Codex CLI first."}`);
  }
  log([result.stdout, result.stderr].filter(Boolean).join("\n").trim().split(/\r?\n/)[0]);
}

async function request(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.json);
  }
  if (cookieJar) headers.set("Cookie", cookieJar);

  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookieJar = setCookie.split(";")[0];

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${safeJsonText(data)}`);
  }
  return { response, data };
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`server did not become healthy: ${lastError}`);
}

async function waitForJob(jobId) {
  const deadline = Date.now() + timeoutMs;
  let lastJob = null;
  let lastLogTail = "";
  while (Date.now() < deadline) {
    const result = await request(`/api/jobs/${jobId}`);
    lastJob = result.data.job;
    lastLogTail = result.data.logTail || "";
    log(`job ${jobId}: ${lastJob.status}`);
    if (["completed", "failed", "canceled"].includes(lastJob.status)) {
      return { job: lastJob, logTail: lastLogTail };
    }
    await sleep(5000);
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms; last status: ${lastJob?.status || "unknown"}\n${lastLogTail}`);
}

async function main() {
  assert(fs.existsSync(path.join(projectRoot, "dist", "server", "index.js")), "missing dist/server/index.js; run npm run build first");
  assert(fs.existsSync(path.join(projectRoot, "dist", "client", "index.html")), "missing dist/client/index.html; run npm run build first");
  checkCodexCommand();

  fs.mkdirSync(path.join(workspaceRoot, "资料库"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "资料库", "codex-smoke-material.md"),
    "# Codex Smoke Material\n\n请生成一个极小但完整的试听课测试产物，数学公式必须使用 `$...$`。\n",
    "utf8"
  );

  child = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PREP_WORKSPACE: workspaceRoot,
      APP_DATA_DIR: dataDir,
      CODEX_AUTO_RUN: "true",
      CODEX_COMMAND: codexCommand,
      SECURE_COOKIES: "false",
      ENABLE_HSTS: "false",
      TRUST_PROXY: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  await waitForServer();
  log("server healthy");

  await request("/api/setup", {
    method: "POST",
    json: { username: "teacher", password: "teacher12345" }
  });

  const studentResult = await request("/api/students", {
    method: "POST",
    json: {
      name: "Codex真机烟测学生",
      stage: "高中数学",
      notes: "只用于服务器 Codex 调用测试",
      weakPoints: "向量数量积",
      commonMistakes: "公式格式不规范",
      parentNotes: "无",
      nextLessonSuggestion: "无"
    }
  });
  const student = studentResult.data.student;
  assert(student?.id, "student creation failed");

  await request("/api/materials/reindex", { method: "POST" });

  const courseResult = await request(`/api/students/${student.id}/courses`, {
    method: "POST",
    json: {
      type: "trial",
      stage: "高中数学",
      grade: "高二",
      score: "80",
      province: "海南",
      textbook: "人教A版",
      lessonKind: "试听诊断",
      desiredContent: "Codex 服务器烟测：只生成最小完整产物",
      lessonTime: "2026-06-12T20:00",
      durationMinutes: 20,
      localFiles: "",
      notes: "这是服务器真实 Codex 调用烟测。请生成最小完整版本，四个核心文件都要有。",
      autoRun: true
    }
  });
  const course = courseResult.data.course;
  const job = courseResult.data.job;
  assert(job?.id, "course creation did not create a Codex job");

  const completed = await waitForJob(job.id);
  if (completed.job.status !== "completed") {
    throw new Error(`Codex job did not complete: ${completed.job.status}\n${completed.job.error || ""}\n${completed.logTail}`);
  }

  const filesResult = await request(`/api/courses/${course.id}/files`);
  const names = filesResult.data.files.map((file) => file.name);
  for (const required of ["老师逐字稿.md", "知识点详解.md", "课堂课件.pdf", "课后反馈.md"]) {
    assert(names.includes(required), `missing generated file: ${required}`);
  }

  const qualityResult = await request(`/api/courses/${course.id}/quality`, { method: "POST" });
  assert(qualityResult.data.quality?.status !== "fail", `quality failed: ${JSON.stringify(qualityResult.data.quality)}`);

  log(`completed: ${course.outputDir}`);
  log(`temp root: ${tempRoot}`);
}

try {
  await main();
} catch (error) {
  console.error(serverOutput.trim());
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await sleep(500);
  }
  if (process.env.CODEX_SMOKE_KEEP_TEMP !== "1") {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
