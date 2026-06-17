import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SMOKE_PORT || 4278);
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-prep-smoke-"));
const workspaceRoot = path.join(tempRoot, "workspace");
const dataDir = path.join(tempRoot, "data");
const fakeCodexPath = path.join(tempRoot, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");

function log(message) {
  console.log(`[smoke] ${message}`);
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

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
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

function writePdf(filePath) {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 74 >>
stream
BT /F1 16 Tf 40 100 Td (Lesson Prep Smoke PDF) Tj 0 -28 Td (formula ok) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000245 00000 n 
0000000369 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
439
%%EOF
`;
  fs.writeFileSync(filePath, pdf, "latin1");
}

function writeFakeCodexCommand() {
  const fakeCodexJs = path.join(tempRoot, "fake-codex.mjs");
  const script = String.raw`
import fs from "node:fs";
import path from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const outputMatch = prompt.match(/所有最终产物必须保存到这个课程目录：(.+)/);
if (!outputMatch) {
  console.error("missing output directory in prompt");
  process.exit(2);
}
const outputDir = outputMatch[1].trim();
fs.mkdirSync(outputDir, { recursive: true });
const repeated = "这一段由 fake Codex 生成，用于验证自动任务链路、课堂提问、学生回答、追问、板书和讲解节奏。";
fs.writeFileSync(
  path.join(outputDir, "老师逐字稿.md"),
  "# 老师逐字稿\n\n题目：已知 $\\vec{a}=(2,-1)$，$\\vec{b}=(3,4)$，求 $\\vec{a}\\cdot\\vec{b}$。\n\n" + repeated.repeat(8) + "\n",
  "utf8"
);
fs.writeFileSync(
  path.join(outputDir, "知识点详解.md"),
  "# 知识点详解\n\n本文件用于说明本节课的核心概念、常见误区和课堂推进顺序。\n\n## 数量积\n\n$\\vec{a}\\cdot\\vec{b}=x_1x_2+y_1y_2$。\n\n" + repeated.repeat(8) + "\n",
  "utf8"
);
fs.writeFileSync(
  path.join(outputDir, "课后反馈.md"),
  "# 课后反馈\n\n本节课重点是向量数量积，课后继续练习坐标运算。\n\n" + repeated.repeat(3) + "\n",
  "utf8"
);
const pdf = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n181\n%%EOF\n";
fs.writeFileSync(path.join(outputDir, "课堂课件.pdf"), pdf, "latin1");

const lastMessageIndex = process.argv.indexOf("--output-last-message");
if (lastMessageIndex >= 0 && process.argv[lastMessageIndex + 1]) {
  fs.writeFileSync(process.argv[lastMessageIndex + 1], "fake Codex completed\n" + outputDir + "\n", "utf8");
}
console.log("fake Codex completed");
`;
  fs.writeFileSync(fakeCodexJs, script, "utf8");

  if (process.platform === "win32") {
    fs.writeFileSync(fakeCodexPath, `@echo off\r\n"${process.execPath}" "${fakeCodexJs}" %*\r\n`, "utf8");
  } else {
    fs.writeFileSync(fakeCodexPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexJs}" "$@"\n`, "utf8");
    fs.chmodSync(fakeCodexPath, 0o755);
  }
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 20000;
  let lastJob = null;
  let lastLogTail = "";
  while (Date.now() < deadline) {
    const result = await request(`/api/jobs/${jobId}`);
    lastJob = result.data.job;
    lastLogTail = result.data.logTail || "";
    if (["completed", "failed", "canceled"].includes(lastJob.status)) {
      return { job: lastJob, logTail: lastLogTail };
    }
    await sleep(300);
  }
  throw new Error(`job ${jobId} did not finish; last status: ${lastJob?.status || "unknown"}\n${lastLogTail}`);
}

let cookieJar = "";
let serverOutput = "";
let child;

