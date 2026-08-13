import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  courseClassroomPdfFileName,
  courseTeachingPdfFileName,
  ensureCoursePdfFileNames,
  homeworkAnswerPdfFileName,
  homeworkPdfFileName
} from "./courseOutput.js";
import { buildCodexExecArgs, continueCodexJob, recoverInterruptedJobs } from "./jobs.js";
import { fitFilenameComponent, maxSafeFilenameBytes, Store } from "./store.js";
import type { Course, Db, Job, Student } from "./types.js";

function fixture(): Db {
  const now = "2026-07-18T00:00:00.000Z";
  const student: Student = {
    id: "student-1",
    name: "测试学生",
    stage: "高一",
    notes: "",
    createdAt: now,
    updatedAt: now
  };
  const course: Course = {
    id: "course-1",
    studentId: student.id,
    type: "formal",
    stage: "高中",
    grade: "高一",
    score: "",
    province: "",
    textbook: "",
    lessonKind: "正式课",
    desiredContent: "测试课程",
    durationMinutes: 90,
    lessonTime: "",
    localFiles: "",
    notes: "",
    outputDir: "/tmp/test-course",
    status: "running",
    jobId: "job-1",
    createdAt: now,
    updatedAt: now
  };
  const job: Job = {
    id: "job-1",
    courseId: course.id,
    status: "running",
    logPath: "/tmp/job.log",
    lastMessagePath: "/tmp/job.last.md",
    command: "codex exec",
    args: [],
    runner: "local",
    createdAt: now,
    startedAt: now
  };
  return { users: [], students: [student], courses: [course], jobs: [job], materials: [], ragChunks: [] };
}

function validPostClassFeedback() {
  return [
    "【学生姓名】：测试学生",
    "【上课日期】：2026-07-18",
    "【授课科目】：数学",
    "【本节课核心内容】",
    "本节课围绕测试课程完成知识梳理、例题分析与方法总结。",
    "【学生课堂掌握情况】",
    "1、能够理解本节课核心概念，并按步骤完成基础题。",
    "2、综合题仍需加强条件检查与规范书写，课后继续巩固。",
    "【课后作业】：",
    "完成配套课后作业并对照参考答案订正。"
  ].join("\n");
}

test("Codex exec accepts generated workspaces outside a git repository", () => {
  const args = buildCodexExecArgs("/tmp/generated-course", "/tmp/last-message.md");
  assert.deepEqual(args.slice(0, 5), [
    "exec",
    "--skip-git-repo-check",
    "-C",
    "/tmp/generated-course",
    "--sandbox"
  ]);
  assert.ok(args.includes("--output-last-message"));
});

test("formal PDF names stay stable when lessonTime is empty", () => {
  const course = fixture().courses[0]!;
  course.outputDir = "/root/测试学生/2026-07-21_21-32_正式课_测试课程";
  course.lessonTime = "";

  assert.equal(courseClassroomPdfFileName(course, "测试学生"), "测试学生_2026-07-21_21-32_测试课程.pdf");
  assert.equal(courseTeachingPdfFileName(course, "测试学生"), "测试学生_2026-07-21_21-32_测试课程_授课一体版.pdf");
});

