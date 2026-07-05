import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import pdfParse from "pdf-parse";
import JSZip from "jszip";
import { config, materialRoot, uploadRoot } from "./config.js";
import { assertWithinWorkspace } from "./files.js";
import type { Course, Material, RagChunk } from "./types.js";
import type { Store } from "./store.js";
import { decodeUploadName, hashId, nowIso, sanitizeFilename } from "./store.js";

const indexVersion = 3;
const ragIndexPath = path.join(config.dataDir, "rag-index.json");
const ragSqlitePath = path.join(config.dataDir, "rag-index.sqlite");
const supportedExtensions = new Set([".md", ".markdown", ".txt", ".csv", ".doc", ".docx", ".pdf", ".xlsx"]);

type RagMaterialStatus = Material["status"] | "needs_conversion";
type RagSourceKind = "exam" | "mock" | "local" | "adapted" | "self_written" | "unknown";
type RagSnippetKind = "knowledge" | "answer" | "metadata" | "chunk";
type RagAnswerQuality = "none" | "answer_only" | "solution_steps" | "detailed_solution";

interface RagIndexedMaterial {
  id: string;
  title: string;
  path: string;
  size: number;
  mtimeMs: number;
  mimeType?: string;
  status: RagMaterialStatus;
  chunkCount: number;
  questionCount: number;
  snippetCount: number;
  error?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RagQuestionRecord {
  id: string;
  materialId: string;
  path: string;
  title: string;
  index: number;
  label: string;
  questionNumber: string;
  text: string;
  answer: string;
  solution: string;
  context: string;
  sourceKind: RagSourceKind;
  examSource: string;
  questionType: string;
  difficulty: string;
  teachingRoles: string[];
  knowledgeTags: string[];
  tags: string[];
  tokens: string[];
  hasAnswer: boolean;
  formulaCount: number;
  imageCount: number;
  qualityWarnings: string[];
  fingerprint: string;
  duplicateClusterId: string;
  isClusterRepresentative: boolean;
  answerQuality: RagAnswerQuality;
}

interface RagSnippetRecord {
  id: string;
  materialId: string;
  path: string;
  title: string;
  index: number;
  kind: RagSnippetKind;
  text: string;
  context: string;
  tags: string[];
  tokens: string[];
  formulaCount: number;
  imageCount: number;
}

interface RagIndexDb {
  version: number;
  updatedAt: string;
  materials: RagIndexedMaterial[];
  questions: RagQuestionRecord[];
  snippets: RagSnippetRecord[];
}

interface RagEmbeddingRecord {
  id: string;
  materialId: string;
  vector: number[];
  model: string;
  dimensions: number;
  updatedAt: string;
}

interface SqliteRagRow {
  id: string;
  payload: string;
}

export interface RagScoreParts {
  lexical: number;
  coverage: number;
  title: number;
  path: number;
  tags: number;
  role: number;
  phrase: number;
  answer: number;
  vector: number;
  boost: number;
}

export interface RagSearchResult {
  score: number;
  scoreParts: RagScoreParts;
  matchedTags: string[];
  reason: string;
  material: RagIndexedMaterial;
  question?: RagQuestionRecord;
  snippet?: RagSnippetRecord;
  chunks: Array<{
    chunk: RagChunk & { tags?: string[]; summary?: string; context?: string };
    excerpt: string;
    score: number;
  }>;
  chunk: RagChunk & { tags?: string[]; summary?: string; context?: string };
  excerpt: string;
}

export interface RagPlan {
  query: string;
  intentTags: string[];
  selected: RagSearchResult[];
  rejected: Array<{
    title: string;
    path: string;
    score: number;
    reason: string;
  }>;
  candidatePool: {
    direct: RagSearchResult[];
    variants: RagSearchResult[];
    homework: RagSearchResult[];
    reference: RagSearchResult[];
  };
}

const topicTags = [
  "集合",
  "函数",
  "抽象函数",
  "二次函数",
  "幂函数",
  "对数函数",
  "导数",
  "极值",
  "单调性",
  "不等式",
  "基本不等式",
  "三角函数",
  "解三角形",
  "平面向量",
  "空间向量",
  "立体几何",
  "数列",
  "圆",
  "直线",
  "解析几何",
  "圆锥曲线",
  "椭圆",
  "双曲线",
  "抛物线",
  "概率",
  "统计",
  "计数原理",
  "二项式定理",
  "复数"
];

const questionTags = [
  "选择题",
  "填空题",
  "解答题",
  "压轴",
  "新定义",
  "恒成立",
  "存在性",
  "最值",
  "范围",
  "轨迹",
  "证明",
  "应用题",
  "动点",
  "参数",
  "模型",
  "题型"
];

const roleTags = ["讲义", "原卷版", "解析版", "专题", "重难点突破", "拔高点突破", "真题", "模拟", "一模", "二模"];
const stageTags = ["初中", "高中", "中考", "高考", "初一", "初二", "初三", "高一", "高二", "高三", "七年级", "八年级", "九年级"];
const allKnownTags = [...stageTags, ...topicTags, ...questionTags, ...roleTags];

let cachedIndex: RagIndexDb | null = null;
let cachedSearchCache: SearchCache | null = null;
let sqliteDb: DatabaseSync | null = null;
let queryEmbeddingDisabledUntil = 0;
const queryEmbeddingCache = new Map<string, { vector: number[]; updatedAt: number }>();

function emptyIndex(): RagIndexDb {
  return {
    version: indexVersion,
    updatedAt: nowIso(),
    materials: [],
    questions: [],
    snippets: []
  };
}

function normalizeText(input: string) {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function jsonStringify(value: unknown) {
  return JSON.stringify(value);
}

function jsonParse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isEmbeddingEnabled() {
  return config.ragEmbeddingProvider.toLowerCase() === "ark" && Boolean(config.ragEmbeddingApiKey);
}

function parseBoostPatterns() {
  return config.ragBoostPatterns
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pattern, score] = entry.split(":");
      const boost = Number(score);
      return {
        pattern: normalizeText(pattern || ""),
        boost: Number.isFinite(boost) ? boost : 0
      };
    })
    .filter((entry) => entry.pattern && entry.boost !== 0);
}

function materialBoost(material: RagIndexedMaterial) {
  const text = normalizeText(`${material.title} ${material.path}`);
  return parseBoostPatterns().reduce((sum, entry) => (text.includes(entry.pattern) ? sum + entry.boost : sum), 0);
}

function vectorToBuffer(vector: number[]) {
  return Buffer.from(new Float32Array(vector).buffer);
}

function bufferToVector(value: Buffer | Uint8Array) {
  const buffer = Buffer.from(value);
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return [...new Float32Array(copy)];
}

function bufferToFloat32Array(value: Buffer | Uint8Array) {
  const buffer = Buffer.from(value);
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return new Float32Array(copy);
}

function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function trimEmbeddingText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 6000);
}

function extractArkEmbeddingsPayload(data: unknown) {
  const payload = data as {
    data?: Array<{ embedding?: number[] }> | { embedding?: number[] };
    embeddings?: number[][];
    embedding?: number[];
  };
  const embeddings = Array.isArray(payload.data)
    ? payload.data.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item))
    : payload.data && !Array.isArray(payload.data) && Array.isArray(payload.data.embedding)
    ? [payload.data.embedding]
    : Array.isArray(payload.embeddings)
    ? payload.embeddings
    : Array.isArray(payload.embedding)
    ? [payload.embedding]
    : [];
  return embeddings.filter((embedding) => embedding.every((value) => typeof value === "number" && Number.isFinite(value)));
}

async function embedTexts(texts: string[]) {
  if (!isEmbeddingEnabled()) return [];
  const input = texts.map((text) => ({ type: "text", text: trimEmbeddingText(text) })).filter((item) => item.text);
  if (input.length === 0) return [];
  const response = await fetch(config.ragEmbeddingEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.ragEmbeddingApiKey}`
    },
    body: JSON.stringify({
      model: config.ragEmbeddingModel,
      input
    })
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Ark embedding failed: ${response.status} ${responseText.slice(0, 500)}`);
  }
  const payload = responseText ? JSON.parse(responseText) : {};
  const embeddings = extractArkEmbeddingsPayload(payload);
  if (embeddings.length !== input.length) {
    throw new Error(`Ark embedding returned ${embeddings.length} vectors for ${input.length} inputs.`);
  }
  return embeddings;
}

async function embedQueryText(query: string) {
  if (!isEmbeddingEnabled()) return undefined;
  if (Date.now() < queryEmbeddingDisabledUntil) return undefined;
  const key = `${config.ragEmbeddingModel}:${trimEmbeddingText(query)}`;
  const cached = queryEmbeddingCache.get(key);
  if (cached && Date.now() - cached.updatedAt < 24 * 60 * 60 * 1000) return cached.vector;
  try {
    const vector = (await embedTexts([query]))[0];
    if (!vector) return undefined;
    queryEmbeddingCache.set(key, { vector, updatedAt: Date.now() });
    if (queryEmbeddingCache.size > 200) {
      const oldestKey = [...queryEmbeddingCache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
      if (oldestKey) queryEmbeddingCache.delete(oldestKey);
    }
    return vector;
  } catch {
    queryEmbeddingDisabledUntil = Date.now() + 10 * 60 * 1000;
    return undefined;
  }
}

export function tokenize(input: string) {
  const lower = input.toLowerCase();
  const tokens = new Set<string>();

  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    if (match[0].length > 1) tokens.add(match[0]);
  }

  for (const match of lower.matchAll(/[\u3400-\u9fff]+/g)) {
    const text = match[0];
    if (text.length === 1) {
      tokens.add(text);
      continue;
    }
    for (let i = 0; i < text.length - 1; i += 1) tokens.add(text.slice(i, i + 2));
    if (text.length >= 4) {
      for (let i = 0; i < text.length - 3; i += 1) tokens.add(text.slice(i, i + 4));
    }
  }

  return [...tokens];
}

function extractTags(...values: string[]) {
  const haystack = values.filter(Boolean).join(" ");
  const tags = new Set<string>();
  for (const tag of allKnownTags) {
    if (haystack.includes(tag)) tags.add(tag);
  }
  if (/初中|中考|初一|初二|初三|七年级|八年级|九年级/.test(haystack)) tags.add("初中");
  if (/高中|高考|高一|高二|高三/.test(haystack)) tags.add("高中");
  if (/解析|答案|详解/.test(haystack)) tags.add("解析版");
  if (/原卷|试题|无答案/.test(haystack)) tags.add("原卷版");
  if (/讲义|知识点|方法|题型全解/.test(haystack)) tags.add("讲义");
  if (/真题|高考|中考/.test(haystack)) tags.add("真题");
  if (/模拟|一模|二模/.test(haystack)) tags.add("模拟");
  return [...tags];
}

function detectSourceKind(...values: string[]): RagSourceKind {
  const text = values.join(" ");
  if (/自编|原创/.test(text)) return "self_written";
  if (/改编|变式/.test(text)) return "adapted";
  if (/一模|二模|三模|模拟|联考|质检/.test(text)) return "mock";
  if (/真题|高考|中考|全国卷|新高考/.test(text)) return "exam";
  if (/本地|讲义|课件|作业|错题|资料库/.test(text)) return "local";
  return "unknown";
}

function detectDifficulty(text: string) {
  if (/压轴|拔高|高难|难题|综合性强|挑战/.test(text)) return "高";
  if (/基础|入门|巩固|概念/.test(text)) return "基础";
  if (/中档|中等|典型|常规/.test(text)) return "中";
  return "未标注";
}

function detectQuestionType(text: string) {
  if (/选择题|单选|多选/.test(text)) return "选择题";
  if (/填空题|填空/.test(text)) return "填空题";
  if (/解答题|证明题|计算题|问答题/.test(text)) return "解答题";
  const matched = questionTags.find((tag) => text.includes(tag));
  return matched || "未分类";
}

function detectTeachingRoles(label: string, text: string) {
  const joined = `${label} ${text}`;
  const roles = new Set<string>();
  if (/诊断|陷阱|错题|易错/.test(joined)) roles.add("诊断");
  if (/例|模型|模板|方法/.test(joined)) roles.add("例题");
  if (/变式|迁移|同类/.test(joined)) roles.add("变式");
  if (/巩固|练习|训练/.test(joined)) roles.add("巩固");
  if (/作业|课后/.test(joined)) roles.add("作业");
  if (roles.size === 0) roles.add(label.includes("例") ? "例题" : "候选");
  return [...roles];
}

