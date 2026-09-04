import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "./store.js";
import { createLessonTemplate, deleteLessonTemplate, listLessonTemplates, updateLessonTemplate } from "./templates.js";

test("lesson template CRUD persists without student-specific data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-template-"));
  const store = new Store(path.join(directory, "app-db.json"));
  try {
    const created = createLessonTemplate(store, {
      name: "高二专题提升",
      description: "90 分钟专题课",
      type: "formal",
      durationMinutes: 95,
      textbook: "人教A版",
      lessonKind: "专题提升",
      notes: "包含诊断、讲解与变式",
      studentId: "must-not-persist"
    }, "2026-09-04T08:00:00.000Z");
    assert.equal(created.durationMinutes, 95);
    assert.equal("studentId" in created, false);
    assert.equal(listLessonTemplates(store)[0]?.id, created.id);

    const updated = updateLessonTemplate(store, created.id, { name: "高二专题课", durationMinutes: 999 }, "2026-09-04T09:00:00.000Z");
    assert.equal(updated?.name, "高二专题课");
    assert.equal(updated?.durationMinutes, 240);
    assert.equal(updated?.updatedAt, "2026-09-04T09:00:00.000Z");

    const reloaded = new Store(path.join(directory, "app-db.json"));
    assert.equal(reloaded.data.templates[0]?.name, "高二专题课");
    assert.equal(deleteLessonTemplate(reloaded, created.id), true);
    assert.equal(listLessonTemplates(reloaded).length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("lesson templates require a concise name", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-template-validation-"));
  const store = new Store(path.join(directory, "app-db.json"));
  try {
    assert.throws(() => createLessonTemplate(store, { name: "" }), /模板名称不能为空/);
    assert.throws(() => createLessonTemplate(store, { name: "x".repeat(81) }), /80/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
