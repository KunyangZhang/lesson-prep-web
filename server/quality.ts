import fs from "node:fs";
import { listCourseFiles } from "./files.js";
import { nowIso } from "./store.js";
import {
  courseClassroomPdfFileName,
  courseTeachingPdfFileName,
  homeworkAnswerPdfFileName,
  homeworkPdfFileName
} from "./courseOutput.js";
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
  ];
  if (course.type === "formal") {
    requiredFiles.push({ name: courseTeachingPdfFileName(course, studentName), minSize: 200 });
    requiredFiles.push({ name: homeworkPdfFileName, minSize: 200 });
    requiredFiles.push({ name: homeworkAnswerPdfFileName, minSize: 200 });
  }
  requiredFiles.push({ name: "课后反馈.md", minSize: 80 });
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

  const feedbackFile = byName.get("课后反馈.md");
  if (feedbackFile && feedbackFile.size >= 80) {
    const feedback = fs.readFileSync(feedbackFile.path, "utf8");
    const placeholderPattern = /\[(?:课后填写|待填写|待确认|待补充)\]|(?:课后|课后请|请|待)(?:手动)?(?:填写|补充)/;
    if (placeholderPattern.test(feedback)) {
      checks.push(
        item(
          "feedback-complete",
          "课后反馈完整度",
          "fail",
          "课后反馈仍包含待手动填写的占位内容，必须改为可直接发给家长的完整成稿。",
          feedbackFile.path
        )
      );
    } else {
      checks.push(
        item(
          "feedback-complete",
          "课后反馈完整度",
          "pass",
          "未发现需要手动回填的占位内容。",
          feedbackFile.path
        )
      );
    }

    const feedbackTemplatePattern = /^【学生姓名】：[^\n]+\n【上课日期】：\d{4}-\d{2}-\d{2}\n【授课科目】：[^\n]+\n【本节课核心内容】\n\S[^]*?\n【学生课堂掌握情况】\n1、[^\n]+\n2、[^\n]+\n【课后作业】：\n\S[^]*\n?$/;
    if (feedbackTemplatePattern.test(feedback)) {
      checks.push(
        item(
          "feedback-template",
          "课后反馈格式",
          "pass",
          "课后反馈符合六栏固定模板。",
          feedbackFile.path
        )
      );
    } else {
      checks.push(
        item(
          "feedback-template",
          "课后反馈格式",
          "fail",
          "课后反馈必须严格使用姓名、日期、科目、核心内容、两条掌握情况和课后作业六栏模板。",
          feedbackFile.path
        )
      );
    }
  }

  const workFiles = [
    { label: "_work/连续学习档案.md", paths: ["_work/连续学习档案.md"] },
    { label: "_work/题目提取.md", paths: ["_work/题目提取.md", "_work/题目索引.md"] },
    { label: "_work/答案核对表.md", paths: ["_work/答案核对表.md"] },
    {
      label: "_work/课件生成计划.md",
      paths: ["_work/课件生成计划.md", "_work/课件页码映射.md", "_work/授课一体版页码映射.md"]
    },
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
