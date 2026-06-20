import fs from "node:fs";
import path from "node:path";
import { listCourseFiles } from "./files.js";
import { nowIso } from "./store.js";
import type { Course, CourseFile, GenerationQuality, QualityCheckItem, QualityStatus } from "./types.js";

const requiredFiles = [
  { name: "老师逐字稿.md", minSize: 100 },
  { name: "知识点详解.md", minSize: 100 },
  { name: "课堂课件.pdf", minSize: 200 },
  { name: "课后反馈.md", minSize: 80 }
];

const requiredWorkFiles = [
  "_work/题目索引.md",
  "_work/候选题池.md",
  "_work/答案核对表.md",
  "_work/课件页码映射.md",
  "_work/内容丰富清单.md"
];

const rawLatexCommandPattern =
  /\\(?:frac|dfrac|tfrac|sqrt|times|sum|prod|int|lim|begin|end|cdot|leq|geq|neq|vec|overrightarrow|perp|parallel|angle|sim|mu|sigma|alpha|beta|gamma|theta|Delta)\b/;

const jumpStepPattern = /显然|容易得到|易得|不难看出|直接可得|套公式|直接代入|过程省略|证明略|略去|此处略|同理可得/g;
const questionPattern = /第\s*[一二三四五六七八九十百\d]+\s*题/g;
const teacherScriptMarkers = ["老师说", "学生可能回答", "追问", "纠错", "板书"];
const answerCheckMarkers = ["最终答案", "关键条件", "关键步骤", "易错点", "核对结论"];
const richnessMarkers = ["诊断", "例题", "模型", "变式", "巩固", "作业", "同类验证"];

function item(
  key: string,
  label: string,
  status: QualityStatus,
  message: string,
  filePath?: string
): QualityCheckItem {
  return { key, label, status, message, path: filePath };
}

function readText(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

function findEmptyMarkdownSections(markdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const emptyHeadings: string[] = [];
  let currentHeading = "";
  let body: string[] = [];

  function flush() {
    if (!currentHeading) return;
    const text = body
      .join("\n")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, "")
      .trim();
    if (text.length < 8) emptyHeadings.push(currentHeading);
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      currentHeading = heading[2].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();

  return emptyHeadings;
}

function removeDelimitedMath(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\\\[[\s\S]*?\\\]/g, "")
    .replace(/\$[^$\n]+?\$/g, "")
    .replace(/\\\([\s\S]*?\\\)/g, "");
}

function countMatches(value: string, pattern: RegExp) {
  return (value.match(pattern) || []).length;
}

