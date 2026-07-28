#!/usr/bin/env node
/** Build the four-sheet editorial ledger with @oai/artifact-tool. */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve the bundled dependency from the caller's working directory. The
// spreadsheet skill requires that directory to contain the node_modules link
// returned by the workspace dependency loader.
const requireFromWorkingDirectory = createRequire(path.join(process.cwd(), "artifact-tool-resolver.cjs"));
const artifactToolEntry = requireFromWorkingDirectory.resolve("@oai/artifact-tool");
const { SpreadsheetFile, Workbook } = await import(pathToFileURL(artifactToolEntry).href);

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const inputPath = arg("--input");
const outputPath = arg("--output");
if (!inputPath || !outputPath) throw new Error("Usage: build_workbook.mjs --input ledger-export.json --output ledger.xlsx");

const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
const workbook = Workbook.create();
const topicSheet = workbook.worksheets.add("每日选题");
const sourceSheet = workbook.worksheets.add("信息来源");
const dedupeSheet = workbook.worksheets.add("历史去重库");
const configSheet = workbook.worksheets.add("配置与词表");

const theme = {
  header: "#1F4E78",
  headerText: "#FFFFFF",
  subheader: "#D9EAF7",
  border: "#C9D2D9",
  input: "#FFF7D6",
  muted: "#F3F5F7",
};

function safeJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function boolText(value) { return value ? "是" : "否"; }
function dateValue(value) { return value || ""; }
function excelCol(n) {
  let out = "";
  while (n > 0) { n -= 1; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

function prepareSheet(sheet, headers, rows, tableName, widths = {}) {
  const lastCol = excelCol(headers.length);
  const lastRow = Math.max(2, rows.length + 1);
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);
  sheet.getRange(`A1:${lastCol}1`).values = [headers];
  if (rows.length) sheet.getRange(`A2:${lastCol}${rows.length + 1}`).values = rows;
  else sheet.getRange(`A2:${lastCol}2`).values = [headers.map(() => "")];
  const used = sheet.getRange(`A1:${lastCol}${lastRow}`);
  used.format.font = { name: "Microsoft YaHei", size: 10, color: "#1F2933" };
  used.format.verticalAlignment = "center";
  used.format.borders = { preset: "inside", style: "thin", color: theme.border };
  used.format.wrapText = true;
  const header = sheet.getRange(`A1:${lastCol}1`);
  header.format.fill = theme.header;
  header.format.font = { name: "Microsoft YaHei", size: 10, bold: true, color: theme.headerText };
  header.format.rowHeight = 30;
  header.format.horizontalAlignment = "center";
  const table = sheet.tables.add(`A1:${lastCol}${lastRow}`, true, tableName);
  table.style = "TableStyleMedium2";
  for (let i = 1; i <= headers.length; i++) {
    const width = widths[i] || 14;
    sheet.getRange(`${excelCol(i)}:${excelCol(i)}`).format.columnWidth = width;
  }
  return { lastCol, lastRow };
}

const topicHeaders = [
  "选题ID", "发现日期", "事件时间", "首次报道时间", "行业", "公司标准名", "别名", "企业属性", "事件类型", "最新事件",
  "核心数字", "矛盾点1", "矛盾点2", "矛盾点3", "建议标题", "选题增量", "流量信号", "采访方向", "表述风险", "状态",
  "等级", "淘汰/驳回原因", "编辑反馈", "栏目", "成稿链接", "发布日期", "去重指纹", "语义摘要", "标准关键词", "相似度",
  "网易财经查重", "网易号外查重", "公众号后台查重", "新增事实", "去重结论", "人工覆盖理由", "时效", "企业主体", "事件强度", "矛盾点",
  "流量", "延展性", "证据完整度", "总分"
];
const topicRows = payload.topics.map((t) => {
  const contradictions = safeJson(t.contradictions_json);
  const aliases = safeJson(t.company_aliases_json);
  const keywords = safeJson(t.keywords_json);
  return [
    t.topic_id, dateValue(t.discovered_date), dateValue(t.event_date), dateValue(t.first_reported_at), t.industry || "", t.company, aliases.join("、"), t.company_type || "", t.event_type || "", t.latest_event,
    t.key_numbers || "", contradictions[0] || "", contradictions[1] || "", contradictions[2] || "", t.suggested_title, t.increment_text || "", t.traffic_signal || "", t.interview_direction || "", t.wording_risk || "", t.status,
    t.grade || "", t.rejection_reason || "", t.editor_feedback || "", t.channel_name || "", t.article_url || "", dateValue(t.published_date), t.fingerprint, t.semantic_summary || "", keywords.join("、"), Number(t.similarity || 0),
    t.netease_finance_check, t.netease_hao_check, t.wechat_backend_check, t.new_facts || "", t.dedupe_conclusion || "", t.override_reason || "", Number(t.score_timeliness), Number(t.score_company), Number(t.score_event), Number(t.score_contradiction),
    Number(t.score_traffic), Number(t.score_extension), Number(t.score_evidence), null
  ];
});
const topicLayout = prepareSheet(topicSheet, topicHeaders, topicRows, "DailyTopicsTable", {
  1: 22, 2: 12, 3: 12, 4: 20, 5: 10, 6: 18, 7: 16, 8: 12, 9: 14, 10: 30, 11: 22, 12: 26, 13: 26, 14: 26,
  15: 38, 16: 28, 17: 10, 18: 28, 19: 24, 20: 16, 21: 9, 22: 28, 23: 24, 24: 12, 25: 32, 26: 12, 27: 22, 28: 36,
  29: 26, 30: 10, 31: 14, 32: 14, 33: 16, 34: 28, 35: 24, 36: 28, 37: 8, 38: 10, 39: 10, 40: 10, 41: 8, 42: 10, 43: 12, 44: 10
});
if (topicRows.length) {
  topicSheet.getRange("AR2").formulas = [["=SUM(AK2:AQ2)"]];
  topicSheet.getRange(`AR2:AR${topicRows.length + 1}`).fillDown();
  topicSheet.getRange(`AD2:AD${topicRows.length + 1}`).format.numberFormat = "0.0%";
  topicSheet.getRange(`AK2:AR${topicRows.length + 1}`).format.numberFormat = "0";
  topicSheet.getRange(`B2:D${topicRows.length + 1}`).format.numberFormat = "yyyy-mm-dd";
  topicSheet.getRange(`T2:T${topicRows.length + 1}`).dataValidation = { rule: { type: "list", values: ["candidate", "needs_verification", "shortlisted", "submitted", "approved", "published", "rejected", "duplicate", "expired"] } };
  topicSheet.getRange(`U2:U${topicRows.length + 1}`).dataValidation = { rule: { type: "list", values: ["S", "A", "B", "C", "D"] } };
  topicSheet.getRange(`AR2:AR${topicRows.length + 1}`).conditionalFormats.add("colorScale", { colors: ["#F8696B", "#FFEB84", "#63BE7B"], thresholds: ["min", "50%", "max"] });
}

const sourceHeaders = ["来源ID", "选题ID", "来源名称", "类型", "等级", "原文标题", "URL", "发布时间", "抓取时间", "支持事实", "原文关键句", "文号", "交叉验证", "可直接引用"];
const sourceRows = payload.sources.map((s) => [s.source_id, s.topic_id, s.name, s.source_type || "", s.grade, s.title, s.url, dateValue(s.published_at), dateValue(s.accessed_at), s.supports || "", s.quote_text || "", s.document_no || "", boolText(s.cross_verified), boolText(s.directly_citable)]);
prepareSheet(sourceSheet, sourceHeaders, sourceRows, "SourcesTable", {1: 18, 2: 22, 3: 20, 4: 14, 5: 8, 6: 36, 7: 42, 8: 20, 9: 20, 10: 30, 11: 36, 12: 16, 13: 12, 14: 12});
if (sourceRows.length) {
  sourceSheet.getRange(`E2:E${sourceRows.length + 1}`).dataValidation = { rule: { type: "list", values: ["S", "A", "B", "C", "D"] } };
  sourceSheet.getRange(`H2:I${sourceRows.length + 1}`).format.numberFormat = "yyyy-mm-dd hh:mm";
}

const dedupeHeaders = ["选题ID", "公司标准名", "事件类型", "事件时间", "去重指纹", "语义摘要", "标准关键词", "相似选题ID", "相似度", "网易财经查重", "网易号外查重", "公众号后台查重", "新增事实", "去重结论", "人工覆盖理由", "状态"];
const dedupeRows = payload.topics.map((t) => [t.topic_id, t.company, t.event_type || "", dateValue(t.event_date), t.fingerprint, t.semantic_summary || "", safeJson(t.keywords_json).join("、"), t.similar_topic_id || "", Number(t.similarity || 0), t.netease_finance_check, t.netease_hao_check, t.wechat_backend_check, t.new_facts || "", t.dedupe_conclusion || "", t.override_reason || "", t.status]);
prepareSheet(dedupeSheet, dedupeHeaders, dedupeRows, "DedupeTable", {1: 22, 2: 18, 3: 14, 4: 12, 5: 24, 6: 38, 7: 28, 8: 22, 9: 10, 10: 14, 11: 14, 12: 16, 13: 28, 14: 26, 15: 28, 16: 18});
if (dedupeRows.length) {
  dedupeSheet.getRange(`D2:D${dedupeRows.length + 1}`).format.numberFormat = "yyyy-mm-dd";
  dedupeSheet.getRange(`I2:I${dedupeRows.length + 1}`).format.numberFormat = "0.0%";
}

const configHeaders = ["类别", "值", "说明", "权重/上限"];
const configRows = [
  ["行业", "食品、餐饮、酒水、饮料、美妆、日化、服装、医药、零售", "允许的主要行业", ""],
  ["状态", "candidate / needs_verification / shortlisted / submitted / approved / published / rejected / duplicate / expired", "选题状态机", ""],
  ["来源等级", "S / A / B / C / D", "S为原始官方，D为社交线索", ""],
  ["评分", "时效", "新闻发生与发现时效", 20], ["评分", "企业主体", "龙头、独角兽及重点主体", 15], ["评分", "事件强度", "关键动作和数字", 15],
  ["评分", "矛盾点", "2-3个可证实张力", 20], ["评分", "流量", "大众关注和传播信号", 10], ["评分", "延展性", "数据与采访空间", 10], ["评分", "证据完整度", "四天内至少1个S级来源", 10],
  ["否决项", "网易完全同题", "网易财经或网易号外已发", "直接淘汰"], ["否决项", "无法核实", "核心事实无法回溯", "直接淘汰"],
  ["否决项", "旧闻", "超过4天且无新增事实", "直接淘汰"], ["否决项", "广告化", "纯宣传无公共价值", "直接淘汰"], ["否决项", "硬黑", "结论强于证据或明显失衡", "直接淘汰"]
];
prepareSheet(configSheet, configHeaders, configRows, "ConfigTable", {1: 14, 2: 52, 3: 38, 4: 14});

for (const sheet of [topicSheet, sourceSheet, dedupeSheet, configSheet]) {
  const used = sheet.getUsedRange();
  if (used) used.format.autofitRows();
}

const inspect = await workbook.inspect({ kind: "table", range: `每日选题!A1:J${Math.min(topicRows.length + 1, 6)}`, include: "values,formulas", tableMaxRows: 6, tableMaxCols: 10 });
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
console.log(inspect.ndjson);
console.log(errors.ndjson);

await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
await fs.unlink(`${outputPath}.inspect.ndjson`).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
console.log(JSON.stringify({ topics: topicRows.length, sources: sourceRows.length, output: path.resolve(outputPath) }));
