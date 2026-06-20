import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import JSZip from "jszip";
import { config, materialRoot, uploadRoot } from "./config.js";
import { assertWithinWorkspace } from "./files.js";
import type { Course, Material, RagChunk } from "./types.js";
import type { Store } from "./store.js";
import { decodeUploadName, hashId, nowIso, sanitizeFilename } from "./store.js";

const indexVersion = 2;
const ragIndexPath = path.join(config.dataDir, "rag-index.json");
const supportedExtensions = new Set([".md", ".markdown", ".txt", ".csv", ".docx", ".pdf", ".xlsx"]);
const conversionExtensions = new Set([".doc"]);

type RagMaterialStatus = Material["status"] | "needs_conversion";
type RagSourceKind = "exam" | "mock" | "local" | "adapted" | "self_written" | "unknown";
type RagSnippetKind = "knowledge" | "answer" | "metadata" | "chunk";

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
}

interface RagIndexDb {
  version: number;
  updatedAt: string;
  materials: RagIndexedMaterial[];
  questions: RagQuestionRecord[];
  snippets: RagSnippetRecord[];
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

  for (let start = 0; start < normalized.length && chunks.length < 120; start += chunkSize - overlap) {
    chunks.push(normalized.slice(start, start + chunkSize));
  }

  return chunks.filter((chunk) => chunk.trim().length > 8);
}

async function extractText(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".markdown", ".txt", ".csv"].includes(ext)) {
    return fs.promises.readFile(filePath, "utf8");
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === ".pdf") {
    const buffer = await fs.promises.readFile(filePath);
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === ".xlsx") {
    return extractXlsxText(filePath);
  }

  throw new Error(`Unsupported file type: ${ext || "unknown"}`);
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

