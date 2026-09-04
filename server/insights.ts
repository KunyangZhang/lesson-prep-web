import type { Db, LearningInsights } from "./types.js";

const dayMs = 24 * 60 * 60 * 1000;

function percent(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function time(value?: string) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function weakPointTokens(value = "") {
  return value
    .split(/[\n,，、;；。]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 24);
}

export function buildLearningInsights(data: Db, now = new Date()): LearningInsights {
  const nowTime = now.getTime();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const currentDay = new Date(todayStart).getUTCDay();
  const currentWeekStart = todayStart - ((currentDay + 6) % 7) * dayMs;
  const weeklyLessons = Array.from({ length: 6 }, (_, index) => {
    const startTime = currentWeekStart - (5 - index) * 7 * dayMs;
    const endTime = startTime + 7 * dayMs;
    const start = new Date(startTime);
    const end = new Date(endTime - dayMs);
    return {
      start: start.toISOString(),
      end: new Date(endTime).toISOString(),
      label: `${start.getUTCMonth() + 1}/${start.getUTCDate()}-${end.getUTCMonth() + 1}/${end.getUTCDate()}`,
      count: data.courses.filter((course) => {
        const courseTime = time(course.lessonTime || course.createdAt);
        return courseTime >= startTime && courseTime < endTime;
      }).length
    };
  });
  const completed = data.courses.filter((course) => course.status === "completed");
  const confirmed = completed.filter((course) => course.postClassSummary?.status === "confirmed");
  const refinements = data.jobs.filter((job) => Boolean(job.refineInstruction) || job.kind === "pdf-image-refine");
  const qualityTrend = data.jobs
    .filter((job) => job.quality && Number.isFinite(job.quality.score))
    .sort((a, b) => time(a.quality?.checkedAt) - time(b.quality?.checkedAt))
    .slice(-10)
    .map((job) => ({
      jobId: job.id,
      courseId: job.courseId,
      score: job.quality!.score,
      checkedAt: job.quality!.checkedAt
    }));
  const averageQualityScore = qualityTrend.length
    ? Math.round(qualityTrend.reduce((sum, item) => sum + item.score, 0) / qualityTrend.length)
    : null;
  const weakPointCounts = new Map<string, number>();
  for (const student of data.students) {
    for (const token of weakPointTokens(`${student.weakPoints || ""}\n${student.commonMistakes || ""}`)) {
      weakPointCounts.set(token, (weakPointCounts.get(token) || 0) + 1);
    }
  }
  const jobCounts = new Map<string, number>();
  for (const job of data.jobs) jobCounts.set(job.courseId, (jobCounts.get(job.courseId) || 0) + 1);

  return {
    generatedAt: new Date(nowTime).toISOString(),
    summary: {
      weeklyLessonCount: weeklyLessons.at(-1)?.count || 0,
      completionRate: percent(completed.length, data.courses.length),
      postClassConfirmationRate: percent(confirmed.length, completed.length),
      refineRate: percent(refinements.length, data.jobs.length),
      averageQualityScore
    },
    weeklyLessons,
    recurringWeakPoints: [...weakPointCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .slice(0, 8)
      .map(([label, count]) => ({ label, count })),
    qualityTrend,
    revisions: {
      coursesWithRevisions: [...jobCounts.values()].filter((count) => count > 1).length,
      totalRefinements: refinements.length
    }
  };
}
