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
  const byRelativePath = new Map(generatedFiles.map((file) => [file.relativePath.replace(/\\/g, "/"), file]));

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

  const workFiles = [
    { label: "_work/题目提取.md", paths: ["_work/题目提取.md", "_work/题目索引.md"] },
    { label: "_work/答案核对表.md", paths: ["_work/答案核对表.md"] },
    { label: "_work/课件生成计划.md", paths: ["_work/课件生成计划.md", "_work/课件页码映射.md"] },
    { label: "_work/逐字稿丰富清单.md", paths: ["_work/逐字稿丰富清单.md", "_work/内容丰富清单.md"] }
  ];
  for (const workFile of workFiles) {
    const file = workFile.paths.map((relativePath) => byRelativePath.get(relativePath)).find(Boolean);
    if (!file) {
      checks.push(item(`work-${workFile.label}`, workFile.label, "warn", "缺少多 Agent 分工中间文件。"));
      continue;
    }
    if (file.size < 30) {
      checks.push(item(`work-${workFile.label}`, workFile.label, "warn", "中间文件过小，可能没有有效记录。", file.path));
    } else {
      checks.push(item(`work-${workFile.label}`, workFile.label, "pass", "中间文件存在。", file.path));
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
