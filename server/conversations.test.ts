import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendTurn,
  completeConversation,
  createConversation,
  listConversations,
  recordConversationTurn,
  resetConversation,
  updateConversation
} from "./conversations.js";
import { Store } from "./store.js";

function conversationStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-conversation-"));
  const dbPath = path.join(directory, "app-db.json");
  return { store: new Store(dbPath), directory };
}

test("conversation multi-turn state machine", () => {
  const { store, directory } = conversationStore();
  try {
    const conversation = createConversation(store, {
      studentId: "student-1",
      title: "AI 备课对话",
      context: { step: "idle" }
    });

    appendTurn(store, conversation.id, "user", "准备一节圆锥曲线课", { step: "user_request" });
    appendTurn(store, conversation.id, "assistant", "已生成草稿", { step: "draft_generated", lastDraftSummary: "草稿摘要" });
    assert.equal(conversation.turns.length, 2);
    assert.equal(conversation.context.step, "draft_generated");
    assert.equal(conversation.context.lastDraftSummary, "草稿摘要");

    updateConversation(store, conversation.id, { context: { step: "course_created", courseId: "course-1" } });
    assert.equal(conversation.context.step, "course_created");
    assert.equal(conversation.context.courseId, "course-1");

    completeConversation(store, conversation.id);
    assert.equal(conversation.status, "completed");
    assert.equal(conversation.context.step, "completed");

    const active = listConversations(store, { studentId: "student-1", status: "active" });
    assert.equal(active.length, 0);

    resetConversation(store, conversation.id);
    assert.equal(conversation.status, "active");
    assert.equal(conversation.turns.length, 0);
    assert.equal(conversation.context.step, "idle");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recordConversationTurn reuses active student conversation", () => {
  const { store, directory } = conversationStore();
  try {
    const first = recordConversationTurn(store, "student-1", { role: "user", content: "第一轮", title: "智能备课对话" });
    const second = recordConversationTurn(store, "student-1", { role: "assistant", content: "第二轮" });
    assert.ok(first);
    assert.ok(second);
    assert.equal(first?.id, second?.id);
    assert.equal(store.findConversation(first!.id)?.turns.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
