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

const rawLatexCommandPattern =
  /\\(?:frac|dfrac|tfrac|sqrt|times|sum|prod|int|lim|begin|end|cdot|leq|geq|neq|vec|overrightarrow|perp|parallel|angle|sim|mu|sigma|alpha|beta|gamma|theta|Delta)\b/;

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
      checks.push(item(`size-${required.name}`, required.name, "warn", "文件过小，可能内容不足。", file.path));
    } else {
      checks.push(item(`exists-${required.name}`, required.name, "pass", "文件存在且大小正常。", file.path));
    }
  }

  for (const file of generatedFiles.filter((entry) => entry.kind === "markdown")) {
    checks.push(...checkMarkdownFile(file.path));
  }

  const pdf = byName.get("课堂课件.pdf");
  if (pdf) checks.push(checkPdf(pdf.path));

  const score = scoreItems(checks);
  return {
    score,
    status: overallStatus(checks),
    checkedAt: nowIso(),
    items: checks
  };
}