test("long CJK course names fit filesystem limits and preserve PDF suffixes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-long-name-"));
  const course = fixture().courses[0]!;
  course.outputDir = directory;
  course.desiredContent = "按资料顺序完成空间几何体与点线面位置关系高难综合训练".repeat(12);

  try {
    const classroomName = courseClassroomPdfFileName(course, "郭崧涵");
    const teachingName = courseTeachingPdfFileName(course, "郭崧涵");
    assert.ok(Buffer.byteLength(classroomName, "utf8") <= maxSafeFilenameBytes);
    assert.ok(Buffer.byteLength(teachingName, "utf8") <= maxSafeFilenameBytes);
    assert.match(classroomName, /\.pdf$/);
    assert.match(teachingName, /_授课一体版\.pdf$/);

    fs.mkdirSync(path.join(directory, "_work"), { recursive: true });
    fs.writeFileSync(path.join(directory, "_work", "课堂讲义.pdf"), Buffer.alloc(300, 1));
    fs.writeFileSync(path.join(directory, "_work", "授课一体版.pdf"), Buffer.alloc(320, 2));
    ensureCoursePdfFileNames(course, "郭崧涵");
    assert.ok(fs.existsSync(path.join(directory, classroomName)));
    assert.ok(fs.existsSync(path.join(directory, teachingName)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("filename collision suffix keeps the component within the byte limit", () => {
  const name = fitFilenameComponent("课程目录".repeat(100), "-123");
  assert.ok(Buffer.byteLength(name, "utf8") <= maxSafeFilenameBytes);
  assert.match(name, /-123$/);
});

test("reload preserves active entity references so completion is persisted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-store-"));
  const dbPath = path.join(directory, "app-db.json");
  fs.writeFileSync(dbPath, JSON.stringify(fixture()), "utf8");

  try {
    const store = new Store(dbPath);
    const job = store.findJob("job-1");
    const course = store.findCourse("course-1");
    assert.ok(job);
    assert.ok(course);

    const external = fixture();
    external.materials.push({
      id: "material-1",
      title: "并行索引资料",
      path: "/tmp/material.md",
      size: 100,
      status: "indexed",
      chunkCount: 1,
      createdAt: "2026-07-18T00:01:00.000Z",
      updatedAt: "2026-07-18T00:01:00.000Z"
    });
    fs.writeFileSync(dbPath, JSON.stringify(external), "utf8");

    store.reload();
    assert.strictEqual(store.findJob("job-1"), job);
    assert.strictEqual(store.findCourse("course-1"), course);
    assert.equal(store.data.materials.length, 1);

    job.status = "completed";
    job.exitCode = 0;
    job.endedAt = "2026-07-18T00:02:00.000Z";
    course.status = "completed";
    course.updatedAt = job.endedAt;
    store.save();

    const saved = JSON.parse(fs.readFileSync(dbPath, "utf8")) as Db;
    assert.equal(saved.jobs[0]?.status, "completed");
    assert.equal(saved.courses[0]?.status, "completed");
    assert.equal(saved.materials[0]?.id, "material-1");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("non-persisting stores cannot overwrite the parent database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-store-worker-"));
  const dbPath = path.join(directory, "app-db.json");
  fs.writeFileSync(dbPath, JSON.stringify(fixture()), "utf8");

  try {
    const workerStore = new Store(dbPath, { persist: false });
    workerStore.findJob("job-1")!.status = "failed";
    workerStore.save();

    const saved = JSON.parse(fs.readFileSync(dbPath, "utf8")) as Db;
    assert.equal(saved.jobs[0]?.status, "running");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup recovery restores a fully successful staged job", () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".test-store-recovery-"));
  const outputDir = path.join(directory, "course-output");
  const dbPath = path.join(directory, "app-db.json");
  const data = fixture();
  const course = data.courses[0]!;
  const job = data.jobs[0]!;
  course.outputDir = outputDir;
  course.lessonTime = "2026-07-18T10:00";
  job.logPath = path.join(directory, "job.log");
  job.lastMessagePath = path.join(directory, "job.last.md");

  fs.mkdirSync(path.join(outputDir, "_work"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "老师逐字稿.md"), "讲".repeat(120), "utf8");
  fs.writeFileSync(path.join(outputDir, "知识点详解.md"), "知".repeat(120), "utf8");
  fs.writeFileSync(path.join(outputDir, "课后反馈.md"), validPostClassFeedback(), "utf8");
  fs.writeFileSync(path.join(outputDir, "_work", "课堂讲义.pdf"), Buffer.alloc(300, 1));
  fs.writeFileSync(path.join(outputDir, "_work", "授课一体版.pdf"), Buffer.alloc(320, 2));
  fs.writeFileSync(path.join(outputDir, homeworkPdfFileName), Buffer.alloc(340, 3));
  fs.writeFileSync(path.join(outputDir, homeworkAnswerPdfFileName), Buffer.alloc(360, 4));
  fs.writeFileSync(
    job.logPath,
    [
      "# staged codex exec",
      "--- END STAGE: stage-1-foundation exit=0 ---",
      "--- END STAGE: stage-2-pdf exit=0 ---",
      "--- END STAGE: stage-3-knowledge exit=0 ---",
      "--- END STAGE: stage-4-script-feedback exit=0 ---"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(job.lastMessagePath, "完成", "utf8");
  fs.writeFileSync(dbPath, JSON.stringify(data), "utf8");

  try {
    const store = new Store(dbPath);
    recoverInterruptedJobs(store);

    assert.equal(store.findJob(job.id)?.status, "completed");
    assert.equal(store.findJob(job.id)?.exitCode, 0);
    assert.ok(store.findJob(job.id)?.endedAt);
    assert.notEqual(store.findJob(job.id)?.quality?.status, "fail");
    assert.equal(store.findCourse(course.id)?.status, "completed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("continuing a failed job finalizes completed stages without launching another job", () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".test-store-continue-"));
  const outputDir = path.join(directory, "course-output");
  const dbPath = path.join(directory, "app-db.json");
  const data = fixture();
  const course = data.courses[0]!;
  const job = data.jobs[0]!;
  course.outputDir = outputDir;
  course.desiredContent = "超长中文课程主题".repeat(30);
  course.status = "failed";
  job.status = "failed";
  job.error = "ENAMETOOLONG: name too long";
  job.logPath = path.join(directory, "job.log");
  job.lastMessagePath = path.join(directory, "job.last.md");

  fs.mkdirSync(path.join(outputDir, "_work"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "老师逐字稿.md"), "讲".repeat(120), "utf8");
  fs.writeFileSync(path.join(outputDir, "知识点详解.md"), "知".repeat(120), "utf8");
  fs.writeFileSync(path.join(outputDir, "课后反馈.md"), validPostClassFeedback(), "utf8");
  fs.writeFileSync(path.join(outputDir, "_work", "课堂讲义.pdf"), Buffer.alloc(300, 1));
  fs.writeFileSync(path.join(outputDir, "_work", "授课一体版.pdf"), Buffer.alloc(320, 2));
  fs.writeFileSync(path.join(outputDir, homeworkPdfFileName), Buffer.alloc(340, 3));
  fs.writeFileSync(path.join(outputDir, homeworkAnswerPdfFileName), Buffer.alloc(360, 4));
  fs.writeFileSync(
    job.logPath,
    [
      "# staged codex exec",
      "--- END STAGE: stage-1-foundation exit=0 ---",
      "--- END STAGE: stage-2-pdf exit=0 ---",
      "--- END STAGE: stage-3-knowledge exit=0 ---",
      "--- END STAGE: stage-4-script-feedback exit=0 ---"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(job.lastMessagePath, "完成", "utf8");
  fs.writeFileSync(dbPath, JSON.stringify(data), "utf8");

  try {
    const store = new Store(dbPath);
    const result = continueCodexJob(store, job.id);
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(store.data.jobs.length, 1);
    assert.equal(store.findJob(job.id)?.status, "completed");
    assert.equal(store.findCourse(course.id)?.status, "completed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
