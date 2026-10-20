import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import JSZip from "jszip";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prep-account-smoke-"));
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir);
const passwordHash = await bcrypt.hash("123456", 4);
const timestamp = new Date().toISOString();
const legacyStudent = { id: "student_legacy", name: "原有学生", stage: "高中数学", createdAt: timestamp, updatedAt: timestamp };
const longTitle = "圆锥曲线弦长、面积与垂直弦三大专题题型全覆盖：第70讲弦长问题7类题型、第71讲面积问题7类题型、第72讲垂直弦问题8类题型，按第70讲→第71讲→第72讲的顺序推进，每类题型至少选取一道典型例题。";
legacyStudent.learningMemory = `需要巩固运算步骤。\n\n---\n自动课后沉淀：\n<!-- auto:learning:course_legacy -->\n【2026-10-20 正式课 ${longTitle}】\n### 本节掌握\n- 理解弦长公式的两种形式。\n- 面积与面积比仍需巩固。\n\n<!-- auto:learning:course_previous -->\n【2026-10-18 正式课 二次函数】\n能够独立完成基础题。`;
const course = { id: "course_legacy", studentId: legacyStudent.id, type: "formal", stage: "高中数学", grade: "高三", score: "90分", province: "", textbook: "", lessonKind: "专题复习课（题型全归纳＋知识梳理）", desiredContent: longTitle, lessonTime: "", durationMinutes: 90, localFiles: "", notes: "", outputDir: path.join(root, "legacy-course"), status: "completed", createdAt: timestamp, updatedAt: timestamp };
fs.mkdirSync(course.outputDir);
fs.writeFileSync(path.join(course.outputDir, "课后反馈.md"), "# 课后反馈\n课堂测试记录。");
fs.writeFileSync(path.join(dataDir, "app-db.json"), JSON.stringify({
  users: [{ id: "user_legacy", username: "kunyang", passwordHash, createdAt: timestamp }, { id: "user_admin", username: "admin", passwordHash, createdAt: timestamp }],
  students: [legacyStudent], courses: [course], jobs: [], materials: [], ragChunks: [], templates: [], memories: [], conversations: []
}));
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const gatewayOptions = {
  cwd: projectRoot,
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), APP_DATA_DIR: dataDir, PREP_WORKSPACE: root, PREP_LISTEN_HOST: "127.0.0.1", SESSION_SECRET: "account-smoke-test-only-secret", SECURE_COOKIES: "false", CODEX_AUTO_RUN: "false", FEISHU_SYNC_ENABLED: "false", PREP_OCR_ENABLED: "false", LESSON_FEISHU_PARENT_FOLDER_TOKEN: "LegacyFolder123", FEISHU_NOTIFY_OPEN_ID: "ou_legacy" },
  stdio: ["ignore", "pipe", "pipe"]
};
let output = "";
function startGateway() {
  const child = spawn(process.execPath, ["dist/server/accountGateway.js"], gatewayOptions);
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return child;
}
let child = startGateway();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(cookie, pathname, method = "GET", body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("json") ? await response.json() : await response.arrayBuffer();
  return { response, data };
}
async function login(username, password = "123456") {
  const { response } = await request(null, "/api/login", "POST", { username, password });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Wait for startup. */ }
    if (i > 100 || child.exitCode !== null) throw new Error(`Gateway startup failed: ${output}`);
    await wait(100);
  }
  const legacy = await login("kunyang"), admin = await login("admin");
  assert.equal((await request(null, "/api/students")).response.status, 401);
  assert.equal((await request(null, "/api/courses")).response.status, 401);
  assert.equal((await request(null, "/api/feishu/settings")).response.status, 401);
  assert.equal((await request(legacy, "/api/students")).data.students[0].id, legacyStudent.id);
  assert.equal((await request(admin, "/api/students")).data.students.length, 0);
  assert.equal((await request(admin, "/api/courses")).data.courses.length, 0);
  assert.equal((await request(legacy, "/api/courses")).data.courses[0].id, course.id);
  assert.equal((await request(admin, "/api/courses/course_legacy")).response.status, 404);
  assert.equal((await request(admin, "/api/students/student_legacy", "PATCH", { name: "cross-account-change" })).response.status, 404);
  assert.equal((await request(admin, "/api/students/student_legacy", "DELETE")).response.status, 404);
  assert.equal((await request(admin, "/api/jobs/job_legacy")).response.status, 404);
  const created = await request(admin, "/api/students", "POST", { name: "admin 的学生", stage: "高中数学" });
  assert.equal(created.response.status, 200);
  const adminStudent = created.data.student;
  assert.equal((await request(legacy, "/api/students")).data.students.length, 1);
  assert.equal((await request(legacy, `/api/students/${adminStudent.id}`, "PATCH", { name: "blocked" })).response.status, 404);
  const memory = await request(admin, "/api/memories", "POST", { studentId: adminStudent.id, title: "admin 专属记忆", content: "请关注函数基础", kind: "learning", scope: "student", tags: [] });
  assert.equal(memory.response.status, 200);
  assert.equal((await request(legacy, "/api/memories")).data.memories.length, 0);
  const materialPath = path.join(dataDir, "accounts", "user_admin", "workspace", "private.md");
  fs.writeFileSync(materialPath, "admin-private-material");
  assert.equal((await request(legacy, `/api/files/content?path=${encodeURIComponent(materialPath)}`)).response.status, 500);
  assert.equal((await request(admin, `/api/files/content?path=${encodeURIComponent(path.join(course.outputDir, "课后反馈.md"))}`)).response.status, 500);
  const symlink = path.join(path.dirname(materialPath), "escape.md");
  fs.symlinkSync(path.join(course.outputDir, "课后反馈.md"), symlink);
  assert.equal((await request(admin, `/api/files/content?path=${encodeURIComponent(symlink)}`)).response.status, 500);
  const backup = await request(admin, "/api/admin/backup");
  const zip = await JSZip.loadAsync(backup.data);
  const snapshot = JSON.parse(await zip.file("app-db.json").async("string"));
  assert.equal(snapshot.users.length, 1); assert.equal(snapshot.users[0].username, "admin");
  assert.ok(snapshot.students.every((student) => student.id !== legacyStudent.id));
  const options = { syncEnabled: true, folderToken: "AdminFolder123", notifyEnabled: false, calendarEnabled: false };
  assert.equal((await request(admin, "/api/feishu/settings", "PATCH", options)).response.status, 200);
  const adminOptions = (await request(admin, "/api/feishu/settings")).data;
  const legacyOptions = (await request(legacy, "/api/feishu/settings")).data;
  assert.equal(adminOptions.settings.folderToken, "AdminFolder123");
  assert.equal(adminOptions.connection.appConfigured, false);
  assert.equal(adminOptions.settings.notifyOpenId, "");
  assert.equal(legacyOptions.settings.folderToken, "LegacyFolder123");
  assert.equal(legacyOptions.settings.notifyOpenId, "ou_legacy");
  assert.doesNotMatch(JSON.stringify(adminOptions), /appSecret|device_code|access_token|refresh_token/);
  const dashboard = await request(admin, "/api/dashboard");
  assert.equal(dashboard.data.dashboard.metrics.studentCount, 1);
  assert.equal(dashboard.data.dashboard.metrics.courseCount, 0);
  assert.equal((await request(legacy, "/api/dashboard")).data.dashboard.metrics.courseCount, 1);
  const planned = await request(admin, `/api/students/${adminStudent.id}/courses`, "POST", { desiredContent: "跨年课程排期", lessonTime: "2027-01-05T16:30", autoRun: false });
  assert.equal(planned.response.status, 200);
  assert.equal(planned.data.course.lessonTime, "2027-01-05T16:30");
  const adminSchedule = (await request(admin, "/api/courses")).data.courses;
  assert.equal(adminSchedule.length, 1);
  assert.equal(adminSchedule[0].studentId, adminStudent.id);
  assert.equal((await request(legacy, "/api/courses")).data.courses.length, 1);
  assert.equal((await request(legacy, `/api/courses/${planned.data.course.id}`)).response.status, 404);
  assert.equal((await request(admin, `/api/courses/${planned.data.course.id}`, "PATCH", { lessonTime: "2027-02-06T09:00" })).data.course.lessonTime, "2027-02-06T09:00");
  const credentials = await request(admin, "/api/me", "PATCH", { currentPassword: "123456", username: "admin-updated", newPassword: "new-test-password" });
  assert.equal(credentials.response.status, 200);
  await login("admin-updated", "new-test-password");
  const updatedBackup = await request(admin, "/api/admin/backup");
  const updatedZip = await JSZip.loadAsync(updatedBackup.data);
  const updatedDb = JSON.parse(await updatedZip.file("app-db.json").async("string"));
  assert.equal(updatedDb.users[0].username, "admin-updated");
  // Restart to verify that the migration and account paths are stable on disk.
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  child = startGateway();
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Restart in progress. */ }
    if (i > 100 || child.exitCode !== null) throw new Error("Gateway restart failed");
    await wait(100);
  }
  const persistedAdmin = await login("admin-updated", "new-test-password");
  assert.equal((await request(persistedAdmin, "/api/students")).data.students[0].id, adminStudent.id);
  assert.equal((await request(persistedAdmin, "/api/courses")).data.courses[0].lessonTime, "2027-02-06T09:00");
  assert.equal((await request(persistedAdmin, "/api/feishu/settings")).data.settings.folderToken, "AdminFolder123");
  assert.equal((await request(await login("kunyang"), "/api/students")).data.students[0].id, legacyStudent.id);
  console.log("[accounts] PASS: login, legacy migration, empty admin workspace, independent students/memories/dashboard/backup/Feishu, cross-account rejection, credential updates and restart persistence");
  if (process.env.SMOKE_ACCOUNTS_KEEP === "true") {
    console.log(`[accounts] Browser preview: ${base}; fixtures: ${root}`);
    await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  }
} catch (error) { console.error(output); throw error; }
finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(6000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
}
