import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Course, MemoryEntry, MemoryKind, MemoryScope, MemorySource, Student } from "./types.js";

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, 4000) : fallback;
}

function tagsOf(value: unknown) {
  const source = Array.isArray(value)
    ? value.map((item) => String(item).trim()).join(",")
    : typeof value === "string"
    ? value
    : "";
  return [
    ...new Set(
      source
        .split(/[,，、;；]/)
        .map((item) => item.replace(/^#/, "").trim())
        .filter((item) => item.length > 0 && item.length <= 32)
    )
  ].slice(0, 12);
}

function kindOf(value: unknown, fallback: MemoryKind = "note"): MemoryKind {
  const allowed: MemoryKind[] = ["learning", "preference", "insight", "requirement", "note"];
  return allowed.includes(value as MemoryKind) ? (value as MemoryKind) : fallback;
}

function scopeOf(value: unknown, fallback: MemoryScope = "student"): MemoryScope {
  const allowed: MemoryScope[] = ["student", "global", "course"];
  return allowed.includes(value as MemoryScope) ? (value as MemoryScope) : fallback;
}

function sourceOf(value: unknown, fallback: MemorySource = "manual"): MemorySource {
  const allowed: MemorySource[] = ["manual", "ai-draft", "post-class", "lesson-job", "system"];
  return allowed.includes(value as MemorySource) ? (value as MemorySource) : fallback;
}

export function listMemories(store: Store, filters: { studentId?: string; courseId?: string; kind?: string; q?: string; active?: string } = {}) {
  let result = [...store.data.memories];
  if (filters.courseId) {
    result = result.filter((memory) => memory.courseId === filters.courseId);
  } else if (filters.studentId) {
    result = result.filter((memory) => memory.studentId === filters.studentId || memory.scope === "global");
  } else {
    result = result.filter((memory) => memory.scope === "global" || memory.scope === "student");
  }
  if (filters.kind) {
    const kind = kindOf(filters.kind);
    result = result.filter((memory) => memory.kind === kind);
  }
  if (filters.active === "true") {
    result = result.filter((memory) => memory.active !== false);
  } else if (filters.active === "false") {
    result = result.filter((memory) => memory.active === false);
  }
  if (filters.q) {
    const q = filters.q.trim().toLowerCase();
    result = result.filter(
      (memory) =>
        memory.title.toLowerCase().includes(q) ||
        memory.content.toLowerCase().includes(q) ||
        memory.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }
  return result.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);
  });
}

export function createMemory(store: Store, input: Record<string, unknown>, at = nowIso()): MemoryEntry {
  const title = text(input.title);
  const content = text(input.content);
  if (!title) throw new Error("记忆标题不能为空。");
  if (!content) throw new Error("记忆内容不能为空。");

  const memory: MemoryEntry = {
    id: newId("mem"),
    scope: scopeOf(input.scope),
    studentId: text(input.studentId) || undefined,
    courseId: text(input.courseId) || undefined,
    kind: kindOf(input.kind),
    title,
    content,
    tags: tagsOf(input.tags),
    source: sourceOf(input.source),
    pinned: Boolean(input.pinned),
    active: input.active === false ? false : true,
    createdAt: at,
    updatedAt: at
  };
  store.addMemory(memory);
  return memory;
}

export function updateMemory(store: Store, id: string, input: Record<string, unknown>, at = nowIso()) {
  const memory = store.findMemory(id);
  if (!memory) return null;
  if ("title" in input) memory.title = text(input.title);
  if ("content" in input) memory.content = text(input.content);
  if ("scope" in input) memory.scope = scopeOf(input.scope);
  if ("studentId" in input) memory.studentId = text(input.studentId) || undefined;
  if ("courseId" in input) memory.courseId = text(input.courseId) || undefined;
  if ("kind" in input) memory.kind = kindOf(input.kind);
  if ("tags" in input) memory.tags = tagsOf(input.tags);
  if ("source" in input) memory.source = sourceOf(input.source);
  if ("pinned" in input) memory.pinned = Boolean(input.pinned);
  if ("active" in input) memory.active = input.active !== false;
  memory.updatedAt = at;
  store.save();
  return memory;
}

export function memoryDescription(memory: MemoryEntry) {
  const scopeText = memory.scope === "global" ? "全局" : memory.scope === "course" ? "课程" : "学生";
  const kindText: Record<MemoryKind, string> = {
    learning: "学习记忆",
    preference: "教师偏好",
    insight: "教学洞察",
    requirement: "备课要求",
    note: "备注"
  };
  const tags = memory.tags.length > 0 ? `（标签：${memory.tags.join("、")}）` : "";
  return `- [${scopeText}·${kindText[memory.kind]}] ${memory.title}：${memory.content}${tags}`;
}

export function buildMemoryPromptSection(store: Store, student?: Student, course?: Course, maxEntries = 16) {
  const memories = listMemories(store, student ? { studentId: student.id, active: "true" } : { active: "true" })
    .slice(0, maxEntries);
  if (memories.length === 0) {
    return student ? "暂无额外记忆条目。" : "暂无全局记忆条目。";
  }
  return memories.map(memoryDescription).join("\n");
}