function detectExamSource(...values: string[]) {
  const text = values.join(" ");
  const year = text.match(/(?:19|20)\d{2}\s*年/)?.[0] || "";
  const region =
    text.match(/全国[ⅠI一二三A-Z]*卷|新高考[ⅠI一二三A-Z]*卷|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆/)?.[0] || "";
  const number = text.match(/第\s*[一二三四五六七八九十百\d]+\s*题/)?.[0] || "";
  return [year, region, number].filter(Boolean).join(" ");
}

function chunkText(text: string) {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  const chunkSize = 1800;
  const overlap = 160;

  for (let start = 0; start < normalized.length && chunks.length < 800; start += chunkSize - overlap) {
    chunks.push(normalized.slice(start, start + chunkSize));
  }

  return chunks.filter((chunk) => chunk.trim().length > 8);
}

function formulaPlaceholderMetrics(text: string) {
  const compact = text.replace(/\s/g, "");
  const nonWhitespaceLength = compact.length;
  const formulaCount = countMatches(text, /\[公式\]/g);
  const imageCount = countMatches(text, /\[图片\]/g);
  const chineseCount = countMatches(text, /[\u4e00-\u9fff]/g);
  const formulaCharRatio = (formulaCount * "[公式]".length) / Math.max(1, nonWhitespaceLength);
  const chineseRatio = chineseCount / Math.max(1, nonWhitespaceLength);
  return {
    nonWhitespaceLength,
    formulaCount,
    imageCount,
    chineseCount,
    formulaCharRatio,
    chineseRatio
  };
}

function isFormulaPlaceholderHeavy(text: string) {
  const metrics = formulaPlaceholderMetrics(text);
  if (metrics.formulaCount < 8) return false;
  if (metrics.chineseCount < 30) return true;
  if (metrics.formulaCharRatio >= 0.35) return true;
  if (metrics.formulaCount >= 20 && metrics.chineseRatio < 0.25) return true;
  return false;
}

async function extractText(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".markdown", ".txt", ".csv"].includes(ext)) {
    return { text: await fs.promises.readFile(filePath, "utf8"), formulaCount: 0, imageCount: 0 };
  }

  if (ext === ".docx") {
    return extractDocxText(filePath);
  }

  if (ext === ".doc") {
    return extractLegacyDocText(filePath);
  }

  if (ext === ".pdf") {
    return extractPdfText(filePath);
  }

  if (ext === ".xlsx") {
    return { text: await extractXlsxText(filePath), formulaCount: 0, imageCount: 0 };
  }

  throw new Error(`Unsupported file type: ${ext || "unknown"}`);
}

async function extractPdfText(filePath: string) {
  const result = spawnSync("pdftotext", ["-enc", "UTF-8", "-layout", filePath, "-"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.status === 0 && result.stdout.trim().length > 200) {
    return { text: cleanPdfMathText(result.stdout), formulaCount: 0, imageCount: 0 };
  }

  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  if (parsed.text.trim().length > 0) return { text: parsed.text, formulaCount: 0, imageCount: 0 };

  const detail = result.error?.message || result.stderr?.toString().trim();
  throw new Error(`PDF text extraction failed${detail ? `: ${detail}` : ""}`);
}

function cleanPdfMathText(text: string) {
  return text
    .split(/\r?\n/)
    .map(cleanPdfMathLine)
    .join("\n")
    .replace(/\{\s+\(/g, "{(")
    .replace(/\)\s+\|/g, ")|")
    .replace(/\|\s+/g, "|")
    .replace(/\s+\}/g, "}")
    .replace(/\s+([,，；;])/g, "$1")
    .replace(/([A-Za-z])\s+\*/g, "$1*")
    .replace(/log\s*([0-9]+)/g, "log_$1")
    .replace(/([xyabcmn])([0-9]{1,2})(?=\s|[,，。；;)\]}]|$)/g, "$1^$2")
    .replace(/\s{3,}/g, "  ");
}

function cleanPdfMathLine(line: string) {
  let cleaned = line.replace(/\uf0f4/g, "|").replace(/\uf0cb/g, "");
  cleaned = replaceAlternatingSymbol(cleaned, "\uf0ee", "(", ")");
  cleaned = replaceAlternatingSymbol(cleaned, "\uf0f6", "[", "]");
  cleaned = replaceAlternatingSymbol(cleaned, "\uf0e4", "{", "}", true);
  cleaned = cleaned.replace(/\uf0e0\s*\uf0e1\s*\uf0e2/g, "√").replace(/\uf0e0/g, "√(").replace(/\uf0e1/g, "").replace(/\uf0e2/g, ")");
  return cleaned;
}

function replaceAlternatingSymbol(line: string, symbol: string, open: string, close: string, closeIfAlreadyOpen = false) {
  const indexes = [...line.matchAll(new RegExp(symbol, "g"))].map((match) => match.index ?? -1).filter((index) => index >= 0);
  if (indexes.length === 0) return line;
  let nextOpen = true;
  if (closeIfAlreadyOpen) {
    const first = indexes[0];
    nextOpen = line.lastIndexOf(open, first) <= line.lastIndexOf(close, first);
  }
  return line.replace(new RegExp(symbol, "g"), () => {
    const value = nextOpen ? open : close;
    nextOpen = !nextOpen;
    return value;
  });
}

function findExecutable(candidates: string[]) {
  for (const candidate of candidates) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split(/\r?\n/)[0];
  }
  return "";
}

