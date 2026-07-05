import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = process.argv[2] || path.join(process.cwd(), "data", "rag-index.sqlite");
const limit = Number(process.env.RAG_AUDIT_LIMIT || 30);
const focusPatterns = [
  /第43讲|数列的通项公式/,
  /第10讲|对数与对数函数/,
  /第33讲|新定义压轴题/
];

function metricsForText(text) {
  const nonWhitespaceLength = text.replace(/\s/g, "").length;
  const formulaCount = (text.match(/\[公式\]/g) || []).length;
  const imageCount = (text.match(/\[图片\]/g) || []).length;
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return {
    nonWhitespaceLength,
    formulaCount,
    imageCount,
    chineseCount,
    formulaCharRatio: (formulaCount * "[公式]".length) / Math.max(1, nonWhitespaceLength),
    chineseRatio: chineseCount / Math.max(1, nonWhitespaceLength)
  };
}

function round(value) {
  return Math.round(value * 10000) / 100;
}

function materialKey(row) {
  return row.materialId;
}

function getMaterial(stats, row) {
  const key = materialKey(row);
  let material = stats.get(key);
  if (!material) {
    material = {
      id: row.materialId,
      title: "",
      path: "",
      status: "",
      questionRows: 0,
      snippetRows: 0,
      rows: 0,
      formulaCount: 0,
      imageCount: 0,
      nonWhitespaceLength: 0,
      chineseCount: 0,
      allFormulaRows: 0,
      maxFormulaCharRatio: 0,
      worstRow: ""
    };
    stats.set(key, material);
  }
  return material;
}

function addRecord(material, kind, text, rowId) {
  const metrics = metricsForText(text);
  material.rows += 1;
  if (kind === "question") material.questionRows += 1;
  if (kind === "snippet") material.snippetRows += 1;
  material.formulaCount += metrics.formulaCount;
  material.imageCount += metrics.imageCount;
  material.nonWhitespaceLength += metrics.nonWhitespaceLength;
  material.chineseCount += metrics.chineseCount;
  if (metrics.formulaCount > 0 && metrics.formulaCharRatio >= 0.8) material.allFormulaRows += 1;
  if (metrics.formulaCharRatio > material.maxFormulaCharRatio) {
    material.maxFormulaCharRatio = metrics.formulaCharRatio;
    material.worstRow = `${kind}:${rowId}`;
  }
}

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;");

const stats = new Map();
for (const row of db.prepare("SELECT id, path, status, payload FROM materials").iterate()) {
  const material = JSON.parse(row.payload);
  const item = getMaterial(stats, { materialId: row.id });
  item.title = material.title || path.basename(row.path || material.path || "");
  item.path = material.path || row.path || "";
  item.status = material.status || row.status || "";
}

for (const row of db.prepare("SELECT id, materialId, payload FROM questions").iterate()) {
  const payload = JSON.parse(row.payload);
  addRecord(getMaterial(stats, row), "question", `${payload.text || ""}\n${payload.solution || ""}`, row.id);
}

for (const row of db.prepare("SELECT id, materialId, payload FROM snippets").iterate()) {
  const payload = JSON.parse(row.payload);
  addRecord(getMaterial(stats, row), "snippet", payload.text || "", row.id);
}

const materials = [...stats.values()].map((material) => ({
  ...material,
  formulaCharRatio: material.formulaCount * "[公式]".length / Math.max(1, material.nonWhitespaceLength),
  chineseRatio: material.chineseCount / Math.max(1, material.nonWhitespaceLength)
}));

const totals = materials.reduce(
  (sum, material) => {
    sum.materials += 1;
    sum.rows += material.rows;
    sum.questionRows += material.questionRows;
    sum.snippetRows += material.snippetRows;
    sum.formulaCount += material.formulaCount;
    sum.imageCount += material.imageCount;
    sum.nonWhitespaceLength += material.nonWhitespaceLength;
    sum.chineseCount += material.chineseCount;
    return sum;
  },
  { materials: 0, rows: 0, questionRows: 0, snippetRows: 0, formulaCount: 0, imageCount: 0, nonWhitespaceLength: 0, chineseCount: 0 }
);

const sorted = materials
  .filter((material) => material.rows > 0 || material.status !== "indexed")
  .sort((a, b) => {
    if (b.formulaCharRatio !== a.formulaCharRatio) return b.formulaCharRatio - a.formulaCharRatio;
    return b.formulaCount - a.formulaCount;
  });

const focused = materials.filter((material) => focusPatterns.some((pattern) => pattern.test(`${material.title}\n${material.path}`)));
const unresolved = materials
  .filter((material) => material.status === "failed" || material.status === "needs_conversion")
  .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));

function printMaterial(material, index = 0) {
  const prefix = index > 0 ? `${String(index).padStart(2, " ")}. ` : "- ";
  console.log(
    `${prefix}${material.title} | status=${material.status || "unknown"} | rows=${material.rows} q=${material.questionRows} s=${material.snippetRows}` +
      ` | [公式]=${material.formulaCount} | formulaChars=${round(material.formulaCharRatio)}% | zh=${round(material.chineseRatio)}%` +
      ` | allFormulaRows=${material.allFormulaRows} | worst=${material.worstRow || "-"}`
  );
  console.log(`    ${material.path}`);
}

console.log("RAG formula placeholder audit");
console.log(`SQLite: ${dbPath}`);
console.log(
  `Global: materials=${totals.materials}, rows=${totals.rows}, questions=${totals.questionRows}, snippets=${totals.snippetRows}, ` +
    `[公式]=${totals.formulaCount}, [图片]=${totals.imageCount}, formulaChars=${round(totals.formulaCount * "[公式]".length / Math.max(1, totals.nonWhitespaceLength))}%, ` +
    `zh=${round(totals.chineseCount / Math.max(1, totals.nonWhitespaceLength))}%`
);

console.log(`\nTop formula-heavy materials (limit ${limit})`);
sorted.slice(0, limit).forEach((material, index) => printMaterial(material, index + 1));

console.log("\nFocused materials");
if (focused.length === 0) {
  console.log("- none matched");
} else {
  focused.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN")).forEach((material) => printMaterial(material));
}

console.log("\nUnresolved materials");
if (unresolved.length === 0) {
  console.log("- none");
} else {
  unresolved.forEach((material) => printMaterial(material));
}

db.close();