async function main() {
  assert(fs.existsSync(path.join(projectRoot, "dist", "server", "index.js")), "missing dist/server/index.js; run npm run build first");
  assert(fs.existsSync(path.join(projectRoot, "dist", "client", "index.html")), "missing dist/client/index.html; run npm run build first");

  fs.mkdirSync(path.join(workspaceRoot, "资料库"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  writeFakeCodexCommand();

  child = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PREP_WORKSPACE: workspaceRoot,
      APP_DATA_DIR: dataDir,
      CODEX_AUTO_RUN: "true",
      CODEX_COMMAND: fakeCodexPath,
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

  await waitForServer(child);
  log("server healthy");

  const systemBefore = await request("/api/system");
  assert(systemBefore.data.setupRequired === true, "fresh smoke server should require setup");

  const setup = await request("/api/setup", {
    method: "POST",
    json: { username: "teacher", password: "teacher12345" }
  });
  assert(setup.data.user?.username === "teacher", "setup did not create teacher user");

  const me = await request("/api/me");
  assert(me.data.user?.username === "teacher", "session cookie did not authenticate /api/me");

  const studentResult = await request("/api/students", {
    method: "POST",
    json: {
      name: "烟测学生",
      stage: "高中数学",
      notes: "长期跟踪",
      weakPoints: "向量数量积",
      commonMistakes: "坐标乘法漏加",
      parentNotes: "家长期望课堂反馈清楚",
      nextLessonSuggestion: "先补向量夹角"
    }
  });
  const student = studentResult.data.student;
  assert(student?.id, "student creation did not return an id");

  const profileResult = await request(`/api/students/${student.id}`, {
    method: "PATCH",
    json: { weakPoints: "向量数量积、垂直条件", nextLessonSuggestion: "补一节坐标运算" }
  });
  assert(profileResult.data.student.weakPoints.includes("垂直"), "student long-term profile did not update");

  const courseResult = await request(`/api/students/${student.id}/courses`, {
    method: "POST",
    json: {
      type: "formal",
      stage: "高中数学",
      grade: "高二",
      score: "80",
      province: "海南",
      textbook: "人教A版",
      lessonKind: "专题提升",
      desiredContent: "向量数量积 smoke",
      lessonTime: "2026-06-12T20:00",
      durationMinutes: 90,
      localFiles: "",
      notes: "不要自动调用 Codex",
      autoRun: false
    }
  });
  const course = courseResult.data.course;
  assert(course?.id && course.outputDir, "course creation did not return outputDir");
  assert(fs.existsSync(course.outputDir), "course output directory was not created");

  const materialForm = new FormData();
  materialForm.append(
    "files",
    new Blob(["# 向量资料\n烟测关键词：向量点乘烟测。$\\vec{a}\\cdot\\vec{b}$ 用于 RAG 检索。"], { type: "text/markdown" }),
    "烟测资料库/向量点乘.md"
  );
  const uploadResult = await request("/api/materials/upload", { method: "POST", body: materialForm });
  assert(uploadResult.data.materials?.length === 1, "material upload did not index one file");
  assert(uploadResult.data.chunkCount > 0, "material upload did not create rag chunks");

  const searchResult = await request(`/api/materials/search?q=${encodeURIComponent("向量点乘烟测")}`);
  assert(searchResult.data.results?.length > 0, "RAG search did not return uploaded material");

  const autoCourseResult = await request(`/api/students/${student.id}/courses`, {
    method: "POST",
    json: {
      type: "trial",
      stage: "高中数学",
      grade: "高二",
      score: "80",
      province: "海南",
      textbook: "人教A版",
      lessonKind: "试听诊断",
      desiredContent: "自动调用 Codex smoke",
      lessonTime: "2026-06-12T19:00",
      durationMinutes: 90,
      localFiles: "",
      notes: "验证后台自动调用",
      autoRun: true
    }
  });
  const autoCourse = autoCourseResult.data.course;
  const autoJob = autoCourseResult.data.job;
  assert(autoJob?.id, "auto-run course did not create a Codex job");
  const completed = await waitForJob(autoJob.id);
  assert(completed.job.status === "completed", `auto Codex job did not complete: ${completed.job.status}`);
  assert(completed.job.quality?.status === "pass", `auto Codex quality did not pass: ${completed.job.quality?.status}`);
  assert(completed.logTail.includes("fake Codex completed"), "auto Codex log did not include fake Codex output");
  assert(completed.logTail.includes("项目内置 Codex skill：trial-lesson-prep"), "auto Codex prompt did not use packaged trial skill");
  assert(completed.logTail.includes("Markdown 里的数学公式必须规范"), "auto Codex prompt did not include math-format rules");
  const autoFiles = await request(`/api/courses/${autoCourse.id}/files`);
  assert(autoFiles.data.files.some((file) => file.name === "老师逐字稿.md"), "auto Codex did not create teacher markdown");
  assert(autoFiles.data.files.some((file) => file.name === "课堂课件.pdf"), "auto Codex did not create pdf");

  const attachments = new FormData();
  attachments.append("files", new Blob(["附件题目：已知 $\\vec{a}=(1,2)$。"], { type: "text/markdown" }), "附件文件夹/题目.md");
  const attachmentResult = await request(`/api/courses/${course.id}/attachments`, { method: "POST", body: attachments });
  assert(attachmentResult.data.files?.length === 1, "course attachment upload failed");
  assert(fs.existsSync(attachmentResult.data.files[0]), "course attachment file missing on disk");

  const repeated = "这一段用于保证 Markdown 内容量足够，包含课堂提问、学生可能回答、追问、板书和讲解节奏。";
  const teacherMd = `# 老师逐字稿\n\n题目：已知 $\\vec{a}=(2,-1)$，$\\vec{b}=(3,4)$，求 $\\vec{a}\\cdot\\vec{b}$。\n\n${repeated.repeat(8)}\n`;
  const knowledgeMd = `# 知识点详解\n\n本文件用于说明本节课的核心概念、常见误区和课堂推进顺序。\n\n## 数量积\n\n$\\vec{a}\\cdot\\vec{b}=x_1x_2+y_1y_2$。\n\n${repeated.repeat(8)}\n`;
  const feedbackMd = `# 课后反馈\n\n本节课关注向量数量积，课后继续练习坐标运算。\n\n${repeated.repeat(3)}\n`;
  fs.writeFileSync(path.join(course.outputDir, "老师逐字稿.md"), teacherMd, "utf8");
  fs.writeFileSync(path.join(course.outputDir, "知识点详解.md"), knowledgeMd, "utf8");
  fs.writeFileSync(path.join(course.outputDir, "课后反馈.md"), feedbackMd, "utf8");
  writePdf(path.join(course.outputDir, "课堂课件.pdf"));

  const filesResult = await request(`/api/courses/${course.id}/files`);
  const files = filesResult.data.files;
  assert(files.some((file) => file.name === "老师逐字稿.md" && file.kind === "markdown"), "course files did not include teacher markdown");
  assert(files.some((file) => file.name === "课堂课件.pdf" && file.kind === "pdf"), "course files did not include pdf");

  const teacherFile = files.find((file) => file.name === "老师逐字稿.md");
  const pdfFile = files.find((file) => file.name === "课堂课件.pdf");
  const contentResult = await request(`/api/files/content?path=${encodeURIComponent(teacherFile.path)}`);
  assert(contentResult.data.content.includes("\\vec{a}"), "markdown content endpoint did not return file text");

  const rawPdf = await request(`/api/files/raw?path=${encodeURIComponent(pdfFile.path)}`);
  assert(rawPdf.response.headers.get("content-type")?.includes("application/pdf"), "raw pdf endpoint did not return pdf content type");

  const viewer = await request(`/viewer?path=${encodeURIComponent(teacherFile.path)}`);
  assert(String(viewer.data).includes("id=\"root\""), "viewer route did not return the frontend app shell");

  const qualityResult = await request(`/api/courses/${course.id}/quality`, { method: "POST" });
  assert(["pass", "warn"].includes(qualityResult.data.quality?.status), "quality check did not return a usable status");
  assert(qualityResult.data.quality.items.some((item) => item.key === "pdf-open"), "quality check did not inspect pdf");

  const backupResult = await request("/api/admin/backup");
  assert(backupResult.response.headers.get("content-type")?.includes("application/zip"), "backup endpoint did not return zip");

  const diagnosticsResult = await request("/api/admin/diagnostics");
  assert(diagnosticsResult.data.diagnostics?.checks?.length > 0, "diagnostics endpoint returned no checks");

  const coursesBeforeDelete = await request(`/api/students/${student.id}/courses`);
  assert(coursesBeforeDelete.data.courses.length === 2, "course list did not include created courses");

  await request(`/api/courses/${autoCourse.id}`, { method: "DELETE" });
  await request(`/api/courses/${course.id}`, { method: "DELETE" });
  const coursesAfterDelete = await request(`/api/students/${student.id}/courses`);
  assert(coursesAfterDelete.data.courses.length === 0, "course delete did not remove course record");

  await request(`/api/students/${student.id}`, { method: "DELETE" });
  const studentsAfterDelete = await request("/api/students");
  assert(studentsAfterDelete.data.students.length === 0, "student delete did not remove student record");

  log("all checks passed");
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
  if (process.env.SMOKE_KEEP_TEMP !== "1") {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } else {
    log(`kept temp root: ${tempRoot}`);
  }
}
