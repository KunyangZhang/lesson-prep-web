import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { CourseFile } from "./types.js";

export function assertWithinWorkspace(filePath: string) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(config.workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside the prep workspace.");
  }
  return resolved;
}

export function fileKind(filePath: string): CourseFile["kind"] {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if ([".txt", ".log", ".tex"].includes(ext)) return "text";
  return "other";
}

export function listCourseFiles(outputDir: string) {
  const root = assertWithinWorkspace(outputDir);
  if (!fs.existsSync(root)) return [];

  const results: CourseFile[] = [];
  const allowed = new Set([".md", ".markdown", ".pdf", ".txt", ".log", ".tex", ".docx", ".png", ".jpg", ".jpeg"]);

  function walk(dir: string) {
    const relativeDir = path.relative(root, dir).replace(/\\/g, "/");
    if (relativeDir === "_ocr_cache" || relativeDir.startsWith("_ocr_cache/")) return;
    if (relativeDir === "_work/ocr" || relativeDir.startsWith("_work/ocr/")) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "_ocr_cache") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const relativeChild = path.relative(root, fullPath).replace(/\\/g, "/");
        if (relativeChild === "_work/ocr" || relativeChild.startsWith("_work/ocr/")) continue;
        walk(fullPath);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!allowed.has(ext)) continue;
      const stat = fs.statSync(fullPath);
      results.push({
        name: entry.name,
        path: fullPath,
        relativePath: path.relative(root, fullPath),
        kind: fileKind(fullPath),
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }

  walk(root);
  return results.sort((a, b) => {
    const rank = (file: CourseFile) => {
      if (file.name === "老师逐字稿.md") return 1;
      if (file.name === "知识点详解.md") return 2;
      if (file.name === "课后反馈.md") return 3;
      if (file.kind === "pdf" && file.name.includes("授课一体版")) return 4;
      if (file.kind === "pdf" && file.name.includes("课后作业") && !file.name.includes("答案")) return 6;
      if (file.kind === "pdf" && file.name.includes("课后作业") && file.name.includes("答案")) return 7;
      if (file.kind === "pdf") return 5;
      return 10;
    };
    return rank(a) - rank(b) || a.relativePath.localeCompare(b.relativePath, "zh-CN");
  });
}

export function uniqueDestination(dir: string, originalName: string) {
  const parsed = path.parse(originalName);
  let candidate = path.join(dir, originalName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}