async function extractLegacyDocText(filePath: string) {
  const converter = findExecutable(["soffice", "libreoffice"]);
  if (!converter) {
    throw new Error("旧版 .doc 暂无法解析：服务器未安装 LibreOffice/soffice 转换工具。");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-prep-doc-"));
  try {
    const result = spawnSync(
      converter,
      [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "docx",
        "--outdir",
        tempDir,
        filePath
      ],
      {
        cwd: config.projectRoot,
        encoding: "utf8",
        timeout: config.docConversionTimeoutMs,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    const convertedPath = path.join(tempDir, `${path.basename(filePath, path.extname(filePath))}.docx`);
    if (result.error || result.status !== 0 || !fs.existsSync(convertedPath)) {
      const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status ?? "unknown"}`;
      throw new Error(`旧版 .doc 转换失败：${String(detail).trim()}`);
    }
    return await extractDocxText(convertedPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function extractDocxText(filePath: string) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) return { text: "", formulaCount: 0, imageCount: 0 };

  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("text");
  const relationships = parseDocxRelationships(relsXml || "");
  const oleTargets = unique(
    [...documentXml.matchAll(/<o:OLEObject\b[^>]*\/?>/g)]
      .map((match) => xmlAttr(match[0], "r:id"))
      .map((relId) => (relId ? relationships.get(relId) : undefined))
      .filter((target): target is string => Boolean(target))
  );
  const formulaByTarget = await convertMathTypeTargets(zip, oleTargets);

  let formulaCount = 0;
  let imageCount = 0;

  function renderFormula(fragment: string) {
    const relId = xmlAttr(fragment, "r:id");
    const target = relId ? relationships.get(relId) : undefined;
    const formula = target ? formulaByTarget.get(target) : "";
    formulaCount += 1;
    return formula && formula !== "[公式]" ? ` ${formula} ` : " [公式] ";
  }

  function renderPict(fragment: string) {
    if (/<o:OLEObject\b/.test(fragment)) {
      const oleMatch = fragment.match(/<o:OLEObject\b[^>]*\/?>/);
      return oleMatch ? renderFormula(oleMatch[0]) : " [公式] ";
    }
    if (/<v:imagedata\b|<a:blip\b/.test(fragment)) {
      imageCount += 1;
      return " [图片] ";
    }
    return "";
  }

  const paragraphs = [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  const lines = paragraphs.map((paragraph) => {
    let line = "";
    const tokenPattern =
      /<w:r\b[\s\S]*?<\/w:r>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<m:t\b[^>]*>([\s\S]*?)<\/m:t>|<m:chr\b[^>]*\/?>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:pict\b[\s\S]*?<\/w:pict>|<w:drawing\b[\s\S]*?<\/w:drawing>|<o:OLEObject\b[^>]*\/?>|<v:imagedata\b[^>]*\/?>|<a:blip\b[^>]*\/?>/g;
    const matches = [...paragraph.matchAll(tokenPattern)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const token = match[0];
      const nextToken = matches[index + 1]?.[0] || "";
      if (token.startsWith("<w:r")) line += renderRun(token, nextToken);
      else if (match[1] !== undefined) line += xmlDecode(match[1]);
      else if (match[2] !== undefined) line += xmlDecode(match[2]);
      else if (token.startsWith("<m:chr")) line += xmlAttr(token, "m:val");
      else if (token.startsWith("<w:tab")) line += " ";
      else if (token.startsWith("<w:br") || token.startsWith("<w:cr")) line += "\n";
      else if (token.startsWith("<w:pict")) line += renderPict(token);
      else if (token.startsWith("<o:OLEObject")) line += renderFormula(token);
      else if (token.startsWith("<w:drawing") || token.startsWith("<v:imagedata") || token.startsWith("<a:blip")) {
        if (isFormulaPreviewImage(token, nextToken)) continue;
        imageCount += 1;
        line += " [图片] ";
      }
    }
    return normalizeExtractedText(line);
  });

  const text = normalizeExtractedText(lines.filter(Boolean).join("\n"));
  return { text, formulaCount, imageCount };

  function renderRun(runXml: string, nextToken: string) {
    let content = "";
    let hasNonText = false;
    const tokenPattern =
      /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<m:t\b[^>]*>([\s\S]*?)<\/m:t>|<m:chr\b[^>]*\/?>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:pict\b[\s\S]*?<\/w:pict>|<w:drawing\b[\s\S]*?<\/w:drawing>|<o:OLEObject\b[^>]*\/?>|<v:imagedata\b[^>]*\/?>|<a:blip\b[^>]*\/?>/g;
    const matches = [...runXml.matchAll(tokenPattern)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const token = match[0];
      const nextInnerToken = matches[index + 1]?.[0] || nextToken;
      if (match[1] !== undefined) content += xmlDecode(match[1]);
      else if (match[2] !== undefined) content += xmlDecode(match[2]);
      else if (token.startsWith("<m:chr")) content += xmlAttr(token, "m:val");
      else if (token.startsWith("<w:tab")) content += " ";
      else if (token.startsWith("<w:br") || token.startsWith("<w:cr")) content += "\n";
      else if (token.startsWith("<w:pict")) {
        hasNonText = true;
        content += renderPict(token);
      } else if (token.startsWith("<o:OLEObject")) {
        hasNonText = true;
        content += renderFormula(token);
      } else if (token.startsWith("<w:drawing") || token.startsWith("<v:imagedata") || token.startsWith("<a:blip")) {
        hasNonText = true;
        if (isFormulaPreviewImage(token, nextInnerToken)) continue;
        imageCount += 1;
        content += " [图片] ";
      }
    }

    if (hasNonText) return content;
    if (/<w:vertAlign\b[^>]*(?:w:val|val)="superscript"/.test(runXml)) return toScriptText(content, "^");
    if (/<w:vertAlign\b[^>]*(?:w:val|val)="subscript"/.test(runXml)) return toScriptText(content, "_");
    return content;
  }
}

function isFormulaPreviewImage(token: string, nextToken: string) {
  return /<o:OLEObject\b/.test(nextToken) && /(?:<w:drawing\b|<v:imagedata\b|<a:blip\b)/.test(token);
}

function toScriptText(value: string, marker: "^" | "_") {
  if (!value.trim()) return value;
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  return `${leading}${marker}(${value.trim()})${trailing}`;
}

function xmlAttr(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\s${escaped}="([^"]*)"`)) || tag.match(new RegExp(`\\s${escaped}='([^']*)'`));
  return match ? xmlDecode(match[1]) : "";
}

function normalizeDocxTarget(target: string) {
  if (!target || /^[a-z]+:/i.test(target)) return "";
  const normalized = target.startsWith("/")
    ? path.posix.normalize(target.replace(/^\/+/, ""))
    : path.posix.normalize(path.posix.join("word", target));
  return normalized.replace(/^\.\//, "");
}

function parseDocxRelationships(xml: string) {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0];
    const id = xmlAttr(tag, "Id");
    const target = normalizeDocxTarget(xmlAttr(tag, "Target"));
    if (id && target) relationships.set(id, target);
  }
  return relationships;
}

async function convertMathTypeTargets(zip: JSZip, targets: string[]) {
  const formulas = new Map<string, string>();
  if (targets.length === 0) return formulas;

  const scriptPath = path.join(config.projectRoot, "scripts", "mathtype_to_text.rb");
  if (!fs.existsSync(scriptPath)) return formulas;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-prep-mathtype-"));
  try {
    const tempFiles: string[] = [];
    const tempTargets: string[] = [];
    for (const target of targets) {
      const file = zip.file(target);
      if (!file) continue;
      const tempFile = path.join(tempDir, `${tempFiles.length}.bin`);
      fs.writeFileSync(tempFile, await file.async("nodebuffer"));
      tempFiles.push(tempFile);
      tempTargets.push(target);
    }
    if (tempFiles.length === 0) return formulas;

    const batchSize = Number(process.env.RAG_MATHTYPE_BATCH_SIZE || 40);
    for (let start = 0; start < tempFiles.length; start += batchSize) {
      convertMathTypeBatch(tempFiles.slice(start, start + batchSize), tempTargets.slice(start, start + batchSize));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return formulas;

  function convertMathTypeBatch(batchFiles: string[], batchTargets: string[]) {
    if (batchFiles.length === 0) return;
    const timeoutMs = Number(process.env.RAG_MATHTYPE_TIMEOUT_MS || 120_000);
    const result = spawnSync("ruby", [scriptPath, ...batchFiles], {
      cwd: config.projectRoot,
      encoding: "utf8",
      env: { ...process.env, RUBYOPT: "-W0" },
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs
    });

    const lines = result.error ? [] : (result.stdout || "").split(/\r?\n/);
    const complete = !result.error && lines.length >= batchTargets.length;
    if (!complete && batchFiles.length > 1) {
      const midpoint = Math.ceil(batchFiles.length / 2);
      convertMathTypeBatch(batchFiles.slice(0, midpoint), batchTargets.slice(0, midpoint));
      convertMathTypeBatch(batchFiles.slice(midpoint), batchTargets.slice(midpoint));
      return;
    }

    batchTargets.forEach((target, index) => {
      const formula = normalizeFormulaText(lines[index] || "");
      formulas.set(target, formula || "[公式]");
    });
  }
}

function normalizeFormulaText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\^\('\)/g, "'")
    .replace(/\^\((\d+)\)/g, "^$1")
    .replace(/_\(([^)]+)\)/g, "_$1")
    .replace(/\s*([=<>+\-*/^(),，。；：、])\s*/g, "$1")
    .trim();
}

function normalizeExtractedText(value: string) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([，。；：、？！,.!?;:）\]\}])/g, "$1")
    .replace(/([（\[\{])\s+/g, "$1")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xmlDecode(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function stripXmlTags(value: string) {
  return xmlDecode(value.replace(/<[^>]+>/g, ""));
}

async function extractXlsxText(filePath: string) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("text");
  const sharedStrings = sharedStringsXml
    ? [...sharedStringsXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) => {
        return [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((textMatch) => xmlDecode(textMatch[1]))
          .join("");
      })
    : [];

  const sheetFiles = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  const output: string[] = [];
  for (const sheetName of sheetFiles) {
    const sheetXml = await zip.file(sheetName)?.async("text");
    if (!sheetXml) continue;
    output.push(`工作表 ${path.basename(sheetName, ".xml")}`);
    const rows = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
    for (const row of rows.slice(0, 2000)) {
      const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
        .map((cell) => {
          const attrs = cell[1];
          const body = cell[2];
          const value = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
          if (/\bt="s"/.test(attrs)) return sharedStrings[Number(value)] || "";
          if (/\bt="inlineStr"/.test(attrs)) return stripXmlTags(body);
          return xmlDecode(value);
        })
        .filter(Boolean);
      if (cells.length > 0) output.push(cells.join("\t"));
    }
  }

  return output.join("\n");
}

function readIndexFromDisk(): RagIndexDb | null {
  if (!fs.existsSync(ragIndexPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(ragIndexPath, "utf8")) as Partial<RagIndexDb>;
    if (parsed.version !== indexVersion) return emptyIndex();
    return {
      version: indexVersion,
      updatedAt: parsed.updatedAt || nowIso(),
      materials: Array.isArray(parsed.materials) ? parsed.materials : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      snippets: Array.isArray(parsed.snippets) ? parsed.snippets : []
    };
  } catch {
    return emptyIndex();
  }
}

function getSqliteDb() {
  if (sqliteDb) return sqliteDb;
  fs.mkdirSync(path.dirname(ragSqlitePath), { recursive: true });
  sqliteDb = new DatabaseSync(ragSqlitePath);
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;
    PRAGMA wal_autocheckpoint = 1000;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtimeMs REAL NOT NULL,
      updatedAt TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      materialId TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      duplicateClusterId TEXT NOT NULL,
      isClusterRepresentative INTEGER NOT NULL DEFAULT 1,
      answerQuality TEXT NOT NULL DEFAULT 'none',
      hasAnswer INTEGER NOT NULL DEFAULT 0,
      sourceKind TEXT NOT NULL,
      scorePriority REAL NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_questions_material ON questions(materialId);
    CREATE INDEX IF NOT EXISTS idx_questions_fingerprint ON questions(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_questions_cluster ON questions(duplicateClusterId);
    CREATE TABLE IF NOT EXISTS snippets (
      id TEXT PRIMARY KEY,
      materialId TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snippets_material ON snippets(materialId);
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      materialId TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_material ON embeddings(materialId);
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
      id UNINDEXED,
      type UNINDEXED,
      materialId UNINDEXED,
      title,
      body,
      context,
      tags,
      tokenize='unicode61'
    );
  `);
  const version = sqliteDb.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
  if (version?.value !== String(indexVersion)) {
    sqliteDb.exec(`
      DELETE FROM materials;
      DELETE FROM questions;
      DELETE FROM snippets;
      DELETE FROM embeddings;
      DELETE FROM rag_fts;
    `);
    sqliteDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)").run(String(indexVersion));
    sqliteDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('updatedAt', ?)").run(nowIso());
  }
  return sqliteDb;
}

export function checkpointRagIndex(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE") {
  const db = getSqliteDb();
  return db.prepare(`PRAGMA wal_checkpoint(${mode})`).all() as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
}

function sqliteUpdatedAt(db = getSqliteDb()) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'updatedAt'").get() as { value: string } | undefined;
  return row?.value || nowIso();
}

function setSqliteUpdatedAt(db = getSqliteDb()) {
  const updatedAt = nowIso();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('updatedAt', ?)").run(updatedAt);
  return updatedAt;
}

function writeIndexMetadata(index: RagIndexDb) {
  fs.mkdirSync(path.dirname(ragIndexPath), { recursive: true });
  const tmpPath = `${ragIndexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ version: index.version, updatedAt: index.updatedAt, sqlitePath: ragSqlitePath }, null, 2), "utf8");
  fs.renameSync(tmpPath, ragIndexPath);
}

function readIndexFromSqlite(): RagIndexDb {
  const db = getSqliteDb();
  const materials = (db.prepare("SELECT payload FROM materials ORDER BY updatedAt DESC").all() as unknown as SqliteRagRow[]).map((row) =>
    jsonParse<RagIndexedMaterial>(row.payload)
  );
  const questions = (db.prepare("SELECT payload FROM questions ORDER BY materialId, id").all() as unknown as SqliteRagRow[]).map((row) =>
    jsonParse<RagQuestionRecord>(row.payload)
  );
  const snippets = (db.prepare("SELECT payload FROM snippets ORDER BY materialId, id").all() as unknown as SqliteRagRow[]).map((row) =>
    jsonParse<RagSnippetRecord>(row.payload)
  );
  return {
    version: indexVersion,
    updatedAt: sqliteUpdatedAt(db),
    materials,
    questions,
    snippets
  };
}

function readMaterialFromSqlite(materialId: string) {
  const row = getSqliteDb().prepare("SELECT payload FROM materials WHERE id = ?").get(materialId) as { payload: string } | undefined;
  return row ? jsonParse<RagIndexedMaterial>(row.payload) : undefined;
}

function readQuestionsForMaterial(materialId: string) {
  return (getSqliteDb().prepare("SELECT payload FROM questions WHERE materialId = ? ORDER BY id").all(materialId) as Array<{ payload: string }>).map((row) =>
    jsonParse<RagQuestionRecord>(row.payload)
  );
}

function readMaterialsByIds(ids: string[]) {
  const uniqueIds = unique(ids.filter(Boolean));
  const materials = new Map<string, RagIndexedMaterial>();
  if (uniqueIds.length === 0) return materials;
  const db = getSqliteDb();
  const batchSize = 200;
  for (let start = 0; start < uniqueIds.length; start += batchSize) {
    const batch = uniqueIds.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, payload FROM materials WHERE id IN (${placeholders})`).all(...batch) as Array<{ id: string; payload: string }>;
    for (const row of rows) materials.set(row.id, jsonParse<RagIndexedMaterial>(row.payload));
  }
  return materials;
}

function readEmbeddingsByIds(ids: string[]) {
  const uniqueIds = unique(ids.filter(Boolean));
  if (uniqueIds.length === 0) return new Map<string, RagEmbeddingRecord>();
  const db = getSqliteDb();
  const records = new Map<string, RagEmbeddingRecord>();
  const batchSize = 200;
  for (let start = 0; start < uniqueIds.length; start += batchSize) {
    const batch = uniqueIds.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, materialId, model, dimensions, vector, updatedAt FROM embeddings WHERE id IN (${placeholders})`).all(...batch) as Array<{
      id: string;
      materialId: string;
      model: string;
      dimensions: number;
      vector: Buffer | Uint8Array;
      updatedAt: string;
    }>;
    for (const row of rows) {
      records.set(row.id, {
        id: row.id,
        materialId: row.materialId,
        model: row.model,
        dimensions: row.dimensions,
        vector: bufferToVector(row.vector),
        updatedAt: row.updatedAt
      });
    }
  }
  return records;
}

function countEmbeddingsForMaterial(materialId: string) {
  const row = getSqliteDb().prepare("SELECT COUNT(*) AS count FROM embeddings WHERE materialId = ?").get(materialId) as { count: number };
  return row.count;
}