function saveIndex(index: RagIndexDb) {
  index.version = indexVersion;
  index.updatedAt = nowIso();
  fs.mkdirSync(path.dirname(ragIndexPath), { recursive: true });
  const tmpPath = `${ragIndexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmpPath, ragIndexPath);
  cachedSearchCache = null;
}

function getIndex(_store: Store) {
  if (cachedIndex) return cachedIndex;
  cachedIndex = readIndexFromDisk() || emptyIndex();
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
  return {
    materials: index.materials.length,
    indexedMaterials: index.materials.filter((material) => material.status === "indexed").length,
    needsConversionMaterials: index.materials.filter((material) => material.status === "needs_conversion").length,
    failedMaterials: index.materials.filter((material) => material.status === "failed").length,
    unsupportedMaterials: index.materials.filter((material) => material.status === "unsupported").length,
    pendingMaterials: store.data.materials.filter((material) => material.status === "pending").length,
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
  if (conversionExtensions.has(ext)) return material?.status !== "needs_conversion";
  if (!supportedExtensions.has(ext)) return material?.status !== "unsupported";
  if (!material || material.status === "pending") return true;
  if (material.status === "failed") {
    return indexed?.size !== stat.size || Math.abs((indexed?.mtimeMs || 0) - stat.mtimeMs) > 1;
  }
  if (!indexed || indexed.status !== "indexed" || indexed.chunkCount === 0) return true;
  return indexed.size !== stat.size || Math.abs((indexed.mtimeMs || 0) - stat.mtimeMs) > 1;
}

export function listMaterialFilesNeedingIndex(store: Store, root = path.join(config.workspaceRoot, "资料库")) {
  const index = getIndex(store);
  return listMaterialCandidates(root).filter((filePath) => materialNeedsIndex(store, index, filePath));
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
    status: conversionExtensions.has(ext) ? "needs_conversion" : "pending",
    chunkCount: 0,
    questionCount: 0,
    snippetCount: 0,
    error: conversionExtensions.has(ext) ? "旧版 .doc 暂不解析正文，请转换为 .docx 后重建索引。" : "已上传，等待重建索引。",
    createdAt: previous?.createdAt || now,
    updatedAt: now
  } as Material;
  store.upsertMaterial(material);
  return material;
}

export function markMaterialIndexFailed(store: Store, filePath: string, error: string, mimeType?: string) {
  const index = getIndex(store);
  const resolved = assertWithinWorkspace(filePath);
  const stat = fs.statSync(resolved);
  const id = hashId(resolved.toLowerCase());
  const title = decodeUploadName(path.basename(resolved));
  const previous = store.data.materials.find((material) => material.id === id);
  const previousIndexed = index.materials.find((material) => material.id === id);
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
  removeIndexedMaterial(index, id);
  index.materials.push(material);
  store.upsertMaterial(toPublicMaterial(material));
  saveIndex(index);
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
    /(?:^|\n)\s*(?:[【[(（]?\s*)((?:第\s*[一二三四五六七八九十百\d]+\s*题)|(?:例题?\s*[一二三四五六七八九十百\d]+)|(?:变式\s*[一二三四五六七八九十百\d]+)|(?:练习\s*[一二三四五六七八九十百\d]+)|(?:作业\s*[一二三四五六七八九十百\d]+)|(?:\d{1,3}[.．、]\s*)|(?:[①②③④⑤⑥⑦⑧⑨⑩]))(?:\s*[】\])）])?/g;
  return [...text.matchAll(pattern)].map((match) => ({
    label: match[1].trim().replace(/\s+/g, ""),
    start: match.index || 0
  }));
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
  const candidates = blocks.filter((item) => item.block.length >= 30);

  return candidates.map((item, index): RagQuestionRecord => {
    const split = splitQuestionAnswer(item.block);
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
      split.solution ? "已有答案或解析" : "未检测到答案解析，备课时需独立验算"
    ]
      .filter(Boolean)
      .join("；");

    const tokenText = `${context}\n${split.prompt}\n${split.solution}\n${tags.join(" ")}`;
    return {
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
      hasAnswer: Boolean(split.solution)
    };
  });
}

function buildSnippetRecords(material: RagIndexedMaterial, text: string) {
  const materialTags = extractTags(material.title, material.path, text.slice(0, 6000));
  return chunkText(text).map((chunk, index): RagSnippetRecord => {
    const tags = extractTags(material.title, material.path, chunk);
    const kind: RagSnippetKind = /答案|解析|解答/.test(chunk) ? "answer" : /定义|性质|方法|模板|知识点|易错/.test(chunk) ? "knowledge" : "chunk";
    const context = [
      `资料：${material.title}`,
      `片段类型：${kind}`,
      tags.length > 0 ? `标签：${tags.join("、")}` : "",
      materialTags.length > 0 ? `资料标签：${materialTags.join("、")}` : ""
    ]
      .filter(Boolean)
      .join("；");
    return {
      id: `${material.id}_s${index}`,
      materialId: material.id,
      path: material.path,
      title: material.title,
      index,
      kind,
      text: chunk,
      context,
      tags,
      tokens: unique([...tokenize(context), ...tokenize(chunk), ...tokenize(material.title), ...tokenize(material.path)])
    };
  });
}

export async function indexMaterialFile(store: Store, filePath: string, mimeType?: string) {
  const index = getIndex(store);
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
  const previousIndexed = index.materials.find((material) => material.id === id);
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

  function persistMaterial(nextMaterial: RagIndexedMaterial, questions: RagQuestionRecord[] = [], snippets: RagSnippetRecord[] = []) {
    store.data.ragChunks = [];
    removeIndexedMaterial(index, id);
    index.materials.push(nextMaterial);
    index.questions.push(...questions);
    index.snippets.push(...snippets);
    store.upsertMaterial(toPublicMaterial(nextMaterial));
    saveIndex(index);
    return toPublicMaterial(nextMaterial);
  }

  try {
    if (conversionExtensions.has(ext)) {
      material = {
        ...material,
        status: "needs_conversion",
        error: "旧版 .doc 暂不解析正文，请转换为 .docx 后重建索引。"
      };
      return persistMaterial(material);
    }

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
        tokens: unique([...tokenize(title), ...tokenize(resolved), ...tokenize(materialTags.join(" "))])
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
      return persistMaterial(material, [], [snippet]);
    }

    const text = await extractText(resolved);
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
    return persistMaterial(material, questions, snippets);
  } catch (error) {
    material = {
      ...material,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
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
      sourceKind: question.sourceKind
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
      sourceKind: detectSourceKind(snippet.title, snippet.path, snippet.text)
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

export function searchRag(store: Store, query: string, limit = 8): RagSearchResult[] {
  const index = getIndex(store);
  const cache = getSearchCache(index);
  const queryTokens = tokenize(query);
  const queryTags = extractTags(query);
  if ((queryTokens.length === 0 && queryTags.length === 0) || cache.units.length === 0) return [];

  const units = collectCandidateUnits(cache, queryTokens, queryTags, limit);
  if (units.length === 0) return [];
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
      queryNorm
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

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

interface UnitScoreInput {
  query: string;
  normalizedQuery: string;
  queryTokens: string[];
  queryTags: string[];
  queryTerms: string[];
  idf: Map<string, number>;
  queryNorm: number;
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

  const role =
    (unit.type === "question" && wantsQuestion ? 16 : 0) +
    (unit.sourceKind === "exam" && wantsExam ? 14 : 0) +
    (unit.sourceKind === "mock" && wantsExam ? 10 : 0) +
    (unit.teachingRoles.some((roleItem) => input.query.includes(roleItem)) ? 8 : 0);

  const scoreParts: RagScoreParts = {
    lexical: cosine * 100,
    coverage: input.queryTokens.length > 0 ? (hits / input.queryTokens.length) * 24 : 0,
    title: titleHits * 7 + titleTermHits * 8 + (titlePhraseHit ? 30 : 0),
    path: pathTermHits * 5,
    tags: matchedTags.length * 12,
    role,
    phrase: phraseHit ? 20 : 0,
    answer: unit.hasAnswer && wantsAnswer ? 12 : unit.hasAnswer && unit.type === "question" ? 4 : 0
  };
  const score = Object.values(scoreParts).reduce((sum, value) => sum + value, 0);
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
    course.localFiles,
    course.notes
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

export function buildRagPlan(store: Store, course: Course, limit = 8): RagPlan {
  const queries = buildExpandedQueries(course);
  const results = mergeSearchResults(queries.map((query) => searchRag(store, query, limit + 12)), limit + 10);
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
      if (supportedExtensions.has(ext) || conversionExtensions.has(ext)) candidates.push(fullPath);
    }
  }

  if (fs.existsSync(resolvedRoot)) walk(resolvedRoot);
  return candidates;
}
