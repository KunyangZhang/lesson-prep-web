import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Conversation, ConversationContext, ConversationRole, ConversationStatus, ConversationTurn } from "./types.js";

function text(value: unknown, fallback = "", max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function stepOf(value: unknown, fallback = "idle") {
  const allowed = ["idle", "user_request", "draft_generating", "draft_generated", "review", "course_created", "lesson_running", "quality_failed", "post_class", "completed", "canceled"];
  return allowed.includes(String(value)) ? String(value) : fallback;
}

function statusOf(value: unknown, fallback: ConversationStatus = "active"): ConversationStatus {
  const allowed: ConversationStatus[] = ["active", "completed", "canceled", "archived"];
  return allowed.includes(value as ConversationStatus) ? (value as ConversationStatus) : fallback;
}

function normalizeContext(input: Record<string, unknown> | undefined, fallback?: ConversationContext): ConversationContext {
  const body = input && typeof input === "object" ? input : ({} as Record<string, unknown>);
  return {
    step: stepOf(body.step, fallback?.step || "idle"),
    lastUserInstruction: text(body.lastUserInstruction, fallback?.lastUserInstruction),
    lastDraftSummary: text(body.lastDraftSummary, fallback?.lastDraftSummary),
    draftLogPath: text(body.draftLogPath, fallback?.draftLogPath),
    courseId: text(body.courseId, fallback?.courseId),
    jobId: text(body.jobId, fallback?.jobId),
    lastQualityStatus: text(body.lastQualityStatus, fallback?.lastQualityStatus),
    ...(typeof body === "object" && body ? body : {})
  };
}

export function listConversations(store: Store, filters: { studentId?: string; courseId?: string; status?: string } = {}) {
  let result = [...store.data.conversations];
  if (filters.courseId) result = result.filter((conversation) => conversation.courseId === filters.courseId);
  else if (filters.studentId) result = result.filter((conversation) => conversation.studentId === filters.studentId);
  if (filters.status) result = result.filter((conversation) => conversation.status === filters.status);
  return result.sort((a, b) => (b.lastMessageAt || b.updatedAt).localeCompare(a.lastMessageAt || a.updatedAt));
}

export function createConversation(store: Store, input: Record<string, unknown>, at = nowIso()): Conversation {
  const title = text(input.title, "未命名对话");
  const conversation: Conversation = {
    id: newId("conv"),
    studentId: text(input.studentId) || undefined,
    courseId: text(input.courseId) || undefined,
    title,
    status: statusOf(input.status),
    context: normalizeContext(input.context as Record<string, unknown> | undefined),
    turns: [],
    createdAt: at,
    updatedAt: at
  };
  store.addConversation(conversation);
  return conversation;
}

export function resetConversation(store: Store, id: string, at = nowIso()) {
  const conversation = store.findConversation(id);
  if (!conversation) return null;
  conversation.status = "active";
  conversation.context = { step: "idle" };
  conversation.turns = [];
  conversation.updatedAt = at;
  conversation.lastMessageAt = undefined;
  store.save();
  return conversation;
}

export function updateConversation(store: Store, id: string, input: Record<string, unknown>, at = nowIso()) {
  const conversation = store.findConversation(id);
  if (!conversation) return null;
  if ("title" in input) conversation.title = text(input.title, conversation.title);
  if ("status" in input) conversation.status = statusOf(input.status, conversation.status);
  if ("context" in input || "step" in input) {
    conversation.context = normalizeContext(
      input.context && typeof input.context === "object" ? (input.context as Record<string, unknown>) : input,
      conversation.context
    );
  }
  if ("studentId" in input) conversation.studentId = text(input.studentId) || undefined;
  if ("courseId" in input) conversation.courseId = text(input.courseId) || undefined;
  conversation.updatedAt = at;
  store.save();
  return conversation;
}

export function appendTurn(
  store: Store,
  id: string,
  role: ConversationRole,
  content: string,
  contextPatch?: Record<string, unknown>,
  at = nowIso()
) {
  const conversation = store.findConversation(id);
  if (!conversation) return null;
  const turn: ConversationTurn = {
    id: newId("turn"),
    role,
    content: content.trim().slice(0, 20000),
    state: contextPatch ? { ...contextPatch } : undefined,
    createdAt: at
  };
  conversation.turns.push(turn);
  if (conversation.turns.length > 200) {
    conversation.turns = conversation.turns.slice(-200);
  }
  conversation.updatedAt = at;
  conversation.lastMessageAt = at;
  if (contextPatch && typeof contextPatch.step === "string") {
    conversation.context = normalizeContext({ ...conversation.context, ...contextPatch });
  }
  store.save();
  return conversation;
}

export function completeConversation(store: Store, id: string, at = nowIso()) {
  const conversation = store.findConversation(id);
  if (!conversation) return null;
  conversation.status = "completed";
  conversation.context = { ...conversation.context, step: "completed" };
  conversation.updatedAt = at;
  conversation.lastMessageAt = at;
  store.save();
  return conversation;
}

export function startOrGetActiveConversation(store: Store, studentId: string, initialTitle = "智能备课对话", at = nowIso()) {
  const existing = store.data.conversations.find(
    (conversation) => conversation.studentId === studentId && conversation.status === "active"
  );
  if (existing) return existing;
  return createConversation(store, { studentId, title: initialTitle, status: "active", context: { step: "idle" } }, at);
}

export function recordConversationTurn(
  store: Store,
  studentId: string,
  input: { title?: string; role?: ConversationRole; content: string; context?: Record<string, unknown>; conversationId?: string },
  at = nowIso()
) {
  const conversation = input.conversationId
    ? store.findConversation(input.conversationId)
    : startOrGetActiveConversation(store, studentId, input.title || "智能备课对话", at);
  if (!conversation) return null;
  return appendTurn(store, conversation.id, input.role || "user", input.content, input.context, at);
}
