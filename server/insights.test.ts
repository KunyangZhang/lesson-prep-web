import assert from "node:assert/strict";
import test from "node:test";
import { buildLearningInsights } from "./insights.js";
import type { Course, Db, Job, Student } from "./types.js";

const baseCourse: Course = {
  id: "course-1",
  studentId: "student-1",
  type: "formal",
  stage: "高中数学",
  grade: "高二",
  score: "",
  province: "",
  textbook: "",
  lessonKind: "专题提升",
  desiredContent: "导数",
  lessonTime: "2026-09-04T10:00:00.000Z",
  durationMinutes: 90,
  localFiles: "",
  notes: "",
  outputDir: "/tmp/course",
  status: "completed",
  postClassSummary: { status: "confirmed" },
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z"
};

function baseJob(id: string, courseId: string, score: number, refineInstruction = ""): Job {
  return {
    id,
    courseId,
    status: "completed",
    logPath: "/tmp/job.log",
    lastMessagePath: "/tmp/job.md",
    command: "codex",
    args: [],
    runner: "local",
    refineInstruction,
    quality: { score, status: score >= 80 ? "pass" : "warn", checkedAt: `2026-09-04T0${score % 10}:00:00.000Z`, items: [] },
    createdAt: "2026-09-04T08:00:00.000Z"
  };
}

test("learning insights calculate rates, trends and recurring weak points", () => {
  const students: Student[] = [
    { id: "student-1", name: "林同学", weakPoints: "函数单调性，审题", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    { id: "student-2", name: "周同学", commonMistakes: "审题；计算粗心", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }
  ];
  const data: Db = {
    users: [],
    students,
    courses: [baseCourse, { ...baseCourse, id: "course-2", studentId: "student-2", status: "draft", postClassSummary: undefined }],
    jobs: [baseJob("job-1", "course-1", 90), baseJob("job-2", "course-1", 70, "补充变式题")],
    materials: [],
    ragChunks: [],
    templates: [],
    memories: [],
    conversations: []
  };

  const insights = buildLearningInsights(data, new Date("2026-09-04T12:00:00.000Z"));
  assert.equal(insights.summary.weeklyLessonCount, 2);
  assert.equal(insights.summary.completionRate, 50);
  assert.equal(insights.summary.postClassConfirmationRate, 100);
  assert.equal(insights.summary.refineRate, 50);
  assert.equal(insights.summary.averageQualityScore, 80);
  assert.deepEqual(insights.recurringWeakPoints[0], { label: "审题", count: 2 });
  assert.equal(insights.revisions.coursesWithRevisions, 1);
  assert.equal(insights.revisions.totalRefinements, 1);
  assert.deepEqual(insights.qualityTrend.map((item) => item.score), [90, 70]);
});

test("learning insights are zero-safe", () => {
  const data: Db = { users: [], students: [], courses: [], jobs: [], materials: [], ragChunks: [], templates: [], memories: [], conversations: [] };
  const insights = buildLearningInsights(data, new Date("2026-09-04T12:00:00.000Z"));
  assert.equal(insights.summary.completionRate, 0);
  assert.equal(insights.summary.averageQualityScore, null);
  assert.equal(insights.weeklyLessons.length, 6);
});