function writeEmbeddingRecordsToSqlite(embeddings: RagEmbeddingRecord[]) {
  if (embeddings.length === 0) return;
  const db = getSqliteDb();
  const insertEmbedding = db.prepare("INSERT OR REPLACE INTO embeddings (id, materialId, model, dimensions, vector, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const embedding of embeddings) {
      insertEmbedding.run(
        embedding.id,
        embedding.materialId,
        embedding.model,
        embedding.dimensions,
        vectorToBuffer(embedding.vector),
        embedding.updatedAt
      );
    }
    setSqliteUpdatedAt(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readQuestionsByFingerprints(fingerprints: string[]) {
  const uniqueFingerprints = unique(fingerprints.filter(Boolean));
  if (uniqueFingerprints.length === 0) return [];
  const db = getSqliteDb();
  const questions: RagQuestionRecord[] = [];
  const batchSize = 200;
  for (let start = 0; start < uniqueFingerprints.length; start += batchSize) {
    const batch = uniqueFingerprints.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(`SELECT payload FROM questions WHERE fingerprint IN (${placeholders}) ORDER BY materialId, id`).all(...batch) as Array<{ payload: string }>;
    questions.push(...rows.map((row) => jsonParse<RagQuestionRecord>(row.payload)));
  }
  return questions;
}

function writeFullIndexToSqlite(index: RagIndexDb) {
  const db = getSqliteDb();
  const insertMaterial = db.prepare("INSERT INTO materials (id, path, status, size, mtimeMs, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertQuestion = db.prepare(
    "INSERT INTO questions (id, materialId, fingerprint, duplicateClusterId, isClusterRepresentative, answerQuality, hasAnswer, sourceKind, scorePriority, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertSnippet = db.prepare("INSERT INTO snippets (id, materialId, kind, payload) VALUES (?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO rag_fts (id, type, materialId, title, body, context, tags) VALUES (?, ?, ?, ?, ?, ?, ?)");
  try {
    db.exec("BEGIN");
    db.exec("DELETE FROM materials; DELETE FROM questions; DELETE FROM snippets; DELETE FROM embeddings; DELETE FROM rag_fts;");
    for (const material of index.materials) insertMaterial.run(material.id, material.path, material.status, material.size, material.mtimeMs, material.updatedAt, jsonStringify(material));
    for (const question of index.questions) {
      insertQuestion.run(
        question.id,
        question.materialId,
        question.fingerprint || questionFingerprint(question.text),
        question.duplicateClusterId || question.fingerprint || questionFingerprint(question.text),
        question.isClusterRepresentative ? 1 : 0,
        question.answerQuality || answerQualityForQuestion(question),
        question.hasAnswer ? 1 : 0,
        question.sourceKind,
        questionPriority(question),
        jsonStringify(question)
      );
      insertFts.run(question.id, "question", question.materialId, question.title, `${question.text}\n${question.solution}`, question.context, question.tags.join(" "));
    }
    for (const snippet of index.snippets) {
      insertSnippet.run(snippet.id, snippet.materialId, snippet.kind, jsonStringify(snippet));
      insertFts.run(snippet.id, "snippet", snippet.materialId, snippet.title, snippet.text, snippet.context, snippet.tags.join(" "));
    }
    setSqliteUpdatedAt(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function writeMaterialRecordsToSqlite(
  material: RagIndexedMaterial,
  questions: RagQuestionRecord[],
  snippets: RagSnippetRecord[],
  embeddings: RagEmbeddingRecord[] = [],
  affectedQuestions: RagQuestionRecord[] = []
) {
  const db = getSqliteDb();
  const insertMaterial = db.prepare("INSERT OR REPLACE INTO materials (id, path, status, size, mtimeMs, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertQuestion = db.prepare(
    "INSERT OR REPLACE INTO questions (id, materialId, fingerprint, duplicateClusterId, isClusterRepresentative, answerQuality, hasAnswer, sourceKind, scorePriority, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertSnippet = db.prepare("INSERT OR REPLACE INTO snippets (id, materialId, kind, payload) VALUES (?, ?, ?, ?)");
  const insertEmbedding = db.prepare("INSERT OR REPLACE INTO embeddings (id, materialId, model, dimensions, vector, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO rag_fts (id, type, materialId, title, body, context, tags) VALUES (?, ?, ?, ?, ?, ?, ?)");

  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM rag_fts WHERE materialId = ?").run(material.id);
    db.prepare("DELETE FROM questions WHERE materialId = ?").run(material.id);
    db.prepare("DELETE FROM snippets WHERE materialId = ?").run(material.id);
    db.prepare("DELETE FROM embeddings WHERE materialId = ?").run(material.id);
    insertMaterial.run(material.id, material.path, material.status, material.size, material.mtimeMs, material.updatedAt, jsonStringify(material));

    for (const question of questions) {
      insertQuestion.run(
        question.id,
        question.materialId,
        question.fingerprint || questionFingerprint(question.text),
        question.duplicateClusterId || question.fingerprint || questionFingerprint(question.text),
        question.isClusterRepresentative ? 1 : 0,
        question.answerQuality || answerQualityForQuestion(question),
        question.hasAnswer ? 1 : 0,
        question.sourceKind,
        questionPriority(question),
        jsonStringify(question)
      );
      insertFts.run(question.id, "question", question.materialId, question.title, `${question.text}\n${question.solution}`, question.context, question.tags.join(" "));
    }
    for (const snippet of snippets) {
      insertSnippet.run(snippet.id, snippet.materialId, snippet.kind, jsonStringify(snippet));
      insertFts.run(snippet.id, "snippet", snippet.materialId, snippet.title, snippet.text, snippet.context, snippet.tags.join(" "));
    }
    for (const embedding of embeddings) {
      insertEmbedding.run(
        embedding.id,
        embedding.materialId,
        embedding.model,
        embedding.dimensions,
        vectorToBuffer(embedding.vector),
        embedding.updatedAt
      );
    }

    for (const question of affectedQuestions) {
      if (question.materialId === material.id) continue;
      insertQuestion.run(
        question.id,
        question.materialId,
        question.fingerprint || questionFingerprint(question.text),
        question.duplicateClusterId || question.fingerprint || questionFingerprint(question.text),
        question.isClusterRepresentative ? 1 : 0,
        question.answerQuality || answerQualityForQuestion(question),
        question.hasAnswer ? 1 : 0,
        question.sourceKind,
        questionPriority(question),
        jsonStringify(question)
      );
    }

    setSqliteUpdatedAt(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureSqliteSeeded() {
  const db = getSqliteDb();
  const count = db.prepare("SELECT COUNT(*) AS count FROM materials").get() as { count: number };
  if (count.count > 0) return;
  const legacy = readIndexFromDisk();
  if (!legacy || legacy.materials.length === 0) return;
  writeFullIndexToSqlite(rebuildDuplicateClusters(legacy));
}

function saveIndex(index: RagIndexDb) {
  index.version = indexVersion;
  index.updatedAt = nowIso();
  index = rebuildDuplicateClusters(index);
  writeFullIndexToSqlite(index);
  writeIndexMetadata(index);
  cachedIndex = index;
  cachedSearchCache = null;
}

function saveSingleMaterialIndex(
  material: RagIndexedMaterial,
  questions: RagQuestionRecord[] = [],
  snippets: RagSnippetRecord[] = [],
  embeddings: RagEmbeddingRecord[] = [],
  affectedFingerprints: string[] = []
) {
  const relatedQuestions = readQuestionsByFingerprints(affectedFingerprints).filter((question) => question.materialId !== material.id);
  const scopedIndex = rebuildDuplicateClusters({
    version: indexVersion,
    updatedAt: nowIso(),
    materials: [],
    questions: [...relatedQuestions, ...questions],
    snippets: []
  });
  const nextQuestions = scopedIndex.questions.filter((question) => question.materialId === material.id);
  const affectedQuestions = scopedIndex.questions.filter((question) => question.materialId !== material.id);
  material.questionCount = nextQuestions.length;
  material.snippetCount = snippets.length;
  material.chunkCount = nextQuestions.length + snippets.length;
  material.updatedAt = nowIso();
  writeMaterialRecordsToSqlite(material, nextQuestions, snippets, embeddings, affectedQuestions);
  const metadataIndex = {
    version: indexVersion,
    updatedAt: sqliteUpdatedAt(),
    materials: [],
    questions: [],
    snippets: []
  };
  writeIndexMetadata(metadataIndex);
  cachedIndex = null;
  cachedSearchCache = null;
}

function getIndex(_store: Store) {
  if (cachedIndex) return cachedIndex;
  ensureSqliteSeeded();
  cachedIndex = readIndexFromSqlite();
  return cachedIndex;
}

export function clearRagIndexCache() {
  cachedIndex = null;
  cachedSearchCache = null;
}

function removeIndexedMaterial(index: RagIndexDb, id: string) {
  index.materials = index.materials.filter((material) => material.id !== id);
  index.questions = index.questions.filter((question) => question.materialId !== id);
  index.snippets = index.snippets.filter((snippet) => snippet.materialId !== id);
}

export function clearMaterialRootIndex(store: Store, root = path.join(config.workspaceRoot, "资料库")) {
  const index = getIndex(store);
  const resolvedRoot = assertWithinWorkspace(root);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const removedMaterialIds = new Set(
    [...store.data.materials, ...index.materials]
      .filter((material) => material.path === resolvedRoot || material.path.startsWith(rootWithSep))
      .map((material) => material.id)
  );

  store.data.materials = store.data.materials.filter((material) => !removedMaterialIds.has(material.id));
  store.data.ragChunks = [];
  index.materials = index.materials.filter((material) => !removedMaterialIds.has(material.id));
  index.questions = index.questions.filter((question) => !removedMaterialIds.has(question.materialId));
  index.snippets = index.snippets.filter((snippet) => !removedMaterialIds.has(snippet.materialId));
  store.save();
  saveIndex(index);
  return removedMaterialIds.size;
}

export function resetMaterialRootIndex(store: Store, root = path.join(config.workspaceRoot, "资料库")) {
  const resolvedRoot = assertWithinWorkspace(root);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  store.data.materials = store.data.materials.filter((material) => material.path !== resolvedRoot && !material.path.startsWith(rootWithSep));
  store.data.ragChunks = [];
  cachedIndex = emptyIndex();
  store.save();
  saveIndex(cachedIndex);
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function toPublicMaterial(material: RagIndexedMaterial): Material {
  return {
    id: material.id,
    title: material.title,
    path: material.path,
    size: material.size,
    mimeType: material.mimeType,
    status: material.status === "needs_conversion" ? "needs_conversion" : material.status,
    chunkCount: material.chunkCount,
    questionCount: material.questionCount,
    snippetCount: material.snippetCount,
    error: material.error,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt
  } as Material;
}

export function getRagStats(store: Store) {
  const index = getIndex(store);
  const chunks = index.questions.length + index.snippets.length;
  const existingPendingMaterials = store.data.materials.filter((material) => material.status === "pending" && fs.existsSync(material.path));
  return {
    materials: index.materials.length,
    indexedMaterials: index.materials.filter((material) => material.status === "indexed").length,
    needsConversionMaterials: index.materials.filter((material) => material.status === "needs_conversion").length,
    failedMaterials: index.materials.filter((material) => material.status === "failed").length,
    unsupportedMaterials: index.materials.filter((material) => material.status === "unsupported").length,
    pendingMaterials: existingPendingMaterials.length,
    chunks,
    questions: index.questions.length,
    snippets: index.snippets.length,
    indexPath: ragIndexPath,
    updatedAt: index.updatedAt
  };
}

function materialNeedsIndex(store: Store, index: RagIndexDb, filePath: string) {
  const resolved = assertWithinWorkspace(filePath);
  if (!fs.existsSync(resolved)) return false;
  const stat = fs.statSync(resolved);
  const id = hashId(resolved.toLowerCase());
  const material = store.data.materials.find((item) => item.id === id);
  const indexed = index.materials.find((item) => item.id === id);
  const ext = path.extname(resolved).toLowerCase();
  if (!supportedExtensions.has(ext)) return material?.status !== "unsupported";
  if (!material || material.status === "pending") return true;
  if (material.status === "needs_conversion") return true;
  if (material.status === "failed") return true;
  if (!indexed || indexed.status !== "indexed" || indexed.chunkCount === 0) return true;
  return indexed.size !== stat.size || Math.abs((indexed.mtimeMs || 0) - stat.mtimeMs) > 1;
}

export function listMaterialFilesNeedingIndex(store: Store, root = path.join(config.workspaceRoot, "资料库")) {
  const index = getIndex(store);
  return listMaterialCandidates(root).filter((filePath) => materialNeedsIndex(store, index, filePath));
}

export function listMaterialCatalog(store: Store, root = path.join(config.workspaceRoot, "资料库")) {
  const index = getIndex(store);
  const byId = new Map<string, Material>();
  for (const material of index.materials) byId.set(material.id, toPublicMaterial(material));
  for (const material of store.data.materials) {
    if (!fs.existsSync(material.path) || byId.has(material.id)) continue;
    byId.set(material.id, {
      ...material,
      status: "pending",
      chunkCount: 0,
      questionCount: 0,
      snippetCount: 0,
      error: "尚未用当前 RAG 索引版本解析。"
    });
  }

  const now = nowIso();
  for (const filePath of listMaterialCandidates(root)) {
    const resolved = assertWithinWorkspace(filePath);
    const stat = fs.statSync(resolved);
    const id = hashId(resolved.toLowerCase());
    if (byId.has(id)) continue;
    const ext = path.extname(resolved).toLowerCase();
    byId.set(id, {
      id,
      title: decodeUploadName(path.basename(resolved)),
      path: resolved,
      size: stat.size,
      status: supportedExtensions.has(ext) ? "pending" : "unsupported",
      chunkCount: 0,
      questionCount: 0,
      snippetCount: 0,
      error: supportedExtensions.has(ext) ? "尚未索引。" : `Unsupported file type: ${ext}`,
      createdAt: now,
      updatedAt: now
    });
  }

  return [...byId.values()];
}

export function getMaterialRagPreview(store: Store, materialId: string) {
  const index = getIndex(store);
  const material = index.materials.find((item) => item.id === materialId) || store.data.materials.find((item) => item.id === materialId);
  if (!material) return null;
  return {
    material: "tags" in material ? toPublicMaterial(material as RagIndexedMaterial) : material,
    questions: index.questions.filter((question) => question.materialId === materialId).slice(0, 80),
    snippets: index.snippets.filter((snippet) => snippet.materialId === materialId).slice(0, 40)
  };
}

export async function deleteMaterialFile(store: Store, materialId: string) {
  const index = getIndex(store);
  const material = store.data.materials.find((item) => item.id === materialId) || index.materials.find((item) => item.id === materialId);
  if (!material) return null;

  const resolved = assertWithinWorkspace(material.path);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) throw new Error("Cannot delete a directory from material delete.");
    await fs.promises.unlink(resolved);
  }

  store.data.materials = store.data.materials.filter((item) => item.id !== materialId);
  store.data.ragChunks = [];
  removeIndexedMaterial(index, materialId);
  store.save();
  saveIndex(index);
  return toPublicMaterial({
    id: material.id,
    title: material.title,
    path: material.path,
    size: material.size,
    mtimeMs: "mtimeMs" in material && typeof material.mtimeMs === "number" ? material.mtimeMs : 0,
    mimeType: material.mimeType,
    status: material.status,
    chunkCount: material.chunkCount,
    questionCount: "questionCount" in material && typeof material.questionCount === "number" ? material.questionCount : 0,
    snippetCount: "snippetCount" in material && typeof material.snippetCount === "number" ? material.snippetCount : 0,
    error: material.error,
    tags: "tags" in material && Array.isArray(material.tags) ? material.tags : [],
    createdAt: material.createdAt,
    updatedAt: material.updatedAt
  });
}

export function registerMaterialFile(store: Store, filePath: string, mimeType?: string) {
  const resolved = assertWithinWorkspace(filePath);
  const stat = fs.statSync(resolved);
  const id = hashId(resolved.toLowerCase());
  const title = decodeUploadName(path.basename(resolved));
  const now = nowIso();
  const previous = store.data.materials.find((material) => material.id === id);
  const ext = path.extname(resolved).toLowerCase();
  const material: Material = {
    id,
    title,
    path: resolved,
    size: stat.size,
    mimeType,
    status: supportedExtensions.has(ext) ? "pending" : "unsupported",
    chunkCount: 0,
    questionCount: 0,
    snippetCount: 0,
    error: supportedExtensions.has(ext) ? "已上传，等待重建索引。" : `Unsupported file type: ${ext}`,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  } as Material;
  store.upsertMaterial(material);
  return material;
}

export function markMaterialIndexFailed(store: Store, filePath: string, error: string, mimeType?: string) {
  ensureSqliteSeeded();
  const resolved = assertWithinWorkspace(filePath);
  const stat = fs.statSync(resolved);
  const id = hashId(resolved.toLowerCase());
  const title = decodeUploadName(path.basename(resolved));
  const previous = store.data.materials.find((material) => material.id === id);
  const previousIndexed = readMaterialFromSqlite(id);
  const now = nowIso();
  const material: RagIndexedMaterial = {
    id,
    title,
    path: resolved,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mimeType: mimeType || previous?.mimeType || previousIndexed?.mimeType,
    status: "failed",
    chunkCount: 0,
    questionCount: 0,
    snippetCount: 0,
    error,
    tags: extractTags(title, resolved),
    createdAt: previous?.createdAt || previousIndexed?.createdAt || now,
    updatedAt: now
  };
  store.data.ragChunks = [];
  const affectedFingerprints = readQuestionsForMaterial(id).map((question) => question.fingerprint || questionFingerprint(question.text));
  store.upsertMaterial(toPublicMaterial(material));
  saveSingleMaterialIndex(material, [], [], [], affectedFingerprints);
  return toPublicMaterial(material);
}

export async function deleteMaterialFolder(store: Store, relativeFolderPath: string) {
  const normalized = relativeFolderPath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized) throw new Error("不能删除整个资料库根目录。");

  const materialRootResolved = assertWithinWorkspace(materialRoot);
  const rootWithSep = materialRootResolved.endsWith(path.sep) ? materialRootResolved : `${materialRootResolved}${path.sep}`;
  const candidates = [path.join(materialRoot, normalized), path.join(uploadRoot, normalized)]
    .map((candidate) => assertWithinWorkspace(candidate))
    .filter((candidate) => candidate.startsWith(rootWithSep));
  const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || candidates[0];
  if (!resolved.startsWith(rootWithSep)) throw new Error("只能删除资料库目录下的子文件夹。");
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("目标不是文件夹。");

  const folderWithSep = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
  const index = getIndex(store);
  const removedMaterialIds = new Set(
    [...store.data.materials, ...index.materials]
      .filter((material) => material.path === resolved || material.path.startsWith(folderWithSep))
      .map((material) => material.id)
  );

  await fs.promises.rm(resolved, { recursive: true, force: true });
  store.data.materials = store.data.materials.filter((material) => !removedMaterialIds.has(material.id));
  store.data.ragChunks = [];
  index.materials = index.materials.filter((material) => !removedMaterialIds.has(material.id));
  index.questions = index.questions.filter((question) => !removedMaterialIds.has(question.materialId));
  index.snippets = index.snippets.filter((snippet) => !removedMaterialIds.has(snippet.materialId));
  store.save();
  saveIndex(index);
  return {
    path: resolved,
    removedMaterials: removedMaterialIds.size
  };
}

function splitQuestionAnswer(block: string) {
  const answerMatch = block.match(/(?:答案|参考答案|解析|解答|解[:：])\s*[:：]?/);
  if (!answerMatch || answerMatch.index === undefined || answerMatch.index < 20) {
    return { prompt: block.trim(), answer: "", solution: "" };
  }
  const prompt = block.slice(0, answerMatch.index).trim();
  const solution = block.slice(answerMatch.index).trim();
  const answerLine = solution
    .split(/\n/)
    .map((line) => line.trim())
    .find((line) => /答案|参考答案/.test(line)) || "";
  return {
    prompt: prompt || block.trim(),
    answer: answerLine.replace(/^(?:答案|参考答案)\s*[:：]?/, "").trim(),
    solution
  };
}

function questionMarkers(text: string) {
  const pattern =
    /(?:^|\n)\s*(?:[【[(（]?\s*)((?:诊断自测)|(?:典例\s*\d+(?:[-－]\d+)?)|(?:例题?\s*\d+(?:[-－]\d+)?)|(?:变式\s*\d+(?:[-－]\d+)?)|(?:即学即练\s*\d+)|(?:练习\s*\d+(?:[-－]\d+)?)|(?:作业\s*\d+(?:[-－]\d+)?)|(?:第\s*[一二三四五六七八九十百\d]+\s*题)|(?:\d{1,3}[.．、]\s*)|(?:\d{1,2}(?=\s+(?:\(?20\d{2}|设|已知|若|下列|函数|不等式|在|如图|求|证明))))(?:\s*[】\])）])?/g;
  return [...text.matchAll(pattern)]
    .map((match) => ({
      label: match[1].trim().replace(/\s+/g, ""),
      start: match.index || 0
    }))
    .filter((marker, index, markers) => index === 0 || marker.start - markers[index - 1].start > 20);
}

function countMatches(text: string, pattern: RegExp) {
  return (text.match(pattern) || []).length;
}

function normalizeQuestionForFingerprint(text: string) {
  return text
    .replace(/(?:^|\n)\s*(?:[【[(（]?\s*)?(?:诊断自测|典例\s*\d+(?:[-－]\d+)?|例题?\s*\d+(?:[-－]\d+)?|变式\s*\d+(?:[-－]\d+)?|即学即练\s*\d+|练习\s*\d+(?:[-－]\d+)?|作业\s*\d+(?:[-－]\d+)?|\d{1,3}[.．、])(?:\s*[】\])）])?/g, "")
    .replace(/（20\d{2}[^）]*）/g, "")
    .replace(/答案[\s\S]*$/g, "")
    .replace(/解析[\s\S]*$/g, "")
    .replace(/\[图片\]/g, "[图]")
    .replace(/\s+/g, "")
    .replace(/[，。；：、,.!?！？]/g, "")
    .toLowerCase()
    .slice(0, 2000);
}

function questionFingerprint(text: string) {
  const normalized = normalizeQuestionForFingerprint(text);
  return hashId(normalized || text.slice(0, 500));
}

function answerQualityForQuestion(question: Pick<RagQuestionRecord, "answer" | "solution" | "hasAnswer">): RagAnswerQuality {
  if (!question.hasAnswer && !question.solution) return "none";
  if (question.solution.length > 260 && /因为|所以|由|解得|证明|故|步骤|法一|分析/.test(question.solution)) return "detailed_solution";
  if (question.solution.length > 60) return "solution_steps";
  return question.answer ? "answer_only" : "none";
}

function questionPriority(question: Pick<RagQuestionRecord, "title" | "path" | "hasAnswer" | "answerQuality" | "sourceKind" | "formulaCount" | "imageCount">) {
  const answerScore = question.answerQuality === "detailed_solution" ? 45 : question.answerQuality === "solution_steps" ? 32 : question.answerQuality === "answer_only" ? 18 : 0;
  const titlePath = `${question.title} ${question.path}`;
  const versionScore = /解析版|教师版|答案|详解/.test(titlePath) ? 30 : /原卷版|学生版/.test(titlePath) ? -16 : 0;
  const sourceScore = question.sourceKind === "exam" ? 10 : question.sourceKind === "mock" ? 6 : 0;
  const qualityPenalty = question.formulaCount * 12 + question.imageCount * 2;
  return answerScore + versionScore + sourceScore - qualityPenalty;
}

function embeddingTextForQuestion(question: RagQuestionRecord) {
  return trimEmbeddingText(
    [
      question.title,
      question.context,
      question.questionType,
      question.difficulty,
      question.teachingRoles.join(" "),
      question.knowledgeTags.join(" "),
      question.text,
      question.solution
    ].join("\n")
  );
}

function embeddingTextForSnippet(snippet: RagSnippetRecord) {
  return trimEmbeddingText([snippet.title, snippet.context, snippet.tags.join(" "), snippet.text].join("\n"));
}

async function buildEmbeddingRecords(records: Array<RagQuestionRecord | RagSnippetRecord>) {
  if (!isEmbeddingEnabled() || records.length === 0) return [];
  const embeddings: RagEmbeddingRecord[] = [];
  const batchSize = Math.max(1, Math.min(32, Math.floor(config.ragEmbeddingBatchSize || 8)));
  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const texts = batch.map((record) => ("questionNumber" in record ? embeddingTextForQuestion(record) : embeddingTextForSnippet(record)));
    const vectors = await embedTexts(texts);
    vectors.forEach((vector, index) => {
      const record = batch[index];
      embeddings.push({
        id: record.id,
        materialId: record.materialId,
        vector,
        model: config.ragEmbeddingModel,
        dimensions: vector.length,
        updatedAt: nowIso()
      });
    });
  }
  return embeddings;
}

export async function ensureMaterialEmbeddings(
  store: Store,
  materialId: string,
  onProgress?: (progress: { total: number; processed: number; current: string }) => void
) {
  if (!isEmbeddingEnabled()) throw new Error("RAG embedding is not enabled. Set RAG_EMBEDDING_PROVIDER=ark and RAG_EMBEDDING_API_KEY.");
  const index = getIndex(store);
  const material = index.materials.find((item) => item.id === materialId);
  if (!material) throw new Error("Material not found in RAG index.");
  const questions = index.questions.filter((question) => question.materialId === materialId);
  const snippets = index.snippets.filter((snippet) => snippet.materialId === materialId);
  const records = [...questions, ...snippets];
  const existing = readEmbeddingsByIds(records.map((record) => record.id));
  const missing = records
    .filter((record) => existing.get(record.id)?.model !== config.ragEmbeddingModel)
    .slice(0, Math.max(1, Math.floor(config.ragEmbeddingMaxRecords)));
  let processed = 0;
  const batchSize = Math.max(1, Math.min(32, Math.floor(config.ragEmbeddingBatchSize || 1)));
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    onProgress?.({ total: missing.length, processed, current: batch[0]?.id || material.path });
    const embeddings = await buildEmbeddingRecords(batch);
    writeEmbeddingRecordsToSqlite(embeddings);
    processed += batch.length;
    onProgress?.({ total: missing.length, processed, current: batch.at(-1)?.id || material.path });
  }
  clearRagIndexCache();
  return {
    material: toPublicMaterial(material),
    total: records.length,
    existing: records.length - missing.length,
    created: missing.length,
    embeddings: countEmbeddingsForMaterial(materialId)
  };
}

function rebuildDuplicateClusters(index: RagIndexDb): RagIndexDb {
  const byFingerprint = new Map<string, RagQuestionRecord[]>();
  for (const question of index.questions) {
    question.fingerprint ||= questionFingerprint(question.text);
    question.duplicateClusterId = question.fingerprint;
    question.answerQuality = question.answerQuality || answerQualityForQuestion(question);
    question.isClusterRepresentative = true;
    const list = byFingerprint.get(question.fingerprint) || [];
    list.push(question);
    byFingerprint.set(question.fingerprint, list);
  }

  for (const [fingerprint, questions] of byFingerprint.entries()) {
    const representative = [...questions].sort((a, b) => questionPriority(b) - questionPriority(a))[0];
    for (const question of questions) {
      question.duplicateClusterId = fingerprint;
      question.isClusterRepresentative = question.id === representative.id;
    }
  }

  return index;
}

function qualityWarningsForQuestion(text: string, formulaCount: number, imageCount: number) {
  const warnings: string[] = [];
  if (formulaCount > 0) warnings.push(`含${formulaCount}处公式占位，需看原文件核对`);
  if (imageCount > 0) warnings.push(`含${imageCount}处图片，需看原文件核对`);
  if (/A．\s*B．|A．\s*C．|A．\s*D．|已知[，,。；;]|函数[，,。；;]|若[，,。；;]/.test(text)) warnings.push("疑似公式数据缺失");
  if (/目录|方法技巧与总结|题型归纳总结|知识点\d*[:：]|题型[一二三四五六七八九十]/.test(text.slice(0, 120))) warnings.push("疑似目录或知识点说明");
  return warnings;
}

function isLikelyQuestionBlock(label: string, block: string) {
  const head = block.slice(0, 260);
  if (/^(?:[①②③④⑤⑥⑦⑧⑨⑩]|知识点|方法技巧|题型归纳|目录|考点|能力拓展)/.test(head.trim())) return false;
  if (/题型[一二三四五六七八九十]|方法技巧|知识点\d*[:：]/.test(head) && !/【(?:典例|变式|即学即练|诊断自测)/.test(head)) return false;
  if (/典例|变式|即学即练|诊断自测|第\s*[一二三四五六七八九十百\d]+\s*题/.test(label)) return true;
  if (/A．[\s\S]{0,120}B．|求|证明|已知|若|设|下列|填空|判断|计算|讨论|解答/.test(head)) return true;
  return false;
}

function buildQuestionRecords(material: RagIndexedMaterial, text: string) {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const markers = questionMarkers(normalized);
  const blocks =
    markers.length > 0
      ? markers.map((marker, index) => {
          const end = markers[index + 1]?.start ?? normalized.length;
          return {
            label: marker.label,
            block: normalized.slice(marker.start, end).trim()
          };
        })
      : [];
  const candidates = blocks.filter((item) => item.block.length >= 40 && isLikelyQuestionBlock(item.label, item.block));

  return candidates.flatMap((item, index): RagQuestionRecord[] => {
    const split = splitQuestionAnswer(item.block);
    if (isFormulaPlaceholderHeavy(`${split.prompt}\n${split.solution}`)) return [];
    const formulaCount = countMatches(item.block, /\[公式\]/g);
    const imageCount = countMatches(item.block, /\[图片\]/g);
    const qualityWarnings = qualityWarningsForQuestion(split.prompt, formulaCount, imageCount);
    const tags = extractTags(material.title, material.path, item.block);
    const knowledgeTags = tags.filter((tag) => topicTags.includes(tag));
    const sourceKind = detectSourceKind(material.title, material.path, item.block);
    const teachingRoles = detectTeachingRoles(item.label, item.block);
    const questionType = detectQuestionType(item.block);
    const difficulty = detectDifficulty(item.block);
    const examSource = sourceKind === "exam" || sourceKind === "mock" ? detectExamSource(material.title, material.path, item.block) : "";
    const context = [
      `资料：${material.title}`,
      `来源状态：${sourceKind}`,
      examSource ? `考试来源：${examSource}` : "",
      knowledgeTags.length > 0 ? `知识点：${knowledgeTags.join("、")}` : "",
      `题型：${questionType}`,
      `难度：${difficulty}`,
      `教学角色：${teachingRoles.join("、")}`,
      qualityWarnings.length > 0 ? `质量提示：${qualityWarnings.join("；")}` : "",
      split.solution ? "已有答案或解析" : "未检测到答案解析，备课时需独立验算"
    ]
      .filter(Boolean)
      .join("；");

    const tokenText = `${context}\n${split.prompt}\n${split.solution}\n${tags.join(" ")}`;
    const fingerprint = questionFingerprint(split.prompt);
    const answerQuality = answerQualityForQuestion({ answer: split.answer, solution: split.solution, hasAnswer: Boolean(split.solution) });
    return [{
      id: `${material.id}_q${index}`,
      materialId: material.id,
      path: material.path,
      title: material.title,
      index,
      label: item.label,
      questionNumber: item.label.replace(/[.．、]$/, "") || `第${index + 1}题`,
      text: split.prompt.slice(0, 5000),
      answer: split.answer.slice(0, 1000),
      solution: split.solution.slice(0, 5000),
      context,
      sourceKind,
      examSource,
      questionType,
      difficulty,
      teachingRoles,
      knowledgeTags,
      tags,
      tokens: unique([...tokenize(tokenText), ...tokenize(material.title), ...tokenize(material.path)]),
      hasAnswer: Boolean(split.solution),
      formulaCount,
      imageCount,
      qualityWarnings,
      fingerprint,
      duplicateClusterId: fingerprint,
      isClusterRepresentative: true,
      answerQuality
    }];
  });
}

function buildSnippetRecords(material: RagIndexedMaterial, text: string) {
  const materialTags = extractTags(material.title, material.path, text.slice(0, 6000));
  return chunkText(text).flatMap((chunk, index): RagSnippetRecord[] => {
    if (isFormulaPlaceholderHeavy(chunk)) return [];
    const tags = extractTags(material.title, material.path, chunk);
    const formulaCount = countMatches(chunk, /\[公式\]/g);
    const imageCount = countMatches(chunk, /\[图片\]/g);
    const kind: RagSnippetKind = /答案|解析|解答/.test(chunk) ? "answer" : /定义|性质|方法|模板|知识点|易错/.test(chunk) ? "knowledge" : "chunk";
    const context = [
      `资料：${material.title}`,
      `片段类型：${kind}`,
      tags.length > 0 ? `标签：${tags.join("、")}` : "",
      materialTags.length > 0 ? `资料标签：${materialTags.join("、")}` : ""
    ]
      .filter(Boolean)
      .join("；");
    return [{
      id: `${material.id}_s${index}`,
      materialId: material.id,
      path: material.path,
      title: material.title,
      index,
      kind,
      text: chunk,
      context,
      tags,
      tokens: unique([...tokenize(context), ...tokenize(chunk), ...tokenize(material.title), ...tokenize(material.path)]),
      formulaCount,
      imageCount
    }];
  });
}

export async function indexMaterialFile(store: Store, filePath: string, mimeType?: string) {
  ensureSqliteSeeded();
  let resolved = assertWithinWorkspace(filePath);
  const decodedName = sanitizeFilename(decodeUploadName(path.basename(resolved)), path.basename(resolved));
  if (decodedName !== path.basename(resolved)) {
    const decodedPath = path.join(path.dirname(resolved), decodedName);
    if (!fs.existsSync(decodedPath)) {
      fs.renameSync(resolved, decodedPath);
      resolved = decodedPath;
    }
  }
  const stat = fs.statSync(resolved);
  const id = hashId(resolved.toLowerCase());
  const title = decodeUploadName(path.basename(resolved));
  const now = nowIso();
  const previous = store.data.materials.find((material) => material.id === id);
  const previousIndexed = readMaterialFromSqlite(id);
  const ext = path.extname(resolved).toLowerCase();

  let material: RagIndexedMaterial = {
    id,
    title,
    path: resolved,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mimeType,
    status: "indexed",
    chunkCount: 0,
    questionCount: 0,
    snippetCount: 0,
    tags: extractTags(title, resolved),
    createdAt: previous?.createdAt || previousIndexed?.createdAt || now,
    updatedAt: now
  };

  function persistMaterial(
    nextMaterial: RagIndexedMaterial,
    questions: RagQuestionRecord[] = [],
    snippets: RagSnippetRecord[] = [],
    embeddings: RagEmbeddingRecord[] = []
  ) {
    store.data.ragChunks = [];
    const affectedFingerprints = unique([
      ...readQuestionsForMaterial(id).map((question) => question.fingerprint || questionFingerprint(question.text)),
      ...questions.map((question) => question.fingerprint || questionFingerprint(question.text))
    ]);
    store.upsertMaterial(toPublicMaterial(nextMaterial));
    saveSingleMaterialIndex(nextMaterial, questions, snippets, embeddings, affectedFingerprints);
    return toPublicMaterial(nextMaterial);
  }

  try {
    if (!supportedExtensions.has(ext)) {
      material = { ...material, status: "unsupported", error: `Unsupported file type: ${ext}` };
      return persistMaterial(material);
    }

    if (stat.size > config.ragMaxParseBytes) {
      const metadataText = [
        title,
        resolved,
        `文件较大：${Math.round((stat.size / 1024 / 1024) * 10) / 10}MB`,
        "已建立文件名和路径索引，未解析正文。"
      ].join("\n");
      const materialTags = extractTags(title, resolved);
      const snippet: RagSnippetRecord = {
        id: `${id}_s0`,
        materialId: id,
        path: resolved,
        title,
        index: 0,
        kind: "metadata",
        text: metadataText,
        context: `资料：${title}；片段类型：metadata；未解析正文`,
        tags: materialTags,
        tokens: unique([...tokenize(title), ...tokenize(resolved), ...tokenize(materialTags.join(" "))]),
        formulaCount: 0,
        imageCount: 0
      };
      material = {
        ...material,
        status: "indexed",
        chunkCount: 1,
        questionCount: 0,
        snippetCount: 1,
        tags: materialTags,
        error: `文件超过 ${Math.round(config.ragMaxParseBytes / 1024 / 1024)}MB，仅索引文件名和路径，未解析正文。`
      };
      let embeddings: RagEmbeddingRecord[] = [];
      try {
        embeddings = await buildEmbeddingRecords([snippet]);
      } catch (error) {
        material.error = `${material.error} 向量化失败：${error instanceof Error ? error.message : String(error)}`;
      }
      return persistMaterial(material, [], [snippet], embeddings);
    }

    const extracted = await extractText(resolved);
    const text = extracted.text;
    const materialTags = extractTags(title, resolved, text.slice(0, 6000));
    const baseMaterial = { ...material, tags: materialTags };
    const questions = buildQuestionRecords(baseMaterial, text);
    const snippets = buildSnippetRecords(baseMaterial, text);
    material = {
      ...baseMaterial,
      status: "indexed",
      questionCount: questions.length,
      snippetCount: snippets.length,
      chunkCount: questions.length + snippets.length
    };
    let embeddings: RagEmbeddingRecord[] = [];
    try {
      embeddings = await buildEmbeddingRecords([...questions, ...snippets]);
    } catch (error) {
      material.error = `正文已索引，向量化失败：${error instanceof Error ? error.message : String(error)}`;
    }
    return persistMaterial(material, questions, snippets, embeddings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    material = {
      ...material,
      status: ext === ".doc" && /旧版 \.doc/.test(message) ? "needs_conversion" : "failed",
      error: message,
      chunkCount: 0,
      questionCount: 0,
      snippetCount: 0
    };
    return persistMaterial(material);
  }
}

interface SearchUnit {
  type: "question" | "snippet";
  material: RagIndexedMaterial;
  question?: RagQuestionRecord;
  snippet?: RagSnippetRecord;
  id: string;
  text: string;
  context: string;
  title: string;
  path: string;
  tags: string[];
  tokens: string[];
  hasAnswer: boolean;
  teachingRoles: string[];
  sourceKind: RagSourceKind;
  duplicateClusterId?: string;
  isClusterRepresentative: boolean;
  answerQuality: RagAnswerQuality;
}

interface SearchCache {
  units: SearchUnit[];
  tokenToUnitIndexes: Map<string, number[]>;
  tagToUnitIndexes: Map<string, number[]>;
}

function buildSearchUnits(index: RagIndexDb) {
  const materialById = new Map(index.materials.map((material) => [material.id, material]));
  const units: SearchUnit[] = [];
  for (const question of index.questions) {
    const material = materialById.get(question.materialId);
    if (!material || material.status !== "indexed") continue;
    units.push({
      type: "question",
      material,
      question,
      id: question.id,
      text: `${question.context}\n${question.text}\n${question.solution}`,
      context: question.context,
      title: question.title,
      path: question.path,
      tags: question.tags,
      tokens: question.tokens,
      hasAnswer: question.hasAnswer,
      teachingRoles: question.teachingRoles,
      sourceKind: question.sourceKind,
      duplicateClusterId: question.duplicateClusterId,
      isClusterRepresentative: question.isClusterRepresentative,
      answerQuality: question.answerQuality
    });
  }
  for (const snippet of index.snippets) {
    const material = materialById.get(snippet.materialId);
    if (!material || material.status !== "indexed") continue;
    units.push({
      type: "snippet",
      material,
      snippet,
      id: snippet.id,
      text: `${snippet.context}\n${snippet.text}`,
      context: snippet.context,
      title: snippet.title,
      path: snippet.path,
      tags: snippet.tags,
      tokens: snippet.tokens,
      hasAnswer: snippet.kind === "answer",
      teachingRoles: snippet.kind === "knowledge" ? ["知识参考"] : ["资料片段"],
      sourceKind: detectSourceKind(snippet.title, snippet.path, snippet.text),
      isClusterRepresentative: true,
      answerQuality: snippet.kind === "answer" ? "solution_steps" : "none"
    });
  }
  return units;
}

function buildSearchCache(index: RagIndexDb): SearchCache {
  const units = buildSearchUnits(index);
  const tokenToUnitIndexes = new Map<string, number[]>();
  const tagToUnitIndexes = new Map<string, number[]>();

  units.forEach((unit, index) => {
    for (const token of unit.tokens) {
      const list = tokenToUnitIndexes.get(token) || [];
      list.push(index);
      tokenToUnitIndexes.set(token, list);
    }
    for (const tag of unique([...unit.material.tags, ...unit.tags])) {
      const list = tagToUnitIndexes.get(tag) || [];
      list.push(index);
      tagToUnitIndexes.set(tag, list);
    }
  });

  return { units, tokenToUnitIndexes, tagToUnitIndexes };
}

function getSearchCache(index: RagIndexDb) {
  if (!cachedSearchCache) cachedSearchCache = buildSearchCache(index);
  return cachedSearchCache;
}

function collectCandidateUnits(cache: SearchCache, queryTokens: string[], queryTags: string[], limit: number) {
  const counts = new Map<number, number>();
  for (const token of queryTokens) {
    for (const index of cache.tokenToUnitIndexes.get(token) || []) {
      counts.set(index, (counts.get(index) || 0) + 1);
    }
  }
  for (const tag of queryTags) {
    for (const index of cache.tagToUnitIndexes.get(tag) || []) {
      counts.set(index, (counts.get(index) || 0) + 4);
    }
  }

  if (counts.size === 0) return [];
  const maxCandidates = Math.max(300, limit * 80);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates)
    .map(([index]) => cache.units[index])
    .filter(Boolean);
}

function ftsQuery(input: string) {
  const terms = [
    ...input.matchAll(/[a-zA-Z0-9_+\-*/^=<>.()]+/g),
    ...input.matchAll(/[\u3400-\u9fff]{2,}/g)
  ]
    .map((match) => match[0].replace(/"/g, " ").trim())
    .filter((term) => term.length >= 2)
    .slice(0, 16);
  return terms.length > 0 ? terms.map((term) => `"${term}"`).join(" OR ") : "";
}

function collectFtsCandidateIds(query: string, limit: number) {
  const expression = ftsQuery(query);
  if (!expression) return new Set<string>();
  try {
    const rows = getSqliteDb()
      .prepare("SELECT id FROM rag_fts WHERE rag_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(expression, Math.max(200, limit * 80)) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } catch {
    return new Set<string>();
  }
}

function collectTokenCandidateIds(queryTokens: string[], queryTags: string[], limit: number) {
  if (queryTokens.length === 0 && queryTags.length === 0) return new Set<string>();
  const maxCandidates = Math.max(300, limit * 80);
  const scored: Array<{ id: string; score: number }> = [];
  const rows = getSqliteDb().prepare("SELECT id, tags, body, title, context FROM rag_fts").iterate() as Iterable<{
    id: string;
    tags: string;
    body: string;
    title: string;
    context: string;
  }>;

  for (const row of rows) {
    const text = `${row.title} ${row.context} ${row.tags} ${row.body}`.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (text.includes(token.toLowerCase())) score += 1;
    }
    for (const tag of queryTags) {
      if (row.tags.includes(tag) || text.includes(tag)) score += 4;
    }
    if (score <= 0) continue;
    scored.push({ id: row.id, score });
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > maxCandidates) scored.pop();
  }

  return new Set(scored.map((item) => item.id));
}

function collectSemanticCandidateIds(queryEmbedding: number[] | undefined, limit: number) {
  if (!queryEmbedding) return { ids: new Set<string>(), embeddings: new Map<string, RagEmbeddingRecord>() };
  const maxCandidates = Math.max(120, limit * 60);
  const scored: Array<{ embedding: RagEmbeddingRecord; similarity: number }> = [];
  const queryVector = Float32Array.from(queryEmbedding);
  const rows = getSqliteDb()
    .prepare("SELECT id, materialId, model, dimensions, vector, updatedAt FROM embeddings WHERE model = ?")
    .iterate(config.ragEmbeddingModel) as Iterable<{
    id: string;
    materialId: string;
    model: string;
    dimensions: number;
    vector: Buffer | Uint8Array;
    updatedAt: string;
  }>;

  for (const row of rows) {
    const vector = bufferToFloat32Array(row.vector);
    const similarity = cosineSimilarity(queryVector, vector);
    if (similarity <= 0) continue;
    const embedding: RagEmbeddingRecord = {
      id: row.id,
      materialId: row.materialId,
      model: row.model,
      dimensions: row.dimensions,
      vector: [...vector],
      updatedAt: row.updatedAt
    };
    scored.push({ embedding, similarity });
    scored.sort((a, b) => b.similarity - a.similarity);
    if (scored.length > maxCandidates) scored.pop();
  }

  return {
    ids: new Set(scored.map((item) => item.embedding.id)),
    embeddings: new Map(scored.map((item) => [item.embedding.id, item.embedding]))
  };
}

function readSearchUnitsByIds(ids: string[]) {
  const uniqueIds = unique(ids.filter(Boolean));
  if (uniqueIds.length === 0) return [] as SearchUnit[];
  const db = getSqliteDb();
  const questions: RagQuestionRecord[] = [];
  const snippets: RagSnippetRecord[] = [];
  const batchSize = 200;

  for (let start = 0; start < uniqueIds.length; start += batchSize) {
    const batch = uniqueIds.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(",");
    const questionRows = db.prepare(`SELECT payload FROM questions WHERE id IN (${placeholders})`).all(...batch) as Array<{ payload: string }>;
    const snippetRows = db.prepare(`SELECT payload FROM snippets WHERE id IN (${placeholders})`).all(...batch) as Array<{ payload: string }>;
    questions.push(...questionRows.map((row) => jsonParse<RagQuestionRecord>(row.payload)));
    snippets.push(...snippetRows.map((row) => jsonParse<RagSnippetRecord>(row.payload)));
  }

  const materialById = readMaterialsByIds([...questions.map((question) => question.materialId), ...snippets.map((snippet) => snippet.materialId)]);
  const units: SearchUnit[] = [];
  for (const question of questions) {
    const material = materialById.get(question.materialId);
    if (!material || material.status !== "indexed") continue;
    units.push({
      type: "question",
      material,
      question,
      id: question.id,
      text: `${question.context}\n${question.text}\n${question.solution}`,
      context: question.context,
      title: question.title,
      path: question.path,
      tags: question.tags,
      tokens: question.tokens,
      hasAnswer: question.hasAnswer,
      teachingRoles: question.teachingRoles,
      sourceKind: question.sourceKind,
      duplicateClusterId: question.duplicateClusterId,
      isClusterRepresentative: question.isClusterRepresentative,
      answerQuality: question.answerQuality
    });
  }
  for (const snippet of snippets) {
    const material = materialById.get(snippet.materialId);
    if (!material || material.status !== "indexed") continue;
    units.push({
      type: "snippet",
      material,
      snippet,
      id: snippet.id,
      text: `${snippet.context}\n${snippet.text}`,
      context: snippet.context,
      title: snippet.title,
      path: snippet.path,
      tags: snippet.tags,
      tokens: snippet.tokens,
      hasAnswer: snippet.kind === "answer",
      teachingRoles: snippet.kind === "knowledge" ? ["知识参考"] : ["资料片段"],
      sourceKind: detectSourceKind(snippet.title, snippet.path, snippet.text),
      isClusterRepresentative: true,
      answerQuality: snippet.kind === "answer" ? "solution_steps" : "none"
    });
  }
  return units;
}

function collectSemanticCandidateUnits(cache: SearchCache, queryEmbedding: number[] | undefined, limit: number) {
  if (!queryEmbedding) return { units: [] as SearchUnit[], embeddings: new Map<string, RagEmbeddingRecord>() };
  const unitById = new Map(cache.units.map((unit) => [unit.id, unit]));
  const maxCandidates = Math.max(120, limit * 60);
  const scored: Array<{ embedding: RagEmbeddingRecord; unit: SearchUnit; similarity: number }> = [];
  const rows = getSqliteDb()
    .prepare("SELECT id, materialId, model, dimensions, vector, updatedAt FROM embeddings WHERE model = ?")
    .iterate(config.ragEmbeddingModel) as Iterable<{
    id: string;
    materialId: string;
    model: string;
    dimensions: number;
    vector: Buffer | Uint8Array;
    updatedAt: string;
  }>;

  for (const row of rows) {
    const unit = unitById.get(row.id);
    if (!unit) continue;
    const embedding: RagEmbeddingRecord = {
      id: row.id,
      materialId: row.materialId,
      model: row.model,
      dimensions: row.dimensions,
      vector: bufferToVector(row.vector),
      updatedAt: row.updatedAt
    };
    const similarity = cosineSimilarity(queryEmbedding, embedding.vector);
    if (similarity <= 0) continue;
    scored.push({ embedding, unit, similarity });
    scored.sort((a, b) => b.similarity - a.similarity);
    if (scored.length > maxCandidates) scored.pop();
  }

  return {
    units: scored.map((item) => item.unit),
    embeddings: new Map(scored.map((item) => [item.embedding.id, item.embedding]))
  };
}

function dedupeSearchResults(results: RagSearchResult[], limit: number) {
  const byCluster = new Map<string, RagSearchResult>();
  const passthrough: RagSearchResult[] = [];
  for (const result of results) {
    const clusterId = result.question?.duplicateClusterId;
    if (!clusterId) {
      passthrough.push(result);
      continue;
    }
    const previous = byCluster.get(clusterId);
    if (!previous || result.score > previous.score) byCluster.set(clusterId, result);
  }
  return [...byCluster.values(), ...passthrough].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchRag(store: Store, query: string, limit = 8): Promise<RagSearchResult[]> {
  ensureSqliteSeeded();
  const queryTokens = tokenize(query);
  const queryTags = extractTags(query);
  if (queryTokens.length === 0 && queryTags.length === 0) return [];

  let queryEmbedding: number[] | undefined;
  queryEmbedding = await embedQueryText(query);
  const ftsIds = collectFtsCandidateIds(query, limit);
  const semantic = collectSemanticCandidateIds(queryEmbedding, limit);
  const units = readSearchUnitsByIds([...ftsIds, ...semantic.ids]);
  if (units.length === 0) return [];
  const embeddings = queryEmbedding
    ? new Map([...readEmbeddingsByIds(units.map((unit) => unit.id)), ...semantic.embeddings])
    : new Map<string, RagEmbeddingRecord>();
  const idf = buildIdf(units, queryTokens);
  const queryNorm = vectorNorm(queryTokens, idf);
  const normalizedQuery = normalizeText(query);
  const queryTerms = query
    .split(/[\s,，、;；/]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  const results: RagSearchResult[] = [];
  for (const unit of units) {
    const scored = scoreUnit(unit, {
      query,
      normalizedQuery,
      queryTokens,
      queryTags,
      queryTerms,
      idf,
      queryNorm,
      queryEmbedding,
      embeddings
    });
    if (scored.score <= 0) continue;
    const chunk = unitToChunk(unit);
    results.push({
      score: scored.score,
      scoreParts: scored.scoreParts,
      matchedTags: scored.matchedTags,
      reason: buildReason(unit, scored.matchedTags, scored.scoreParts),
      material: unit.material,
      question: unit.question,
      snippet: unit.snippet,
      chunks: [
        {
          chunk,
          excerpt: makeExcerpt(unit.text, queryTokens, queryTerms),
          score: scored.score
        }
      ],
      chunk,
      excerpt: makeExcerpt(unit.text, queryTokens, queryTerms)
    });
  }

  return dedupeSearchResults(results.sort((a, b) => b.score - a.score), limit);
}

interface UnitScoreInput {
  query: string;
  normalizedQuery: string;
  queryTokens: string[];
  queryTags: string[];
  queryTerms: string[];
  idf: Map<string, number>;
  queryNorm: number;
  queryEmbedding?: number[];
  embeddings?: Map<string, RagEmbeddingRecord>;
}

function scoreUnit(unit: SearchUnit, input: UnitScoreInput) {
  const tokenSet = new Set(unit.tokens);
  const titleTokens = new Set(tokenize(unit.title));
  let dot = 0;
  let hits = 0;
  let titleHits = 0;
  for (const token of input.queryTokens) {
    if (tokenSet.has(token)) {
      const weight = input.idf.get(token) || 1;
      dot += weight * weight;
      hits += 1;
    }
    if (titleTokens.has(token)) titleHits += 1;
  }

  const unitNorm = vectorNorm(unit.tokens, input.idf);
  const cosine = input.queryNorm > 0 && unitNorm > 0 ? dot / (input.queryNorm * unitNorm) : 0;
  const text = normalizeText(unit.text);
  const title = normalizeText(unit.title);
  const filePath = normalizeText(unit.path);
  const allTags = new Set([...unit.material.tags, ...unit.tags]);
  const matchedTags = input.queryTags.filter((tag) => allTags.has(tag));
  const phraseHit = input.normalizedQuery.length >= 3 && text.includes(input.normalizedQuery);
  const titlePhraseHit = input.normalizedQuery.length >= 3 && title.includes(input.normalizedQuery);
  const pathTermHits = input.queryTerms.filter((term) => filePath.includes(normalizeText(term))).length;
  const titleTermHits = input.queryTerms.filter((term) => title.includes(normalizeText(term))).length;
  const wantsQuestion = /题|例|练|变式|作业|真题|压轴/.test(input.query);
  const wantsAnswer = /答案|解析|详解|核对/.test(input.query);
  const wantsExam = /真题|高考|中考|模拟|一模|二模/.test(input.query);
  const embedding = input.embeddings?.get(unit.id);
  const vectorSimilarity = input.queryEmbedding && embedding ? Math.max(0, cosineSimilarity(input.queryEmbedding, embedding.vector)) : 0;
  const boost = materialBoost(unit.material);
  const vectorWeight = Math.max(0, config.ragVectorWeight);
  const keywordWeight = Math.max(0, config.ragKeywordWeight);
  const hybridScale = vectorWeight > 0 && keywordWeight > 0 ? keywordWeight / Math.max(1, vectorWeight + keywordWeight) : 1;

  const role =
    (unit.type === "question" && wantsQuestion ? 16 : 0) +
    (unit.sourceKind === "exam" && wantsExam ? 14 : 0) +
    (unit.sourceKind === "mock" && wantsExam ? 10 : 0) +
    (unit.teachingRoles.some((roleItem) => input.query.includes(roleItem)) ? 8 : 0);
  const answerQualityScore =
    unit.answerQuality === "detailed_solution" ? 18 : unit.answerQuality === "solution_steps" ? 12 : unit.answerQuality === "answer_only" ? 6 : 0;
  const representativeScore = unit.type === "question" ? (unit.isClusterRepresentative ? 10 : -18) : 0;
  const versionScore = /解析版|教师版|答案|详解/.test(`${unit.title} ${unit.path}`) ? 10 : /原卷版|学生版/.test(`${unit.title} ${unit.path}`) ? -6 : 0;

  const scoreParts: RagScoreParts = {
    lexical: cosine * 100,
    coverage: input.queryTokens.length > 0 ? (hits / input.queryTokens.length) * 24 : 0,
    title: titleHits * 7 + titleTermHits * 8 + (titlePhraseHit ? 30 : 0),
    path: pathTermHits * 5,
    tags: matchedTags.length * 12,
    role,
    phrase: phraseHit ? 20 : 0,
    answer: (unit.hasAnswer && wantsAnswer ? 12 : 0) + answerQualityScore + representativeScore + versionScore,
    vector: vectorSimilarity * vectorWeight,
    boost
  };
  const keywordScore = Object.entries(scoreParts)
    .filter(([key]) => key !== "vector" && key !== "boost")
    .reduce((sum, [, value]) => sum + value, 0);
  const score = keywordScore * hybridScale + scoreParts.vector + scoreParts.boost;
  return {
    score: Math.round(score * 100) / 100,
    scoreParts: roundScoreParts(scoreParts),
    matchedTags
  };
}

function unitToChunk(unit: SearchUnit): RagChunk & { tags?: string[]; summary?: string; context?: string } {
  return {
    id: unit.id,
    materialId: unit.material.id,
    path: unit.path,
    title: unit.title,
    index: unit.question?.index ?? unit.snippet?.index ?? 0,
    text: unit.question?.text || unit.snippet?.text || unit.text,
    tokens: unit.tokens,
    tags: unit.tags,
    summary: unit.context,
    context: unit.context
  };
}

function roundScoreParts(parts: RagScoreParts): RagScoreParts {
  return Object.fromEntries(
    Object.entries(parts).map(([key, value]) => [key, Math.round(value * 100) / 100])
  ) as unknown as RagScoreParts;
}

function buildReason(unit: SearchUnit, matchedTags: string[], parts: RagScoreParts) {
  const reasons: string[] = [];
  if (unit.type === "question") reasons.push("题目级命中");
  if (unit.question?.hasAnswer) reasons.push("带答案/解析");
  if (unit.question?.sourceKind === "exam") reasons.push("真题来源候选");
  if (unit.question?.sourceKind === "mock") reasons.push("模考来源候选");
  if (matchedTags.length > 0) reasons.push(`匹配标签：${matchedTags.slice(0, 6).join("、")}`);
  if (parts.title > 0) reasons.push("标题命中课程关键词");
  if (parts.path > 0) reasons.push("路径命中课程关键词");
  if (parts.role > 0) reasons.push("教学角色适合本课");
  if (parts.vector > 0) reasons.push("语义向量相近");
  if (parts.boost > 0) reasons.push("重点资料加权");
  if (parts.lexical > 0 || parts.coverage > 0) reasons.push("正文包含相关概念");
  return reasons.length > 0 ? reasons.join("；") : `候选资料：${unit.title}`;
}

function buildIdf(units: SearchUnit[], queryTokens: string[]) {
  const wanted = new Set(queryTokens);
  const df = new Map<string, number>();
  for (const unit of units) {
    const seen = new Set(unit.tokens.filter((token) => wanted.has(token)));
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
  }

  const idf = new Map<string, number>();
  const total = Math.max(1, units.length);
  for (const token of wanted) {
    idf.set(token, Math.log((total + 1) / ((df.get(token) || 0) + 1)) + 1);
  }
  return idf;
}

function vectorNorm(tokens: string[], idf: Map<string, number>) {
  let sum = 0;
  const seen = new Set(tokens);
  for (const token of seen) {
    const weight = idf.get(token);
    if (weight) sum += weight * weight;
  }
  return Math.sqrt(sum);
}

function makeExcerpt(text: string, queryTokens: string[], queryTerms: string[] = []) {
  const lower = text.toLowerCase();
  const tokenHit = queryTokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const termHit = queryTerms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const hit = tokenHit ?? termHit ?? 0;
  const start = Math.max(0, hit - 140);
  return text.slice(start, start + 520).trim();
}

function buildCourseQuery(course: Course) {
  return [
    course.stage,
    course.grade,
    course.province,
    course.textbook,
    course.lessonKind,
    course.desiredContent,
    course.localFiles
  ]
    .filter(Boolean)
    .join(" ");
}

function buildExpandedQueries(course: Course) {
  const base = buildCourseQuery(course);
  const topic = [course.stage, course.grade, course.desiredContent].filter(Boolean).join(" ");
  const exam = [course.province, course.stage?.includes("初") ? "中考 真题 模拟" : "高考 真题 模拟", course.desiredContent].filter(Boolean).join(" ");
  const roles =
    course.type === "trial"
      ? `${course.desiredContent} 诊断 例题 同类验证 变式 作业`
      : `${course.desiredContent} 诊断 例题 指导练习 独立变式 巩固 作业`;
  return unique([base, topic, exam, roles].filter((query) => query.trim().length > 0));
}

function mergeSearchResults(resultSets: RagSearchResult[][], limit: number) {
  const byId = new Map<string, RagSearchResult>();
  for (const result of resultSets.flat()) {
    const id = result.question?.id || result.snippet?.id || result.chunk.id;
    const previous = byId.get(id);
    if (!previous || result.score > previous.score) byId.set(id, result);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function diversifyResults(results: RagSearchResult[], limit: number) {
  const picked: RagSearchResult[] = [];
  const perMaterial = new Map<string, number>();
  for (const result of results) {
    const count = perMaterial.get(result.material.id) || 0;
    if (count >= 3) continue;
    picked.push(result);
    perMaterial.set(result.material.id, count + 1);
    if (picked.length >= limit) break;
  }
  if (picked.length >= limit) return picked;
  for (const result of results) {
    if (picked.includes(result)) continue;
    picked.push(result);
    if (picked.length >= limit) break;
  }
  return picked;
}

function buildCandidatePool(results: RagSearchResult[]) {
  const questionResults = diversifyResults(results.filter((result) => result.question), 24);
  const direct = questionResults.filter((result) => result.question?.teachingRoles.some((role) => ["诊断", "例题", "候选"].includes(role)));
  const variants = questionResults.filter((result) => result.question?.teachingRoles.some((role) => ["变式", "巩固"].includes(role)));
  const homework = questionResults.filter((result) => result.question?.teachingRoles.includes("作业"));
  const variantFallback = questionResults.filter((result) => !direct.slice(0, 8).includes(result));
  const homeworkFallback = questionResults.filter((result) => !direct.slice(0, 8).includes(result) && !variants.slice(0, 8).includes(result));
  return {
    direct: direct.length > 0 ? direct.slice(0, 8) : questionResults.slice(0, 8),
    variants: variants.length > 0 ? variants.slice(0, 8) : variantFallback.slice(0, 8),
    homework: homework.length > 0 ? homework.slice(0, 6) : homeworkFallback.slice(0, 6),
    reference: diversifyResults(results.filter((result) => !result.question), 6)
  };
}

export async function buildRagPlan(store: Store, course: Course, limit = 8): Promise<RagPlan> {
  const queries = buildExpandedQueries(course);
  const results = mergeSearchResults(await Promise.all(queries.map((query) => searchRag(store, query, limit + 12))), limit + 10);
  const query = buildCourseQuery(course);
  return {
    query,
    intentTags: extractTags(query),
    selected: results.slice(0, limit),
    rejected: results.slice(limit, limit + 5).map((result) => ({
      title: result.material.title,
      path: result.material.path,
      score: result.score,
      reason: `分数低于入选资料；${result.reason}`
    })),
    candidatePool: buildCandidatePool(results)
  };
}

export async function reindexMaterialRoot(
  store: Store,
  root = path.join(config.workspaceRoot, "资料库"),
  onProgress?: (progress: { total: number; processed: number; indexed: number; current: string }) => void
) {
  const resolvedRoot = assertWithinWorkspace(root);
  const candidates = listMaterialCandidates(resolvedRoot);
  clearMaterialRootIndex(store, resolvedRoot);

  const indexed: Material[] = [];
  let processed = 0;
  for (const filePath of candidates) {
    onProgress?.({ total: candidates.length, processed, indexed: indexed.length, current: filePath });
    indexed.push(await indexMaterialFile(store, filePath));
    processed += 1;
    onProgress?.({ total: candidates.length, processed, indexed: indexed.length, current: filePath });
  }
  return indexed;
}

export async function incrementalIndexMaterialRoot(
  store: Store,
  root = path.join(config.workspaceRoot, "资料库"),
  limit = Number.POSITIVE_INFINITY,
  onProgress?: (progress: { total: number; processed: number; indexed: number; current: string; remaining: number }) => void
) {
  const index = getIndex(store);
  const candidates = listMaterialCandidates(root).filter((filePath) => materialNeedsIndex(store, index, filePath));
  const selected = candidates.slice(0, Math.max(1, limit));
  const indexed: Material[] = [];
  let processed = 0;
  for (const filePath of selected) {
    onProgress?.({ total: candidates.length, processed, indexed: indexed.length, current: filePath, remaining: candidates.length - processed });
    indexed.push(await indexMaterialFile(store, filePath));
    processed += 1;
    onProgress?.({ total: candidates.length, processed, indexed: indexed.length, current: filePath, remaining: Math.max(0, candidates.length - processed) });
    await yieldToEventLoop();
  }
  return {
    indexed,
    totalCandidates: candidates.length,
    processed,
    remaining: Math.max(0, candidates.length - processed)
  };
}

export function listMaterialCandidates(root = path.join(config.workspaceRoot, "资料库")) {
  const resolvedRoot = assertWithinWorkspace(root);
  const candidates: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (supportedExtensions.has(ext)) candidates.push(fullPath);
    }
  }

  if (fs.existsSync(resolvedRoot)) walk(resolvedRoot);
  return candidates;
}
