import { newId, nowIso, type Store } from "./store.js";
import type { LessonTemplate } from "./types.js";

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function duration(value: unknown, fallback = 90) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(20, Math.min(240, Math.round(parsed)));
}

function templateFields(input: Record<string, unknown>, fallback?: LessonTemplate) {
  const name = text(input.name, fallback?.name || "");
  if (!name) throw new Error("模板名称不能为空。");
  if (name.length > 80) throw new Error("模板名称不能超过 80 个字符。");
  return {
    name,
    description: text(input.description, fallback?.description || ""),
    type: input.type === "trial" ? "trial" as const : input.type === "formal" ? "formal" as const : fallback?.type || "formal" as const,
    durationMinutes: duration(input.durationMinutes, fallback?.durationMinutes || 90),
    textbook: text(input.textbook, fallback?.textbook || ""),
    lessonKind: text(input.lessonKind, fallback?.lessonKind || "专题提升"),
    notes: text(input.notes, fallback?.notes || ""),
    codexPromptOverride: text(input.codexPromptOverride, fallback?.codexPromptOverride || "")
  };
}

export function listLessonTemplates(store: Store) {
  return [...store.data.templates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createLessonTemplate(store: Store, input: Record<string, unknown>, at = nowIso()) {
  const template: LessonTemplate = {
    id: newId("tpl"),
    ...templateFields(input),
    createdAt: at,
    updatedAt: at
  };
  store.addTemplate(template);
  return template;
}

export function updateLessonTemplate(store: Store, id: string, input: Record<string, unknown>, at = nowIso()) {
  const template = store.data.templates.find((item) => item.id === id);
  if (!template) return null;
  Object.assign(template, templateFields(input, template), { updatedAt: at });
  store.save();
  return template;
}

export function deleteLessonTemplate(store: Store, id: string) {
  return store.deleteTemplate(id);
}