function checkMarkdownFile(filePath: string) {
  const checks: QualityCheckItem[] = [];
  const text = readText(filePath);
  const basename = path.basename(filePath);
  const plainText = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_>`|[\]()$\\]/g, "")
    .replace(/\s+/g, "");

  if (plainText.length < 300 && basename !== "课后反馈.md") {
    checks.push(
      item(
        `md-short-${basename}`,
        `${basename} 内容量`,
        "warn",
        "正文偏短，建议人工确认是否够上课使用。",
        filePath
      )
    );
  }

  const emptyHeadings = findEmptyMarkdownSections(text);
  if (emptyHeadings.length > 0) {
    checks.push(
      item(
        `md-empty-${basename}`,
        `${basename} 空标题`,
        "warn",
        `发现 ${emptyHeadings.length} 个疑似空段落：${emptyHeadings.slice(0, 4).join("、")}`,
        filePath
      )
    );
  }

  const leftInline = countMatches(text, /\\\(/g);
  const rightInline = countMatches(text, /\\\)/g);
  const leftBlock = countMatches(text, /\\\[/g);
  const rightBlock = countMatches(text, /\\\]/g);
  const dollarCount = countMatches(text, /\$\$/g);
  if (leftInline !== rightInline || leftBlock !== rightBlock || dollarCount % 2 !== 0) {
    checks.push(
      item(
        `math-balance-${basename}`,
        `${basename} 公式分隔符`,
        "fail",
        "公式分隔符数量不匹配，网页或 PDF 中可能无法正常显示。",
        filePath
      )
    );
  }

  if (leftInline > 0 || leftBlock > 0) {
    checks.push(
      item(
        `math-legacy-${basename}`,
        `${basename} 公式格式`,
        "warn",
        "发现旧式 \\(...\\) 或 \\[...\\] 公式，建议改成 $...$ 或 $$...$$，网页渲染更稳定。",
        filePath
      )
    );
  }

  const outsideMath = removeDelimitedMath(text);
  if (rawLatexCommandPattern.test(outsideMath)) {
    checks.push(
      item(
        `math-raw-${basename}`,
        `${basename} 裸公式`,
        "warn",
        "发现疑似未包在数学分隔符里的 LaTeX 命令。",
        filePath
      )
    );
  }

  return checks;
}

function findCourseFile(files: CourseFile[], relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  return files.find((file) => file.relativePath.replace(/\\/g, "/") === normalized);
}

function readCourseTextFile(files: CourseFile[], relativePath: string) {
  const file = findCourseFile(files, relativePath);
  if (!file || file.kind !== "markdown") return { file, text: "" };
  return { file, text: readText(file.path) };
}

function lessonQuestionMinimum(course: Course) {
  if (course.type === "trial") {
    return course.durationMinutes >= 60 ? 6 : 5;
  }
  if (course.durationMinutes >= 90) return 10;
  if (course.durationMinutes >= 60) return 7;
  return 5;
}

function uniqueQuestionCount(...texts: string[]) {
  const labels = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(questionPattern)) {
      labels.add(match[0].replace(/\s+/g, ""));
    }
  }
  return labels.size;
}

function checkWorkFiles(files: CourseFile[]) {
  const checks: QualityCheckItem[] = [];
  for (const relativePath of requiredWorkFiles) {
    const file = findCourseFile(files, relativePath);
    if (!file) {
      checks.push(item(`work-${relativePath}`, relativePath, "fail", "缺少备课中间产物，无法判断题目、答案核对和内容丰富过程。"));
      continue;
    }
    if (file.size < 120) {
      checks.push(item(`work-size-${relativePath}`, relativePath, "warn", "中间产物内容偏少，建议确认是否只是占位。", file.path));
    } else {
      checks.push(item(`work-exists-${relativePath}`, relativePath, "pass", "中间产物存在。", file.path));
    }
  }
  return checks;
}

function checkAnswerVerification(files: CourseFile[]) {
  const checks: QualityCheckItem[] = [];
  const { file, text } = readCourseTextFile(files, "_work/答案核对表.md");
  if (!file) return checks;

  const missingMarkers = answerCheckMarkers.filter((marker) => !text.includes(marker));
  if (missingMarkers.length > 0) {
    checks.push(
      item(
        "answer-check-structure",
        "答案核对表结构",
        "fail",
        `答案核对表缺少关键栏目：${missingMarkers.join("、")}。`,
        file.path
      )
    );
  } else {
    checks.push(item("answer-check-structure", "答案核对表结构", "pass", "答案核对表包含关键核对栏目。", file.path));
  }

  if (/未核对|待核对|答案不确定|存疑|待确认/.test(text)) {
    checks.push(item("answer-check-unverified", "答案核对结论", "fail", "答案核对表仍有未核对或存疑题目。", file.path));
  }

  return checks;
}

function checkQuestionVolume(course: Course, files: CourseFile[]) {
  const checks: QualityCheckItem[] = [];
  const teacher = readCourseTextFile(files, "老师逐字稿.md");
  const index = readCourseTextFile(files, "_work/题目索引.md");
  const pool = readCourseTextFile(files, "_work/候选题池.md");
  const richness = readCourseTextFile(files, "_work/内容丰富清单.md");
  const count = uniqueQuestionCount(teacher.text, index.text, pool.text);
  const minimum = lessonQuestionMinimum(course);
  if (count < minimum) {
    checks.push(
      item(
        "question-volume",
        "题量",
        "fail",
        `识别到约 ${count} 道题，低于当前课长建议下限 ${minimum}。请补诊断、例题、变式、巩固或作业。`,
        teacher.file?.path || index.file?.path
      )
    );
  } else {
    checks.push(item("question-volume", "题量", "pass", `识别到约 ${count} 道题，达到当前课长建议下限 ${minimum}。`, teacher.file?.path));
  }

  if (richness.file) {
    const missing = richnessMarkers.filter((marker) => !richness.text.includes(marker));
    if (missing.length > 2) {
      checks.push(
        item(
          "content-richness",
          "内容丰富清单",
          "warn",
          `内容丰富清单缺少多个环节关键词：${missing.join("、")}。`,
          richness.file.path
        )
      );
    } else {
      checks.push(item("content-richness", "内容丰富清单", "pass", "内容丰富清单覆盖主要教学环节。", richness.file.path));
    }
  }

  return checks;
}

function checkTeacherScriptDepth(files: CourseFile[]) {
  const checks: QualityCheckItem[] = [];
  const { file, text } = readCourseTextFile(files, "老师逐字稿.md");
  if (!file) return checks;

  const missingMarkers = teacherScriptMarkers.filter((marker) => !text.includes(marker));
  if (missingMarkers.length > 1) {
    checks.push(
      item(
        "teacher-script-markers",
        "逐字稿丰富度",
        "fail",
        `逐字稿缺少关键教学话术标记：${missingMarkers.join("、")}。`,
        file.path
      )
    );
  } else {
    checks.push(item("teacher-script-markers", "逐字稿丰富度", "pass", "逐字稿包含主要教学话术标记。", file.path));
  }

  const jumpMatches = text.match(jumpStepPattern) || [];
  if (jumpMatches.length >= 8) {
    checks.push(
      item(
        "teacher-script-jump-steps",
        "跳步风险",
        "fail",
        `逐字稿出现 ${jumpMatches.length} 处疑似跳步表述，例如“${[...new Set(jumpMatches)].slice(0, 4).join("、")}”。`,
        file.path
      )
    );
  } else if (jumpMatches.length > 0) {
    checks.push(
      item(
        "teacher-script-jump-steps",
        "跳步风险",
        "warn",
        `逐字稿出现 ${jumpMatches.length} 处疑似跳步表述，建议人工确认。`,
        file.path
      )
    );
  } else {
    checks.push(item("teacher-script-jump-steps", "跳步风险", "pass", "未发现明显跳步套话。", file.path));
  }

  return checks;
}

function checkExamSourcePolicy(files: CourseFile[]) {
  const checks: QualityCheckItem[] = [];
  const index = readCourseTextFile(files, "_work/题目索引.md");
  const pool = readCourseTextFile(files, "_work/候选题池.md");
  const text = `${index.text}\n${pool.text}`;
  const filePath = index.file?.path || pool.file?.path;
  if (!text.trim()) return checks;

  if (/真题|高考|中考|一模|二模|模拟/.test(text)) {
    if (/(19|20)\d{2}年/.test(text) && /全国|新高考|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|一模|二模|模拟/.test(text)) {
      checks.push(item("exam-source", "真题来源", "pass", "真题或模考题包含年份和地区/试卷信息。", filePath));
    } else {
      checks.push(item("exam-source", "真题来源", "warn", "候选题池提到真题/模考，但年份、地区或试卷信息可能不完整。", filePath));
    }
  }
  if (/伪称真题|来源待核验/.test(text)) {
    checks.push(item("exam-source-uncertain", "真题来源风险", "warn", "存在来源待核验或不得伪称真题的提示，请人工确认。", filePath));
  }

  return checks;
}

function checkPdf(filePath: string) {
  const buffer = fs.readFileSync(filePath);
  const head = buffer.subarray(0, 5).toString("latin1");
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
  if (head !== "%PDF-") {
    return item("pdf-header", "PDF 格式", "fail", "文件头不是有效 PDF。", filePath);
  }
  if (!tail.includes("%%EOF")) {
    return item("pdf-eof", "PDF 完整性", "warn", "没有检测到 PDF 结束标记，建议打开确认。", filePath);
  }
  return item("pdf-open", "PDF 可打开性", "pass", "PDF 基础格式检查通过。", filePath);
}

function scoreItems(items: QualityCheckItem[]) {
  let score = 100;
  for (const check of items) {
    if (check.status === "fail") score -= 22;
    if (check.status === "warn") score -= 8;
  }
  return Math.max(0, Math.min(100, score));
}

function overallStatus(items: QualityCheckItem[]): QualityStatus {
  if (items.some((check) => check.status === "fail")) return "fail";
  if (items.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

export function assessCourseQuality(course: Course): GenerationQuality {
  const checks: QualityCheckItem[] = [];
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
      checks.push(item(`required-${required.name}`, required.name, "fail", "缺少核心产物文件。"));
      continue;
    }
    if (file.size < required.minSize) {
      checks.push(item(`size-${required.name}`, required.name, "warn", "文件过小，可能不是有效产物。", file.path));
    } else {
      checks.push(item(`exists-${required.name}`, required.name, "pass", "文件存在且大小正常。", file.path));
    }
  }

  for (const file of generatedFiles.filter((entry) => entry.kind === "markdown")) {
    checks.push(...checkMarkdownFile(file.path));
  }

  const pdf = byName.get("课堂课件.pdf");
  if (pdf) checks.push(checkPdf(pdf.path));

  checks.push(...checkWorkFiles(generatedFiles));
  checks.push(...checkAnswerVerification(generatedFiles));
  checks.push(...checkQuestionVolume(course, generatedFiles));
  checks.push(...checkTeacherScriptDepth(generatedFiles));
  checks.push(...checkExamSourcePolicy(generatedFiles));

  const score = scoreItems(checks);
  return {
    score,
    status: overallStatus(checks),
    checkedAt: nowIso(),
    items: checks
  };
}
