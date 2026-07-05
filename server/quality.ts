import { listCourseFiles } from "./files.js";
import { nowIso } from "./store.js";
import { courseClassroomPdfFileName } from "./courseOutput.js";
import type { Course, CourseFile, GenerationQuality, QualityCheckItem, QualityStatus } from "./types.js";

function item(
  key: string,
  label: string,
  status: QualityStatus,
  message: string,
  filePath?: string
): QualityCheckItem {
  return { key, label, status, message, path: filePath };
}

function scoreItems(items: QualityCheckItem[]) {
  let score = 100;
  for (const check of items) {
    if (check.status === "fail") score -= 25;
    if (check.status === "warn") score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

function overallStatus(items: QualityCheckItem[]): QualityStatus {
  if (items.some((check) => check.status === "fail")) return "fail";
  if (items.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

export function assessCourseQuality(course: Course, studentName?: string): GenerationQuality {
  const checks: QualityCheckItem[] = [];
  const requiredFiles = [
    { name: "老师逐字稿.md", minSize: 100 },
    { name: "知识点详解.md", minSize: 100 },
    { name: courseClassroomPdfFileName(course, studentName), minSize: 200 },
    { name: "课后反馈.md", minSize: 80 }
  ];
  let files: CourseFile[] = [];
  try {
    files = listCourseFiles(course.outputDir);
  } catch (error) {
    checks.push(
      item(
        "output-dir",
        "产物目录",
        "fail",
        error instanceof Error ? error.message : "产物目录无法读取。"
      )
    );
    return {
      score: scoreItems(checks),
      status: overallStatus(checks),
      checkedAt: nowIso(),
      items: checks
    };
  }

  const generatedFiles = files.filter((file) => !file.relativePath.replace(/\\/g, "/").startsWith("_attachments/"));
  const byName = new Map(generatedFiles.map((file) => [file.name, file]));

  for (const required of requiredFiles) {
    const file = byName.get(required.name);
    if (!file) {
      checks.push(item(`exists-${required.name}`, required.name, "fail", "缺少核心产物文件。"));
      continue;
    }
    if (file.size < required.minSize) {
      checks.push(item(`exists-${required.name}`, required.name, "fail", "文件过小，可能不是有效产物。", file.path));
    } else {
      checks.push(item(`exists-${required.name}`, required.name, "pass", "文件存在且大小正常。", file.path));
    }
  }

  const score = scoreItems(checks);
  return {
    score,
    status: overallStatus(checks),
    checkedAt: nowIso(),
    items: checks
  };
}
