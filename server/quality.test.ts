import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  courseClassroomPdfFileName,
  courseTeachingPdfFileName,
  homeworkAnswerPdfFileName,
  homeworkPdfFileName
} from "./courseOutput.js";
import { assessCourseQuality } from "./quality.js";
import type { Course } from "./types.js";

function createTrialCourse(outputDir: string): Course {
  return {
    id: "course-quality-feedback",
    studentId: "student-quality-feedback",
    type: "trial",
    stage: "高中数学",
    grade: "高二",
    score: "",
    province: "",
    textbook: "",
    lessonKind: "试听课",
    desiredContent: "导数单调性",
    lessonTime: "2026-07-26T19:00",
    durationMinutes: 60,
    localFiles: "",
    notes: "",
    outputDir,
    status: "completed",
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:00:00.000Z"
  };
}

function writeRequiredOutputs(course: Course, feedback: string) {
  fs.writeFileSync(path.join(course.outputDir, "老师逐字稿.md"), "讲".repeat(120), "utf8");
  fs.writeFileSync(path.join(course.outputDir, "知识点详解.md"), "知".repeat(120), "utf8");
  fs.writeFileSync(path.join(course.outputDir, "课后反馈.md"), feedback, "utf8");
  fs.writeFileSync(path.join(course.outputDir, courseClassroomPdfFileName(course, "测试学生")), Buffer.alloc(300, 1));
  if (course.type === "formal") {
    fs.writeFileSync(path.join(course.outputDir, courseTeachingPdfFileName(course, "测试学生")), Buffer.alloc(300, 1));
    fs.writeFileSync(path.join(course.outputDir, homeworkPdfFileName), Buffer.alloc(300, 1));
    fs.writeFileSync(path.join(course.outputDir, homeworkAnswerPdfFileName), Buffer.alloc(300, 1));
  }
}

test("formal course quality requires homework and its answer PDF", () => {
  const outputDir = fs.mkdtempSync(path.join(process.cwd(), ".test-quality-homework-"));
  const course = { ...createTrialCourse(outputDir), type: "formal" as const, lessonKind: "正式课" };

  try {
    writeRequiredOutputs(course, `# 课后反馈\n\n## 学生课堂表现\n\n课堂参与稳定。\n\n## 课后作业\n\n完成配套四题。${"反馈".repeat(50)}`);
    const quality = assessCourseQuality(course, "测试学生");
    assert.equal(quality.items.find((item) => item.key === `exists-${homeworkPdfFileName}`)?.status, "pass");
    assert.equal(quality.items.find((item) => item.key === `exists-${homeworkAnswerPdfFileName}`)?.status, "pass");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("post-class feedback quality rejects manual fill-in placeholders", () => {
  const outputDir = fs.mkdtempSync(path.join(process.cwd(), ".test-quality-feedback-"));
  const course = createTrialCourse(outputDir);

  try {
    writeRequiredOutputs(course, `# 课后反馈\n\n## 学生课堂表现\n\n[课后填写]\n\n${"反馈".repeat(50)}`);
    const quality = assessCourseQuality(course, "测试学生");
    const feedbackCheck = quality.items.find((item) => item.key === "feedback-complete");

    assert.equal(feedbackCheck?.status, "fail");
    assert.equal(quality.status, "fail");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("post-class feedback quality accepts a ready-to-send draft", () => {
  const outputDir = fs.mkdtempSync(path.join(process.cwd(), ".test-quality-feedback-"));
  const course = createTrialCourse(outputDir);

  try {
    writeRequiredOutputs(
      course,
      `【学生姓名】：测试学生\n【上课日期】：2026-08-01\n【授课科目】：数学\n【本节课核心内容】\n本节课学习导数与单调性。\n【学生课堂掌握情况】\n1、基础内容已跟上，重难点仍需通过练习巩固。\n2、课堂参与积极，能够配合完成讲解与练习。\n【课后作业】：\n根据课堂内容上传题目图片。`
    );
    const quality = assessCourseQuality(course, "测试学生");
    const feedbackCheck = quality.items.find((item) => item.key === "feedback-complete");

    assert.equal(feedbackCheck?.status, "pass");
    assert.equal(quality.items.find((item) => item.key === "feedback-template")?.status, "pass");
    assert.notEqual(quality.status, "fail");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("post-class feedback quality rejects the retired long-form layout", () => {
  const outputDir = fs.mkdtempSync(path.join(process.cwd(), ".test-quality-feedback-template-"));
  const course = createTrialCourse(outputDir);

  try {
    writeRequiredOutputs(course, `# 课后反馈\n\n## 学生课堂表现\n\n课堂参与稳定。${"反馈".repeat(50)}`);
    const quality = assessCourseQuality(course, "测试学生");

    assert.equal(quality.items.find((item) => item.key === "feedback-template")?.status, "fail");
    assert.equal(quality.status, "fail");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
