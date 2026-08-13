import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultOcrOutputDir, fileContentHash, findCachedOcrResult } from "./ocr.js";

test("identical PDFs in different upload folders use the same content cache key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-prep-ocr-key-"));
  try {
    const firstDir = path.join(root, "20260731-0100");
    const secondDir = path.join(root, "20260731-0200");
    const cacheRoot = path.join(root, "_ocr_cache");
    fs.mkdirSync(firstDir, { recursive: true });
    fs.mkdirSync(secondDir, { recursive: true });
    const first = path.join(firstDir, "同一讲义.pdf");
    const second = path.join(secondDir, "同一讲义.pdf");
    fs.writeFileSync(first, "%PDF-1.4\nidentical-test-content\n", "utf8");
    fs.copyFileSync(first, second);

    assert.equal(fileContentHash(first), fileContentHash(second));
    assert.equal(defaultOcrOutputDir(cacheRoot, first), defaultOcrOutputDir(cacheRoot, second));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new upload can reuse a legacy OCR manifest for identical PDF bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-prep-ocr-legacy-"));
  try {
    const oldUploadDir = path.join(root, "20260730-0100");
    const newUploadDir = path.join(root, "20260731-0100");
    const cacheRoot = path.join(root, "_ocr_cache");
    const legacyCacheDir = path.join(cacheRoot, "讲义-old-path-key");
    fs.mkdirSync(oldUploadDir, { recursive: true });
    fs.mkdirSync(newUploadDir, { recursive: true });
    fs.mkdirSync(legacyCacheDir, { recursive: true });
    const oldPdf = path.join(oldUploadDir, "讲义.pdf");
    const newPdf = path.join(newUploadDir, "讲义.pdf");
    fs.writeFileSync(oldPdf, "%PDF-1.4\nlegacy-cache-content\n", "utf8");
    fs.copyFileSync(oldPdf, newPdf);
    const combinedMarkdownPath = path.join(legacyCacheDir, "combined.md");
    fs.writeFileSync(combinedMarkdownPath, "# 历史 OCR 内容", "utf8");
    fs.writeFileSync(
      path.join(legacyCacheDir, "manifest.json"),
      JSON.stringify({
        filePath: oldPdf,
        model: "legacy-model",
        status: "ok",
        createdAt: "2026-07-30T01:00:00.000Z",
        pageCount: 12,
        textChars: 10,
        markdownFiles: [],
        combinedMarkdownPath
      }),
      "utf8"
    );

    const result = findCachedOcrResult(newPdf, path.join(cacheRoot, "讲义-new-content-key"));
    assert.equal(result?.status, "ok");
    assert.equal(result?.outputDir, legacyCacheDir);
    assert.equal(result?.combinedMarkdownPath, combinedMarkdownPath);
    assert.match(result?.message || "", /cache hit/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
