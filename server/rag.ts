import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import JSZip from "jszip";
import { config } from "./config.js";
import { assertWithinWorkspace } from "./files.js";
import type { Material, RagChunk } from "./types.js";
import type { Store } from "./store.js";
import { decodeUploadName, hashId, nowIso, sanitizeFilename } from "./store.js";

const supportedExtensions = new Set([".md", ".markdown", ".txt", ".csv", ".docx", ".pdf", ".xlsx"]);

export interface RagSearchResult {
  score: number;
  chunk: RagChunk;
  excerpt: string;
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
    for (let i = 0; i < text.length - 1; i += 1) {
      tokens.add(text.slice(i, i + 2));
    }
    if (text.length >= 4) {
      for (let i = 0; i < text.length - 3; i += 1) {
        tokens.add(text.slice(i, i + 4));
      }
    }
  }

  return [...tokens];
}

function chunkText(text: string) {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  const chunkSize = 1600;
  const overlap = 180;

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

export async function indexMaterialFile(store: Store, filePath: string, mimeType?: string) {
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

  store.data.ragChunks = store.data.ragChunks.filter((chunk) => chunk.materialId !== id);

  let material: Material = {
    id,
    title,
    path: resolved,
    size: stat.size,
    mimeType,
    status: "indexed",
    chunkCount: 0,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };

  try {
    const ext = path.extname(resolved).toLowerCase();
    if (!supportedExtensions.has(ext)) {
      material = { ...material, status: "unsupported", error: `Unsupported file type: ${ext}` };
      store.upsertMaterial(material);
      return material;
    }

    if (stat.size > 30 * 1024 * 1024) {
      material = { ...material, status: "failed", error: "File is larger than 30MB." };
      store.upsertMaterial(material);
      return material;
    }

    const text = await extractText(resolved);
    const chunks = chunkText(text);
    const titleTokens = tokenize(title);

    const ragChunks = chunks.map((chunk, index): RagChunk => ({
      id: `${id}_${index}`,
      materialId: id,
      path: resolved,
      title,
      index,
      text: chunk,
      tokens: [...new Set([...titleTokens, ...tokenize(chunk)])]
    }));

    store.data.ragChunks.push(...ragChunks);
    material = { ...material, status: "indexed", chunkCount: ragChunks.length };
    store.upsertMaterial(material);
    return material;
  } catch (error) {
    material = {
      ...material,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      chunkCount: 0
    };
    store.upsertMaterial(material);
    return material;
  }
}

export function searchRag(store: Store, query: string, limit = 8): RagSearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const idf = buildIdf(store.data.ragChunks, queryTokens);
  const queryNorm = vectorNorm(queryTokens, idf);
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");

  const sorted = store.data.ragChunks
    .map((chunk) => {
      const tokenSet = new Set(chunk.tokens);
      const titleTokens = new Set(tokenize(chunk.title));
      let dot = 0;
      let hits = 0;
      let titleHits = 0;
      for (const token of queryTokens) {
        if (tokenSet.has(token)) {
          const weight = idf.get(token) || 1;
          dot += weight * weight;
          hits += 1;
        }
        if (titleTokens.has(token)) titleHits += 1;
      }
      if (hits === 0 && titleHits === 0) return { chunk, score: 0 };

      const chunkNorm = vectorNorm(chunk.tokens, idf);
      const cosine = queryNorm > 0 && chunkNorm > 0 ? dot / (queryNorm * chunkNorm) : 0;
      const text = chunk.text.toLowerCase().replace(/\s+/g, " ");
      const title = chunk.title.toLowerCase();
      const phraseBoost = normalizedQuery.length >= 3 && text.includes(normalizedQuery) ? 22 : 0;
      const titlePhraseBoost = normalizedQuery.length >= 3 && title.includes(normalizedQuery) ? 30 : 0;
      const coverageBoost = (hits / queryTokens.length) * 18;
      const titleBoost = titleHits * 7;
      const score = Math.round((cosine * 100 + coverageBoost + titleBoost + phraseBoost + titlePhraseBoost) * 100) / 100;
      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const scored: typeof sorted = [];
  const selectedChunkIds = new Set<string>();
  const selectedMaterialIds = new Set<string>();
  for (const item of sorted) {
    if (scored.length >= limit) break;
    if (selectedMaterialIds.has(item.chunk.materialId)) continue;
    scored.push(item);
    selectedChunkIds.add(item.chunk.id);
    selectedMaterialIds.add(item.chunk.materialId);
  }
  for (const item of sorted) {
    if (scored.length >= limit) break;
    if (selectedChunkIds.has(item.chunk.id)) continue;
    scored.push(item);
  }

  return scored.map(({ chunk, score }) => ({
    score,
    chunk,
    excerpt: makeExcerpt(chunk.text, queryTokens)
  }));
}

function buildIdf(chunks: RagChunk[], queryTokens: string[]) {
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

function makeExcerpt(text: string, queryTokens: string[]) {
  const lower = text.toLowerCase();
  const hit = queryTokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 120);
  return text.slice(start, start + 360).trim();
}

export async function reindexMaterialRoot(store: Store, root = path.join(config.workspaceRoot, "资料库")) {
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
      if (supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
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
  store.data.ragChunks = store.data.ragChunks.filter((chunk) => !materialIdsToClear.has(chunk.materialId));
  store.save();

  const indexed: Material[] = [];
  for (const filePath of candidates) {
    indexed.push(await indexMaterialFile(store, filePath));
  }
  return indexed;
}
