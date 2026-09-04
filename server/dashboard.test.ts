import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardSnapshot } from "./dashboard.js";
import type { Course, Db, Job, Material, Student } from "./types.js";

const now = new Date("2026-09-04T08:00:00.000Z");

function emptyDb(): Db {
  return { users: [], students: [], courses: [], jobs: [], materials: [], ragChunks: [], templates: [], memories: [], conversations: [] };
}

function student(id: string, name: string, updatedAt = "2026-09-04T07:00:00.000Z"): Student {
  return { id, name, stage: "高中数学", createdAt: updatedAt, updatedAt };
}

function course(overrides: Partial<Course> & Pick<Course, "id" | "studentId">): Course {
  const { id, studentId, ...rest } = overrides;
  return {
    id,
    studentId,
    type: "formal",
    stage: "高中数学",
    grade: "高二",
    score: "",
    province: "",
    textbook: "人教A版",
    lessonKind: "正式课",
    desiredContent: "导数综合",
    lessonTime: "2026-09-05T10:00:00.000Z",
    durationMinutes: 90,
    localFiles: "",
    notes: "",
    outputDir: "/tmp/course",
    status: "draft",
    createdAt: "2026-09-03T08:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
    ...rest
  };
}

function job(overrides: Partial<Job> & Pick<Job, "id" | "courseId">): Job {
  const { id, courseId, ...rest } = overrides;
  return {
    id,
    courseId,
    status: "completed",
    logPath: "/tmp/job.log",
    lastMessagePath: "/tmp/job.md",
    command: "codex",
    args: [],
    runner: "local",
    createdAt: "2026-09-03T09:00:00.000Z",
    ...rest
  };
}

function material(overrides: Partial<Material> & Pick<Material, "id">): Material {
  const { id, ...rest } = overrides;
  return {
    id,
    title: "函数资料",
    path: "/tmp/material.md",
    size: 100,
    status: "indexed",
    chunkCount: 4,
    questionCount: 3,
    snippetCount: 2,
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
    ...rest
  };
}

test("dashboard snapshot is zero-safe for a new workspace", () => {
  const snapshot = buildDashboardSnapshot(emptyDb(), now);

  assert.deepEqual(snapshot.metrics, {
    studentCount: 0,
    courseCount: 0,
    completedCourseCount: 0,
    activeJobCount: 0,
    upcomingCourseCount: 0,
    postClassPendingCount: 0,
    indexedMaterialCount: 0,
    indexedKnowledgeCount: 0,
    averageQualityScore: null
  });
  assert.deepEqual(snapshot.upcomingCourses, []);
  assert.deepEqual(snapshot.attention, []);
  assert.deepEqual(snapshot.recentActivity, []);
});

test("dashboard snapshot aggregates queues, quality and recent activity", () => {
  const data = emptyDb();
  data.students = [student("student-1", "林同学"), student("student-2", "周同学")];
  data.courses = [
    course({ id: "course-upcoming", studentId: "student-1", lessonTime: "2026-09-05T10:00:00.000Z" }),
    course({
      id: "course-running",
      studentId: "student-2",
      desiredContent: "圆锥曲线",
      lessonTime: "2026-09-04T11:00:00.000Z",
      status: "running",
      updatedAt: "2026-09-04T07:40:00.000Z"
    }),
    course({
      id: "course-review",
      studentId: "student-1",
      desiredContent: "数列复习",
      lessonTime: "2026-09-03T10:00:00.000Z",
      status: "completed",
      updatedAt: "2026-09-04T07:30:00.000Z"
    }),
    course({
      id: "course-done",
      studentId: "student-2",
      desiredContent: "立体几何",
      lessonTime: "2026-09-02T10:00:00.000Z",
      status: "completed",
      postClassSummary: { status: "confirmed", mastered: "线面关系" },
      updatedAt: "2026-09-03T07:00:00.000Z"
    })
  ];
  data.jobs = [
    job({ id: "job-running", courseId: "course-running", status: "running", createdAt: "2026-09-04T07:35:00.000Z" }),
    job({
      id: "job-quality-a",
      courseId: "course-review",
      quality: { score: 90, status: "pass", checkedAt: "2026-09-04T07:31:00.000Z", items: [] }
    }),
    job({
      id: "job-quality-b",
      courseId: "course-done",
      quality: { score: 70, status: "warn", checkedAt: "2026-09-03T07:01:00.000Z", items: [] }
    })
  ];
  data.materials = [material({ id: "material-indexed" }), material({ id: "material-failed", status: "failed", questionCount: 9 })];

  const snapshot = buildDashboardSnapshot(data, now);

  assert.equal(snapshot.metrics.studentCount, 2);
  assert.equal(snapshot.metrics.courseCount, 4);
  assert.equal(snapshot.metrics.completedCourseCount, 2);
  assert.equal(snapshot.metrics.activeJobCount, 1);
  assert.equal(snapshot.metrics.upcomingCourseCount, 2);
  assert.equal(snapshot.metrics.postClassPendingCount, 1);
  assert.equal(snapshot.metrics.indexedMaterialCount, 1);
  assert.equal(snapshot.metrics.indexedKnowledgeCount, 5);
  assert.equal(snapshot.metrics.averageQualityScore, 80);
  assert.deepEqual(snapshot.upcomingCourses.map((item) => item.courseId), ["course-running", "course-upcoming"]);
  assert.deepEqual(snapshot.attention.map((item) => item.courseId), ["course-running", "course-review"]);
  assert.equal(snapshot.attention[0]?.nextAction, "monitor");
  assert.equal(snapshot.attention[1]?.nextAction, "post_class");
  assert.equal(snapshot.recentActivity[0]?.occurredAt, "2026-09-04T07:40:00.000Z");
});
