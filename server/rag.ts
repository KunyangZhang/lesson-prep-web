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

const indexVersion = 1;
const ragIndexPath = path.join(config.dataDir, "rag-index.json");
const supportedExtensions = new Set([".md", ".markdown", ".txt", ".csv", ".docx", ".pdf", ".xlsx"]);
const conversionExtensions = new Set([".doc"]);

type RagMaterialStatus = Material["status"] | "needs_conversion";

interface RagIndexedMaterial {
  id: string;
  title: string;
  path: string;
  size: number;
  mtimeMs: number;
  mimeType?: string;
  status: RagMaterialStatus;
  chunkCount: number;
  error?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface RagIndexedChunk extends RagChunk {
  summary: string;
  tags: string[];
}

interface RagIndexDb {
  version: number;
  updatedAt: string;
  materials: RagIndexedMaterial[];
  chunks: RagIndexedChunk[];
}

export interface RagScoreParts {
  lexical: number;
  coverage: number;
  title: number;
  path: number;
  tags: number;
  role: number;
  phrase: number;
}

export interface RagSearchResult {
  score: number;
  scoreParts: RagScoreParts;
  matchedTags: string[];
  reason: string;
  material: RagIndexedMaterial;
  chunks: Array<{
    chunk: RagIndexedChunk;
    excerpt: string;
    score: number;
  }>;
  chunk: RagIndexedChunk;
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

function emptyIndex(): RagIndexDb {
  return {
    version: indexVersion,
    updatedAt: nowIso(),
    materials: [],
    chunks: []
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
  return [...tags];
}

function chunkText(text: string) {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  const chunkSize = 1600;
  const overlap = 180;

  for (let start = 0; start < normalized.length && chunks.length < 160; start += chunkSize - overlap) {
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
    return {
      version: parsed.version || indexVersion,
      updatedAt: parsed.updatedAt || nowIso(),
      materials: Array.isArray(parsed.materials) ? parsed.materials : [],
      chunks: Array.isArray(parsed.chunks) ? parsed.chunks : []
    };
  } catch {
    return emptyIndex();
  }
}

function legacyIndexFromStore(store: Store): RagIndexDb {
  if (store.data.ragChunks.length === 0) return emptyIndex();
  const materialById = new Map(store.data.materials.map((material) => [material.id, material]));
  const chunks: RagIndexedChunk[] = store.data.ragChunks.map((chunk) => {
    const tags = extractTags(chunk.title, chunk.path, chunk.text.slice(0, 4000));
    return {
      ...chunk,
      summary: chunk.text.slice(0, 240).trim(),
      tags
    };
  });
  const chunkCounts = new Map<string, number>();
  for (const chunk of chunks) chunkCounts.set(chunk.materialId, (chunkCounts.get(chunk.materialId) || 0) + 1);
  const materials: RagIndexedMaterial[] = [...chunkCounts.entries()].map(([materialId, chunkCount]) => {
    const material = materialById.get(materialId);
    const firstChunk = chunks.find((chunk) => chunk.materialId === materialId);
    const stat = firstChunk && fs.existsSync(firstChunk.path) ? fs.statSync(firstChunk.path) : null;
    const tags = extractTags(material?.title || firstChunk?.title || "", firstChunk?.path || "", firstChunk?.text.slice(0, 4000) || "");
    return {
      id: materialId,
      title: material?.title || firstChunk?.title || "未知资料",
      path: material?.path || firstChunk?.path || "",
      size: material?.size || stat?.size || 0,
      mtimeMs: stat?.mtimeMs || 0,
      mimeType: material?.mimeType,
      status: material?.status || "indexed",
      chunkCount,
      error: material?.error,
      tags,
      createdAt: material?.createdAt || nowIso(),
      updatedAt: material?.updatedAt || nowIso()
    };
  });
  return {
    version: indexVersion,
    updatedAt: nowIso(),
    materials,
    chunks
  };
}

function saveIndex(index: RagIndexDb) {
  index.version = indexVersion;
  index.updatedAt = nowIso();
  fs.mkdirSync(path.dirname(ragIndexPath), { recursive: true });
  const tmpPath = `${ragIndexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmpPath, ragIndexPath);
}

function getIndex(store: Store) {
  if (cachedIndex) return cachedIndex;
  cachedIndex = readIndexFromDisk() || legacyIndexFromStore(store);
  if (!fs.existsSync(ragIndexPath) && cachedIndex.chunks.length > 0) saveIndex(cachedIndex);
  return cachedIndex;
}

export function clearRagIndexCache() {
  cachedIndex = null;
}

function removeIndexedMaterial(index: RagIndexDb, id: string) {
  index.materials = index.materials.filter((material) => material.id !== id);
  index.chunks = index.chunks.filter((chunk) => chunk.materialId !== id);
}

function compactLegacyRagChunks(store: Store) {
  if (store.data.ragChunks.length === 0) return;
  store.data.ragChunks = [];
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
    error: material.error,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt
  } as Material;
}

export function getRagStats(store: Store) {
  const index = getIndex(store);
  return {
    materials: index.materials.length,
    indexedMaterials: index.materials.filter((material) => material.status === "indexed").length,
    needsConversionMaterials: index.materials.filter((material) => material.status === "needs_conversion").length,
    failedMaterials: index.materials.filter((material) => material.status === "failed").length,
    unsupportedMaterials: index.materials.filter((material) => material.status === "unsupported").length,
    pendingMaterials: store.data.materials.filter((material) => material.status === "pending").length,
    chunks: index.chunks.length,
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
  store.data.ragChunks = store.data.ragChunks.filter((chunk) => chunk.materialId !== materialId);
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
    error: conversionExtensions.has(ext) ? "旧版 .doc 暂不解析正文，请转换为 .docx 后重建索引。" : "已上传，等待重建索引。",
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
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
    error,
    tags: extractTags(title, resolved),
    createdAt: previous?.createdAt || previousIndexed?.createdAt || now,
    updatedAt: now
  };
  store.data.ragChunks = store.data.ragChunks.filter((chunk) => chunk.materialId !== id);
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
  store.data.ragChunks = store.data.ragChunks.filter((chunk) => !removedMaterialIds.has(chunk.materialId));
  index.materials = index.materials.filter((material) => !removedMaterialIds.has(material.id));
  index.chunks = index.chunks.filter((chunk) => !removedMaterialIds.has(chunk.materialId));
  store.save();
  saveIndex(index);
  return {
    path: resolved,
    removedMaterials: removedMaterialIds.size
  };
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
    tags: extractTags(title, resolved),
    createdAt: previous?.createdAt || previousIndexed?.createdAt || now,
    updatedAt: now
  };

  function persistMaterial(nextMaterial: RagIndexedMaterial, nextChunks: RagIndexedChunk[] = []) {
    store.data.ragChunks = store.data.ragChunks.filter((chunk) => chunk.materialId !== id);
    removeIndexedMaterial(index, id);
    index.materials.push(nextMaterial);
    index.chunks.push(...nextChunks);
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
      const chunk: RagIndexedChunk = {
        id: `${id}_0`,
        materialId: id,
        path: resolved,
        title,
        index: 0,
        text: metadataText,
        summary: metadataText,
        tags: materialTags,
        tokens: unique([...tokenize(title), ...tokenize(resolved), ...tokenize(materialTags.join(" "))])
      };
      index.chunks.push(chunk);
      material = {
        ...material,
        status: "indexed",
        chunkCount: 1,
        tags: materialTags,
        error: `文件超过 ${Math.round(config.ragMaxParseBytes / 1024 / 1024)}MB，仅索引文件名和路径，未解析正文。`
      };
      return persistMaterial(material, [chunk]);
    }

    const text = await extractText(resolved);
    const chunks = chunkText(text);
    const materialTags = extractTags(title, resolved, text.slice(0, 6000));
    const titleTokens = tokenize(`${title} ${materialTags.join(" ")}`);

    const ragChunks = chunks.map((chunk, chunkIndex): RagIndexedChunk => {
      const tags = extractTags(title, resolved, chunk);
      return {
        id: `${id}_${chunkIndex}`,
        materialId: id,
        path: resolved,
        title,
        index: chunkIndex,
        text: chunk,
        summary: chunk.slice(0, 240).trim(),
        tags,
        tokens: unique([...titleTokens, ...tokenize(chunk), ...tokenize(tags.join(" "))])
      };
    });

    material = { ...material, status: "indexed", chunkCount: ragChunks.length, tags: materialTags };
    return persistMaterial(material, ragChunks);
  } catch (error) {
    material = {
      ...material,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      chunkCount: 0
    };
    return persistMaterial(material);
  }
}

export function searchRag(store: Store, query: string, limit = 8): RagSearchResult[] {
  const index = getIndex(store);
  const queryTokens = tokenize(query);
  const queryTags = extractTags(query);
  if (queryTokens.length === 0 && queryTags.length === 0) return [];

  const idf = buildIdf(index.chunks, queryTokens);
  const queryNorm = vectorNorm(queryTokens, idf);
  const normalizedQuery = normalizeText(query);
  const queryTerms = query
    .split(/[\s,，、;；/]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  const materialById = new Map(index.materials.map((material) => [material.id, material]));
  const byMaterial = new Map<string, Array<{ chunk: RagIndexedChunk; score: number; scoreParts: RagScoreParts; matchedTags: string[] }>>();

  for (const chunk of index.chunks) {
    const material = materialById.get(chunk.materialId);
    if (!material || material.status !== "indexed") continue;
    const scored = scoreChunk(chunk, material, {
      query,
      normalizedQuery,
      queryTokens,
      queryTags,
      queryTerms,
      idf,
      queryNorm
    });
    if (scored.score <= 0) continue;
    const current = byMaterial.get(chunk.materialId) || [];
    current.push({ chunk, ...scored });
    byMaterial.set(chunk.materialId, current);
  }

  const results = [...byMaterial.entries()]
    .map(([materialId, chunks]) => {
      const material = materialById.get(materialId);
      if (!material) return null;
      const sortedChunks = chunks.sort((a, b) => b.score - a.score).slice(0, 3);
      const best = sortedChunks[0];
      const materialScore = Math.round((best.score + Math.min(12, (chunks.length - 1) * 1.5)) * 100) / 100;
      const matchedTags = unique(sortedChunks.flatMap((item) => item.matchedTags));
      return {
        score: materialScore,
        scoreParts: best.scoreParts,
        matchedTags,
        reason: buildReason(material, matchedTags, best.scoreParts),
        material,
        chunks: sortedChunks.map((item) => ({
          chunk: item.chunk,
          excerpt: makeExcerpt(item.chunk.text, queryTokens, queryTerms),
          score: Math.round(item.score * 100) / 100
        })),
        chunk: best.chunk,
        excerpt: makeExcerpt(best.chunk.text, queryTokens, queryTerms)
      };
    })
    .filter((item): item is RagSearchResult => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results;
}

interface ChunkScoreInput {
  query: string;
  normalizedQuery: string;
  queryTokens: string[];
  queryTags: string[];
  queryTerms: string[];
  idf: Map<string, number>;
  queryNorm: number;
}

function scoreChunk(chunk: RagIndexedChunk, material: RagIndexedMaterial, input: ChunkScoreInput) {
  const tokenSet = new Set(chunk.tokens);
  const titleTokens = new Set(tokenize(material.title));
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

  const chunkNorm = vectorNorm(chunk.tokens, input.idf);
  const cosine = input.queryNorm > 0 && chunkNorm > 0 ? dot / (input.queryNorm * chunkNorm) : 0;
  const text = normalizeText(chunk.text);
  const title = normalizeText(material.title);
  const filePath = normalizeText(material.path);
  const materialTags = new Set([...material.tags, ...chunk.tags]);
  const matchedTags = input.queryTags.filter((tag) => materialTags.has(tag));
  const phraseHit = input.normalizedQuery.length >= 3 && text.includes(input.normalizedQuery);
  const titlePhraseHit = input.normalizedQuery.length >= 3 && title.includes(input.normalizedQuery);
  const pathTermHits = input.queryTerms.filter((term) => filePath.includes(normalizeText(term))).length;
  const titleTermHits = input.queryTerms.filter((term) => title.includes(normalizeText(term))).length;
  const wantsOriginal = /原卷|试题|无答案/.test(input.query);

  const scoreParts: RagScoreParts = {
    lexical: cosine * 100,
    coverage: input.queryTokens.length > 0 ? (hits / input.queryTokens.length) * 22 : 0,
    title: titleHits * 7 + titleTermHits * 8 + (titlePhraseHit ? 30 : 0),
    path: pathTermHits * 5,
    tags: matchedTags.length * 12,
    role: roleBoost(material.tags, wantsOriginal),
    phrase: phraseHit ? 20 : 0
  };
  const score = Object.values(scoreParts).reduce((sum, value) => sum + value, 0);
  return {
    score: Math.round(score * 100) / 100,
    scoreParts: roundScoreParts(scoreParts),
    matchedTags
  };
}

function roleBoost(tags: string[], wantsOriginal: boolean) {
  if (wantsOriginal && tags.includes("原卷版")) return 12;
  if (wantsOriginal && tags.includes("解析版")) return -4;
  let boost = 0;
  if (tags.includes("解析版")) boost += 8;
  if (tags.includes("讲义")) boost += 5;
  if (tags.includes("专题") || tags.includes("重难点突破") || tags.includes("拔高点突破")) boost += 4;
  return boost;
}

function roundScoreParts(parts: RagScoreParts): RagScoreParts {
  return Object.fromEntries(
    Object.entries(parts).map(([key, value]) => [key, Math.round(value * 100) / 100])
  ) as unknown as RagScoreParts;
}

function buildReason(material: RagIndexedMaterial, matchedTags: string[], parts: RagScoreParts) {
  const reasons: string[] = [];
  if (matchedTags.length > 0) reasons.push(`匹配标签：${matchedTags.slice(0, 6).join("、")}`);
  if (parts.title > 0) reasons.push("标题命中课程关键词");
  if (parts.path > 0) reasons.push("路径命中课程关键词");
  if (parts.role > 0) reasons.push("资料角色适合备课使用");
  if (parts.lexical > 0 || parts.coverage > 0) reasons.push("正文片段包含相关概念");
  return reasons.length > 0 ? reasons.join("；") : `候选资料：${material.title}`;
}

function buildIdf(chunks: RagIndexedChunk[], queryTokens: string[]) {
  const wanted = new Set(queryTokens);
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const seen = new Set(chunk.tokens.filter((token) => wanted.has(token)));
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
  }

  const idf = new Map<string, number>();
  const total = Math.max(1, chunks.length);
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
  const start = Math.max(0, hit - 120);
  return text.slice(start, start + 420).trim();
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

export function buildRagPlan(store: Store, course: Course, limit = 8): RagPlan {
  const query = buildCourseQuery(course);
  const results = searchRag(store, query, limit + 5);
  return {
    query,
    intentTags: extractTags(query),
    selected: results.slice(0, limit),
    rejected: results.slice(limit, limit + 5).map((result) => ({
      title: result.material.title,
      path: result.material.path,
      score: result.score,
      reason: `分数低于入选资料；${result.reason}`
    }))
  };
}

export async function reindexMaterialRoot(
  store: Store,
  root = path.join(config.workspaceRoot, "资料库"),
  onProgress?: (progress: { total: number; processed: number; indexed: number; current: string }) => void
) {
  const index = getIndex(store);
  const resolvedRoot = assertWithinWorkspace(root);
  const candidates: string[] = [];

  function walk(dir: string) {
    if (candidates.length >= config.ragMaxReindexFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (supportedExtensions.has(ext) || conversionExtensions.has(ext)) {
        candidates.push(fullPath);
        if (candidates.length >= config.ragMaxReindexFiles) return;
      }
    }
  }

  walk(resolvedRoot);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const materialIdsToClear = new Set(
    store.data.materials
      .filter((material) => material.path === resolvedRoot || material.path.startsWith(rootWithSep))
      .map((material) => material.id)
  );
  store.data.materials = store.data.materials.filter((material) => !materialIdsToClear.has(material.id));
  compactLegacyRagChunks(store);
  index.materials = index.materials.filter((material) => material.path !== resolvedRoot && !material.path.startsWith(rootWithSep));
  index.chunks = index.chunks.filter((chunk) => chunk.path !== resolvedRoot && !chunk.path.startsWith(rootWithSep));
  store.save();
  saveIndex(index);

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
