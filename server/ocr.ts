import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { config } from "./config.js";
import { nowIso } from "./store.js";

export interface OcrFileResult {
  status: "ok" | "skipped" | "failed";
  filePath: string;
  outputDir: string;
  combinedMarkdownPath?: string;
  manifestPath?: string;
  pageCount?: number;
  textChars?: number;
  message: string;
}

interface PaddleOcrManifest {
  filePath: string;
  fileSize?: number;
  contentHash?: string;
  model: string;
  jobId?: string;
  status: "ok";
  createdAt: string;
  pageCount: number;
  textChars: number;
  markdownFiles: string[];
  combinedMarkdownPath: string;
}

const OCR_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);

export function isPaddleOcrConfigured() {
  return config.prepOcrEnabled && Boolean(config.paddleOcrApiToken);
}

export function isOcrCandidate(filePath: string) {
  return OCR_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function safeSegment(value: string, fallback = "document") {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function legacyFileHash(filePath: string) {
  const stat = fs.statSync(filePath);
  return createHash("sha1")
    .update(path.resolve(filePath))
    .update(String(stat.size))
    .update(String(Math.floor(stat.mtimeMs)))
    .digest("hex")
    .slice(0, 12);
}

const contentHashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>();

export function fileContentHash(filePath: string) {
  if (/^https?:\/\//i.test(filePath)) {
    return createHash("sha256").update(filePath).digest("hex");
  }
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  const cached = contentHashCache.get(resolved);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.hash;

  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(resolved, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  const value = hash.digest("hex");
  contentHashCache.set(resolved, { size: stat.size, mtimeMs: stat.mtimeMs, hash: value });
  return value;
}

export function defaultOcrOutputDir(rootDir: string, filePath: string) {
  const base = safeSegment(path.basename(filePath, path.extname(filePath)));
  return path.join(rootDir, `${base}-${fileContentHash(filePath).slice(0, 12)}`);
}

export function ocrCacheRootForFile(filePath: string) {
  if (!/^https?:\/\//i.test(filePath)) {
    const resolved = path.resolve(filePath);
    const relative = path.relative(path.resolve(config.workspaceRoot), resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      const [studentDir] = relative.split(path.sep).filter(Boolean);
      if (studentDir && !["lesson-prep-web", "资料库"].includes(studentDir)) {
        return path.join(config.workspaceRoot, studentDir, "_ocr_cache");
      }
    }
  }
  return path.join(config.dataDir, "ocr-cache");
}

export function sharedOcrOutputDir(filePath: string) {
  return defaultOcrOutputDir(ocrCacheRootForFile(filePath), filePath);
}

function legacyUploadOcrOutputDir(filePath: string) {
  if (/^https?:\/\//i.test(filePath)) return "";
  const base = safeSegment(path.basename(filePath, path.extname(filePath)));
  return path.join(path.dirname(filePath), "_ocr", `${base}-${legacyFileHash(filePath)}`);
}

function manifestMatchesFile(manifest: PaddleOcrManifest, filePath: string, expectedHash: string, expectedSize: number) {
  if (manifest.contentHash) return manifest.contentHash === expectedHash;
  if (manifest.fileSize !== undefined && manifest.fileSize !== expectedSize) return false;
  if (!manifest.filePath || !fs.existsSync(manifest.filePath)) return false;
  try {
    const sourceStat = fs.statSync(manifest.filePath);
    return sourceStat.size === expectedSize && fileContentHash(manifest.filePath) === expectedHash;
  } catch {
    return false;
  }
}

function historicalContentCacheDirs(filePath: string, requestedOutputDir: string) {
  if (/^https?:\/\//i.test(filePath)) return [];
  const expectedSize = fs.statSync(filePath).size;
  const expectedHash = fileContentHash(filePath);
  const roots = [...new Set([path.dirname(requestedOutputDir), ocrCacheRootForFile(filePath), path.join(path.dirname(filePath), "_ocr")])];
  const matches: Array<{ outputDir: string; createdAt: number }> = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const outputDir = path.join(root, entry.name);
      const manifestPath = path.join(outputDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PaddleOcrManifest;
        if (manifest.status !== "ok" || !manifestMatchesFile(manifest, filePath, expectedHash, expectedSize)) continue;
        matches.push({ outputDir, createdAt: Date.parse(manifest.createdAt || "") || fs.statSync(manifestPath).mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return matches.sort((a, b) => b.createdAt - a.createdAt).map((entry) => entry.outputDir);
}

function candidateCacheDirs(filePath: string, requestedOutputDir: string) {
  return [
    ...new Set([
      requestedOutputDir,
      sharedOcrOutputDir(filePath),
      legacyUploadOcrOutputDir(filePath),
      ...historicalContentCacheDirs(filePath, requestedOutputDir)
    ].filter(Boolean))
  ];
}

function readCachedResult(filePath: string, outputDir: string): OcrFileResult | null {
  const manifestPath = path.join(outputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PaddleOcrManifest;
    if (manifest.status !== "ok") return null;
    const combinedMarkdownPath = manifest.combinedMarkdownPath;
    if (!combinedMarkdownPath || !fs.existsSync(combinedMarkdownPath)) return null;
    return {
      status: "ok",
      filePath,
      outputDir,
      combinedMarkdownPath,
      manifestPath,
      pageCount: manifest.pageCount,
      textChars: manifest.textChars,
      message: `PaddleOCR cache hit: ${manifest.pageCount} pages, ${manifest.textChars} chars.`
    };
  } catch {
    return null;
  }
}

export function findCachedOcrResult(filePath: string, requestedOutputDir: string) {
  for (const cacheDir of candidateCacheDirs(filePath, requestedOutputDir)) {
    const cached = readCachedResult(filePath, cacheDir);
    if (cached) return cached;
  }
  return null;
}

async function fetchTextOrThrow(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  return text;
}

async function fetchJsonOrThrow(response: Response) {
  const text = await fetchTextOrThrow(response);
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function errorDetail(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) return error.message;
  if (cause instanceof Error) return `${error.message}: ${cause.message}`;
  return `${error.message}: ${String(cause)}`;
}

function requestJson(
  urlValue: string,
  options: http.RequestOptions,
  writeBody: (request: http.ClientRequest) => void,
  timeoutMs: number
) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const url = new URL(urlValue);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { ...options, method: options.method || "POST" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode}: ${text.slice(0, 1000)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as Record<string, any>);
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${errorDetail(error)}`));
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    try {
      writeBody(request);
    } catch (error) {
      request.destroy();
      reject(error);
    }
  });
}

function multipartField(boundary: string, name: string, value: string) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8"
  );
}

async function submitPaddleOcrJob(filePath: string, log?: (message: string) => void) {
  const headers = { Authorization: `bearer ${config.paddleOcrApiToken}` };
  const optionalPayload = {
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false
  };

  if (/^https?:\/\//i.test(filePath)) {
    const body = JSON.stringify({
        fileUrl: filePath,
        model: config.paddleOcrModel,
        optionalPayload
      });
    return requestJson(
      config.paddleOcrApiUrl,
      {
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (request) => request.end(body),
      config.paddleOcrTimeoutMs
    );
  }

  const boundary = `----lesson-prep-ocr-${createHash("sha1").update(`${filePath}-${Date.now()}`).digest("hex")}`;
  const modelPart = multipartField(boundary, "model", config.paddleOcrModel);
  const optionsPart = multipartField(boundary, "optionalPayload", JSON.stringify(optionalPayload));
  const encodedName = encodeURIComponent(path.basename(filePath));
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload${path.extname(filePath)}"; filename*=UTF-8''${encodedName}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const stat = await fs.promises.stat(filePath);
  const contentLength = modelPart.length + optionsPart.length + fileHeader.length + stat.size + closing.length;
  const startedAt = Date.now();
  let streamedBytes = 0;
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (streamedBytes < stat.size) {
      log?.(
        `[ocr] uploading: ${(streamedBytes / 1024 / 1024).toFixed(1)}/${(stat.size / 1024 / 1024).toFixed(1)} MB, ${elapsedSeconds}s`
      );
    } else {
      log?.(`[ocr] upload complete, waiting for PaddleOCR job id: ${elapsedSeconds}s`);
    }
  }, 30_000);

  try {
    return await requestJson(
      config.paddleOcrApiUrl,
      {
        headers: {
          ...headers,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": contentLength
        }
      },
      (request) => {
        request.write(modelPart);
        request.write(optionsPart);
        request.write(fileHeader);
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => {
          streamedBytes += chunk.length;
        });
        stream.on("error", (error) => request.destroy(error));
        stream.on("end", () => log?.(`[ocr] upload sent, waiting for PaddleOCR job id`));
        stream.pipe(request, { end: false });
        stream.on("end", () => request.end(closing));
      },
      config.paddleOcrTimeoutMs
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function pollPaddleOcrJob(jobId: string, log?: (message: string) => void) {
  const deadline = Date.now() + config.paddleOcrTimeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${config.paddleOcrApiUrl}/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `bearer ${config.paddleOcrApiToken}` }
    });
    const payload = await fetchJsonOrThrow(response);
    const data = payload.data || {};
    const state = data.state;
    if (state === "done") return data;
    if (state === "failed") throw new Error(data.errorMsg || "PaddleOCR job failed.");

    const progress = data.extractProgress;
    if (progress?.totalPages) {
      log?.(`[ocr] job ${jobId} ${state}: ${progress.extractedPages || 0}/${progress.totalPages}`);
    } else {
      log?.(`[ocr] job ${jobId} ${state || "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.paddleOcrPollIntervalMs));
  }
  throw new Error(`PaddleOCR job timed out after ${config.paddleOcrTimeoutMs}ms.`);
}

async function downloadToFile(url: string, filePath: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, bytes);
}

async function downloadOcrResultJsonl(jsonUrl: string, outputDir: string) {
  const response = await fetch(jsonUrl);
  const jsonl = await fetchTextOrThrow(response);
  const jsonlPath = path.join(outputDir, "result.jsonl");
  await fs.promises.writeFile(jsonlPath, jsonl, "utf8");
  return { jsonl, jsonlPath };
}

async function materializeOcrJsonl(filePath: string, outputDir: string, jobId: string, jsonUrl: string) {
  const { jsonl } = await downloadOcrResultJsonl(jsonUrl, outputDir);
  const markdownFiles: string[] = [];
  const combinedParts: string[] = [];
  let pageNum = 0;

  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = JSON.parse(line);
    const result = parsed.result || {};
    const layoutResults = Array.isArray(result.layoutParsingResults) ? result.layoutParsingResults : [];
    for (const layout of layoutResults) {
      const pageLabel = String(pageNum + 1).padStart(3, "0");
      const markdownText = layout.markdown?.text || "";
      const mdPath = path.join(outputDir, `doc_${pageLabel}.md`);
      await fs.promises.writeFile(mdPath, markdownText, "utf8");
      markdownFiles.push(mdPath);
      combinedParts.push(`\n\n<!-- page:${pageNum + 1} file:${path.basename(filePath)} -->\n\n${markdownText}`.trim());

      const markdownImages = layout.markdown?.images || {};
      for (const [imgPath, imgUrl] of Object.entries(markdownImages)) {
        if (typeof imgUrl !== "string") continue;
        await downloadToFile(imgUrl, path.join(outputDir, imgPath));
      }

      const outputImages = layout.outputImages || {};
      for (const [imgName, imgUrl] of Object.entries(outputImages)) {
        if (typeof imgUrl !== "string") continue;
        await downloadToFile(imgUrl, path.join(outputDir, `${imgName}_${pageLabel}.jpg`));
      }
      pageNum += 1;
    }
  }

  const combinedText = combinedParts.join("\n\n---\n\n").trim();
  const combinedMarkdownPath = path.join(outputDir, "combined.md");
  await fs.promises.writeFile(combinedMarkdownPath, combinedText, "utf8");

  const manifest: PaddleOcrManifest = {
    filePath,
    fileSize: /^https?:\/\//i.test(filePath) ? undefined : fs.statSync(filePath).size,
    contentHash: fileContentHash(filePath),
    model: config.paddleOcrModel,
    jobId,
    status: "ok",
    createdAt: nowIso(),
    pageCount: pageNum,
    textChars: combinedText.length,
    markdownFiles,
    combinedMarkdownPath
  };
  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await fs.promises.rm(path.join(outputDir, "error.txt"), { force: true });

  return {
    status: "ok" as const,
    filePath,
    outputDir,
    combinedMarkdownPath,
    manifestPath,
    pageCount: pageNum,
    textChars: combinedText.length,
    message: `OCR completed: ${pageNum} pages, ${combinedText.length} chars.`
  };
}

export async function runPaddleOcrForFile(
  filePath: string,
  outputDir: string,
  log?: (message: string) => void
): Promise<OcrFileResult> {
  if (!config.prepOcrEnabled) {
    return { status: "skipped", filePath, outputDir, message: "OCR disabled by PREP_OCR_ENABLED=false." };
  }
  if (!config.paddleOcrApiToken) {
    return { status: "skipped", filePath, outputDir, message: "PADDLE_OCR_API_TOKEN is not configured." };
  }
  if (!isOcrCandidate(filePath)) {
    return { status: "skipped", filePath, outputDir, message: "File type is not an OCR candidate." };
  }
  if (!/^https?:\/\//i.test(filePath) && !fs.existsSync(filePath)) {
    return { status: "failed", filePath, outputDir, message: "File was not found." };
  }

  const cached = findCachedOcrResult(filePath, outputDir);
  if (cached) return cached;

  outputDir = sharedOcrOutputDir(filePath);

  await fs.promises.mkdir(outputDir, { recursive: true });
  try {
    log?.(`[ocr] submitting ${filePath}`);
    const submitted = await submitPaddleOcrJob(filePath, log);
    const jobId = submitted.data?.jobId;
    if (!jobId) throw new Error("PaddleOCR response did not include data.jobId.");
    log?.(`[ocr] submitted job ${jobId}`);
    const done = await pollPaddleOcrJob(jobId, log);
    const jsonUrl = done.resultUrl?.jsonUrl;
    if (!jsonUrl) throw new Error("PaddleOCR result did not include resultUrl.jsonUrl.");
    return await materializeOcrJsonl(filePath, outputDir, jobId, jsonUrl);
  } catch (error) {
    const message = errorDetail(error);
    await fs.promises.writeFile(
      path.join(outputDir, "error.txt"),
      `[${nowIso()}] ${message}\n`,
      "utf8"
    ).catch(() => undefined);
    return { status: "failed", filePath, outputDir, message };
  }
}

export function readOcrMarkdown(result: OcrFileResult, maxChars: number) {
  if (result.status !== "ok" || !result.combinedMarkdownPath || !fs.existsSync(result.combinedMarkdownPath)) return "";
  const text = fs.readFileSync(result.combinedMarkdownPath, "utf8").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[OCR 内容过长，已截断 ${text.length - maxChars} 个字符；完整 OCR 见：${result.combinedMarkdownPath}]`;
}

export function formatOcrResultForPrompt(result: OcrFileResult, maxChars = 12000) {
  const lines = [
    `文件：${result.filePath}`,
    `状态：${result.status}`,
    `输出目录：${result.outputDir}`,
    result.combinedMarkdownPath ? `OCR Markdown：${result.combinedMarkdownPath}` : "",
    result.pageCount !== undefined ? `页数：${result.pageCount}` : "",
    result.textChars !== undefined ? `字符数：${result.textChars}` : "",
    `说明：${result.message}`
  ].filter(Boolean);
  const excerpt = readOcrMarkdown(result, maxChars);
  return excerpt ? `${lines.join("\n")}\n\nOCR 摘录：\n${excerpt}` : lines.join("\n");
}

export async function preprocessFilesWithOcr(
  filePaths: string[],
  ocrRoot: string,
  log?: (message: string) => void
) {
  const uniquePaths = [...new Set(filePaths.map((item) => item.trim()).filter(Boolean))].filter(isOcrCandidate);
  const limited = uniquePaths.slice(0, Math.max(0, config.paddleOcrMaxFiles));
  const results: OcrFileResult[] = [];
  for (const filePath of limited) {
    const outputDir = defaultOcrOutputDir(ocrRoot, filePath);
    results.push(await runPaddleOcrForFile(filePath, outputDir, log));
  }
  return results;
}
