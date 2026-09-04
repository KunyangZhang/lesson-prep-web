import type {
  Course,
  DashboardActivity,
  DashboardAttentionItem,
  DashboardCourseSummary,
  DashboardNextAction,
  DashboardSnapshot,
  Db
} from "./types.js";

function timestamp(value?: string) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextAction(course: Course): DashboardNextAction {
  if (course.status === "queued" || course.status === "running") return "monitor";
  if (course.status === "failed" || course.status === "canceled") return "retry";
  if (course.status === "completed" && course.postClassSummary?.status !== "confirmed") return "post_class";
  if (course.status === "completed") return "review";
  return "prepare";
}

function courseSummary(course: Course, studentNames: Map<string, string>): DashboardCourseSummary {
  return {
    courseId: course.id,
    studentId: course.studentId,
    studentName: studentNames.get(course.studentId) || "未知学生",
    title: course.desiredContent || "未命名课程",
    type: course.type,
    lessonTime: course.lessonTime,
    durationMinutes: course.durationMinutes,
    status: course.status,
    updatedAt: course.updatedAt,
    nextAction: nextAction(course)
  };
}

function attentionReason(action: DashboardNextAction) {
  if (action === "monitor") return "生成任务正在进行";
  if (action === "retry") return "生成中断，等待继续";
  if (action === "post_class") return "课后总结尚未确认";
  return "课程仍待准备";
}

function latestJobTime(job: Db["jobs"][number]) {
  return job.endedAt || job.startedAt || job.createdAt;
}

export function buildDashboardSnapshot(data: Db, now = new Date()): DashboardSnapshot {
  const studentNames = new Map(data.students.map((student) => [student.id, student.name]));
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const activeJobs = data.jobs.filter((job) => job.status === "queued" || job.status === "running");
  const upcoming = data.courses
    .filter((course) => Boolean(course.lessonTime) && timestamp(course.lessonTime) >= dayStart)
    .sort((a, b) => timestamp(a.lessonTime) - timestamp(b.lessonTime) || b.updatedAt.localeCompare(a.updatedAt));
  const postClassPending = data.courses.filter(
    (course) => course.status === "completed" && course.postClassSummary?.status !== "confirmed"
  );
  const indexedMaterials = data.materials.filter((material) => material.status === "indexed");
  const qualityScores = data.jobs
    .map((job) => job.quality?.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const averageQualityScore = qualityScores.length
    ? Math.round(qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length)
    : null;

  const attention = data.courses
    .filter((course) => {
      const action = nextAction(course);
      return action === "monitor" || action === "retry" || action === "post_class";
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8)
    .map((course): DashboardAttentionItem => {
      const summary = courseSummary(course, studentNames);
      return { ...summary, reason: attentionReason(summary.nextAction) };
    });

  const courseActivity: DashboardActivity[] = data.courses.map((course) => ({
    id: `course:${course.id}`,
    kind: "course",
    title: course.desiredContent || "未命名课程",
    detail: `${studentNames.get(course.studentId) || "未知学生"} · ${course.type === "trial" ? "试听课" : "正式课"}`,
    status: course.status,
    occurredAt: course.updatedAt,
    courseId: course.id,
    studentId: course.studentId
  }));
  const jobActivity: DashboardActivity[] = data.jobs.map((job) => {
    const course = data.courses.find((item) => item.id === job.courseId);
    return {
      id: `job:${job.id}`,
      kind: "job",
      title: job.kind === "pdf-image-refine" ? "PDF 图形修订" : job.refineInstruction ? "补充生成" : "备课生成",
      detail: course?.desiredContent || "课程任务",
      status: job.status,
      occurredAt: latestJobTime(job),
      courseId: course?.id,
      studentId: course?.studentId
    };
  });
  const materialActivity: DashboardActivity[] = data.materials.map((material) => ({
    id: `material:${material.id}`,
    kind: "material",
    title: material.title,
    detail: material.status === "indexed" ? `${material.questionCount || 0} 题 · ${material.snippetCount || 0} 个片段` : "资料索引",
    status: material.status,
    occurredAt: material.updatedAt
  }));

  return {
    generatedAt: now.toISOString(),
    metrics: {
      studentCount: data.students.length,
      courseCount: data.courses.length,
      completedCourseCount: data.courses.filter((course) => course.status === "completed").length,
      activeJobCount: activeJobs.length,
      upcomingCourseCount: upcoming.length,
      postClassPendingCount: postClassPending.length,
      indexedMaterialCount: indexedMaterials.length,
      indexedKnowledgeCount: indexedMaterials.reduce(
        (sum, material) => sum + (material.questionCount || 0) + (material.snippetCount || 0),
        0
      ),
      averageQualityScore
    },
    upcomingCourses: upcoming.slice(0, 6).map((course) => courseSummary(course, studentNames)),
    attention,
    recentActivity: [...courseActivity, ...jobActivity, ...materialActivity]
      .sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt) || a.id.localeCompare(b.id))
      .slice(0, 10)
  };
}
