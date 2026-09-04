import { useEffect, useMemo, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { api } from "../../api";
import type { Conversation, ConversationRole, MemoryEntry, MemoryKind, MemoryScope, Student } from "../../types";

const memoryKindLabels: Record<MemoryKind, string> = {
  learning: "学习记忆",
  preference: "教师偏好",
  insight: "教学洞察",
  requirement: "备课要求",
  note: "备注"
};

const memoryScopeLabels: Record<MemoryScope, string> = {
  student: "学生",
  global: "全局",
  course: "课程"
};

const conversationStepLabels: Record<string, string> = {
  idle: "未开始",
  user_request: "用户提出需求",
  draft_generating: "AI 草稿生成中",
  draft_generated: "AI 草稿已生成",
  review: "人工审阅",
  course_created: "课程已创建",
  lesson_running: "备课任务运行中",
  quality_failed: "质量检查未通过",
  post_class: "课后沉淀",
  completed: "已完成",
  canceled: "已取消"
};

function tagsText(tags?: string[]) {
  return tags && tags.length > 0 ? tags.join("、") : "";
}

export function MemoryManagerPanel({ student }: { student: Student }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    content: "",
    kind: "preference" as MemoryKind,
    tags: ""
  });

  const visibleMemories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter(
      (memory) =>
        memory.title.toLowerCase().includes(q) ||
        memory.content.toLowerCase().includes(q) ||
        memory.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [memories, query]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ memories: MemoryEntry[] }>(
        `/api/memories?studentId=${encodeURIComponent(student.id)}`
      );
      setMemories(data.memories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!form.title.trim() || !form.content.trim()) {
      setError("标题和内容不能为空。");
      return;
    }
    try {
      await api.post("/api/memories", {
        scope: "student",
        studentId: student.id,
        kind: form.kind,
        title: form.title,
        content: form.content,
        tags: form.tags,
        source: "manual",
        active: true
      });
      setForm({ title: "", content: "", kind: "preference", tags: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleActive(memory: MemoryEntry) {
    try {
      await api.patch(`/api/memories/${memory.id}`, { active: !(memory.active !== false) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function togglePinned(memory: MemoryEntry) {
    try {
      await api.patch(`/api/memories/${memory.id}`, { pinned: !memory.pinned });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveEdit(memory: MemoryEntry) {
    try {
      await api.patch(`/api/memories/${memory.id}`, {
        title: memory.title,
        content: memory.content,
        tags: memory.tags.join("、")
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(memory: MemoryEntry) {
    if (!window.confirm(`确认删除记忆「${memory.title}」？`)) return;
    try {
      await api.del(`/api/memories/${memory.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function updateEdit(memory: MemoryEntry, patch: Partial<MemoryEntry>) {
    setMemories((current) => current.map((item) => (item.id === memory.id ? { ...item, ...patch } : item)));
  }

  return (
    <section className="student-profile-panel memory-panel">
      <div className="profile-heading">
        <div>
          <strong>记忆管理</strong>
          <small>长期沉淀教师偏好、学生画像与教学洞察，可控制是否写入备课 Prompt</small>
        </div>
        <button type="button" className="ghost-button" onClick={load}>
          <RefreshCcw size={16} />
          刷新
        </button>
      </div>

      <form className="memory-form" onSubmit={submit}>
        <label>
          标题
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：老师偏好使用二级结论推导" />
        </label>
        <label>
          类型
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as MemoryKind })}>
            {Object.entries(memoryKindLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          标签
          <input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="标签用逗号分隔" />
        </label>
        <label className="memory-form-content">
          内容
          <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} rows={3} placeholder="记录可长期复用的教学内容/风格/学生情况" />
        </label>
        <button className="primary-button" type="submit">新增记忆</button>
      </form>

      <div className="memory-list-toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆" />
        <small>{visibleMemories.length} 条</small>
      </div>

      {error ? <div className="feedback error">{error}</div> : null}
      {loading ? <div className="feedback">加载中…</div> : null}

      {visibleMemories.length > 0 ? (
        <div className="memory-list">
          {visibleMemories.map((memory) => (
            <article key={memory.id} className={`memory-item${memory.active === false ? " memory-item-inactive" : ""}`}>
              <div className="memory-item-head">
                <span className={`memory-kind memory-kind-${memory.kind}`}>{memoryKindLabels[memory.kind]}</span>
                <span className="memory-scope">{memoryScopeLabels[memory.scope]}</span>
                {memory.pinned ? <span className="memory-pin">已固定</span> : null}
                <span className="memory-source">{memory.source}</span>
                <div className="memory-item-actions">
                  <button type="button" className="ghost-button" onClick={() => togglePinned(memory)}>
                    {memory.pinned ? "取消固定" : "固定"}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => toggleActive(memory)}>
                    {memory.active === false ? "启用" : "停用"}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setEditingId(editingId === memory.id ? null : memory.id)}>
                    编辑
                  </button>
                  <button type="button" className="ghost-button danger-button" onClick={() => remove(memory)}>删除</button>
                </div>
              </div>
              {editingId === memory.id ? (
                <div className="memory-edit-form">
                  <input value={memory.title} onChange={(event) => updateEdit(memory, { title: event.target.value })} />
                  <textarea value={memory.content} onChange={(event) => updateEdit(memory, { content: event.target.value })} rows={3} />
                  <div className="memory-edit-actions">
                    <button type="button" className="primary-button" onClick={() => saveEdit(memory)}>保存</button>
                    <button type="button" className="ghost-button" onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <strong>{memory.title}</strong>
                  <p>{memory.content}</p>
                  {memory.tags.length > 0 ? <small className="memory-tags">标签：{tagsText(memory.tags)}</small> : null}
                </>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="dossier-empty">还没有记忆条目，新增一条长期可复用的教师偏好或学生画像。</div>
      )}
    </section>
  );
}

export function ConversationStatePanel({ student }: { student: Student }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");

  const selected = conversations.find((conversation) => conversation.id === selectedId) || null;

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ conversations: Conversation[] }>(
        `/api/conversations?studentId=${encodeURIComponent(student.id)}`
      );
      setConversations(data.conversations || []);
      setSelectedId((current) => current || data.conversations?.[0]?.id || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  async function createConversation() {
    try {
      const data = await api.post<{ conversation: Conversation }>("/api/conversations", {
        studentId: student.id,
        title: "智能备课对话",
        status: "active",
        context: { step: "idle" }
      });
      await load();
      setSelectedId(data.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function send(role: ConversationRole) {
    if (!selected || (!draft.trim() && role !== "system")) return;
    setError("");
    try {
      await api.post(`/api/conversations/${selected.id}/turns`, {
        role,
        content: draft.trim() || "系统确认当前状态",
        context: role === "user" ? { step: "user_request" } : { step: selected.context.step }
      });
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reset() {
    if (!selected) return;
    try {
      await api.post(`/api/conversations/${selected.id}/reset`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function complete() {
    if (!selected) return;
    try {
      await api.post(`/api/conversations/${selected.id}/complete`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="student-profile-panel conversation-panel">
      <div className="profile-heading">
        <div>
          <strong>多轮状态控制</strong>
          <small>同一学生的多轮 AI 对话/任务状态，服务端持久化，可跨设备恢复</small>
        </div>
        <button type="button" className="ghost-button" onClick={load}>
          <RefreshCcw size={16} />
          刷新
        </button>
      </div>

      <div className="conversation-toolbar">
        <select value={selectedId || ""} onChange={(event) => setSelectedId(event.target.value || null)}>
          {conversations.length === 0 ? <option value="">暂无对话</option> : null}
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title} · {conversation.status} · {conversation.turns.length} 轮
            </option>
          ))}
        </select>
        <button type="button" className="ghost-button" onClick={createConversation}>新建</button>
        {selected ? (
          <>
            <button type="button" className="ghost-button" onClick={reset}>重置</button>
            <button type="button" className="ghost-button" onClick={complete}>完成</button>
          </>
        ) : null}
      </div>

      {error ? <div className="feedback error">{error}</div> : null}
      {loading ? <div className="feedback">加载中…</div> : null}

      {selected ? (
        <div className="conversation-detail">
          <div className="conversation-state">
            <span>当前状态：</span>
            <strong>{conversationStepLabels[selected.context.step] || selected.context.step}</strong>
            <span>最后更新：{selected.lastMessageAt ? new Date(selected.lastMessageAt).toLocaleString("zh-CN") : "暂无"}</span>
          </div>
          <div className="conversation-turns">
            {selected.turns.length === 0 ? <div className="dossier-empty">暂无对话轮次</div> : null}
            {selected.turns.map((turn) => (
              <div key={turn.id} className={`conversation-turn conversation-turn-${turn.role}`}>
                <span className="conversation-role">{turn.role === "user" ? "用户" : turn.role === "assistant" ? "AI" : "系统"}</span>
                <p>{turn.content}</p>
                {turn.state?.step ? <small>状态：{conversationStepLabels[String(turn.state.step)] || String(turn.state.step)}</small> : null}
              </div>
            ))}
          </div>
          <div className="conversation-compose">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} placeholder="输入一轮新的用户指令或补充要求" />
            <div className="memory-edit-actions">
              <button type="button" className="primary-button" onClick={() => send("user")}>发送用户指令</button>
              <button type="button" className="ghost-button" onClick={() => send("assistant")}>记录 AI 回复</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="dossier-empty">还没有多轮会话；AI 草稿生成或手动新建后会自动记录。</div>
      )}
    </section>
  );
}
