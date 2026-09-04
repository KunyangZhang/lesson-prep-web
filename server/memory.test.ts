import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMemoryPromptSection, createMemory, listMemories, updateMemory } from "./memory.js";
import { Store } from "./store.js";
import type { Student } from "./types.js";

function memoryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-memory-"));
  const dbPath = path.join(directory, "app-db.json");
  return { store: new Store(dbPath), dbPath, directory };
}

function student(): Student {
  const now = "2026-09-04T00:00:00.000Z";
  return { id: "student-1", name: "测试学生", stage: "高一", createdAt: now, updatedAt: now };
}

test("memory CRUD and student/global filtering", () => {
  const { store, directory } = memoryStore();
  try {
    const memory = createMemory(store, {
      scope: "student",
      studentId: "student-1",
      kind: "preference",
      title: "教师偏好：先讲题再总结",
      content: "老师喜欢先用例题暴露问题，再给套路总结。",
      tags: "偏好, 讲法"
    });
    assert.ok(memory.id.startsWith("mem_"));
    assert.equal(memory.active, true);

    const global = createMemory(store, {
      scope: "global",
      kind: "requirement",
      title: "统一作业格式",
      content: "课后作业必须包含完整答案版。",
      tags: ["作业", "固定要求"]
    });

    const studentMemories = listMemories(store, { studentId: "student-1" });
    assert.equal(studentMemories.length, 2);
    assert.ok(studentMemories.some((item) => item.id === memory.id));
    assert.ok(studentMemories.some((item) => item.id === global.id));

    const activeOnly = listMemories(store, { studentId: "student-1", active: "true" });
    assert.equal(activeOnly.length, 2);

    const inactive = updateMemory(store, memory.id, { active: false, pinned: true });
    assert.equal(inactive?.active, false);
    assert.equal(inactive?.pinned, true);
    const activeOnlyAfter = listMemories(store, { studentId: "student-1", active: "true" });
    assert.equal(activeOnlyAfter.length, 1);
    assert.equal(activeOnlyAfter[0]?.id, global.id);

    const search = listMemories(store, { q: "固定" });
    assert.equal(search.length, 1);
    assert.equal(search[0]?.id, global.id);

    assert.equal(store.deleteMemory(memory.id), true);
    assert.equal(store.findMemory(memory.id), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("memory prompt section only includes active entries", () => {
  const { store, directory } = memoryStore();
  try {
    createMemory(store, { scope: "student", studentId: "student-1", kind: "note", title: "活跃记忆", content: "这条会被写入 Prompt。" });
    const inactive = createMemory(store, { scope: "student", studentId: "student-1", kind: "note", title: "停用记忆", content: "这条不应写入。" });
    updateMemory(store, inactive.id, { active: false });

    const section = buildMemoryPromptSection(store, student());
    assert.match(section, /活跃记忆/);
    assert.doesNotMatch(section, /停用记忆/);
    assert.match(section, /学生·备注/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
