import { BookmarkPlus, Check, ChevronDown, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { LessonTemplate } from "../../types";

export type TemplateDraft = Pick<
  LessonTemplate,
  "type" | "durationMinutes" | "textbook" | "lessonKind" | "notes" | "codexPromptOverride"
>;

export function TemplateManager({
  draft,
  onApply,
  onError
}: {
  draft: TemplateDraft;
  onApply: (template: LessonTemplate) => void;
  onError: (message: string) => void;
}) {
  const [templates, setTemplates] = useState<LessonTemplate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => templates.find((item) => item.id === selectedId) || null, [selectedId, templates]);

  const load = useCallback(async () => {
    const data = await api.get<{ templates: LessonTemplate[] }>("/api/templates");
    setTemplates(data.templates);
    setSelectedId((current) => current && data.templates.some((item) => item.id === current) ? current : data.templates[0]?.id || "");
  }, []);

  useEffect(() => {
    load().catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [load, onError]);

  async function createTemplate() {
    if (!name.trim()) {
      onError("请先填写模板名称。");
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<{ template: LessonTemplate }>("/api/templates", {
        ...draft,
        name: name.trim(),
        description: `${draft.durationMinutes} 分钟 · ${draft.lessonKind || "通用课程"}`
      });
      await load();
      setSelectedId(data.template.id);
      setName("");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateTemplate() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.patch(`/api/templates/${selected.id}`, { ...draft, name: selected.name, description: selected.description });
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate() {
    if (!selected || !window.confirm(`删除模板「${selected.name}」？`)) return;
    setBusy(true);
    try {
      await api.del(`/api/templates/${selected.id}`);
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="template-manager">
      <summary><span><BookmarkPlus size={16} />课程模板</span><small>{templates.length} 个可复用模板</small><ChevronDown size={15} /></summary>
      <div className="template-manager-body">
        <div className="template-apply-row">
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="选择课程模板">
            <option value="">选择模板</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <button type="button" className="primary-button" disabled={!selected} onClick={() => selected && onApply(selected)}>
            <Check size={15} />应用
          </button>
        </div>
        {selected ? (
          <div className="template-selected-summary">
            <strong>{selected.name}</strong>
            <small>{selected.description || `${selected.durationMinutes} 分钟 · ${selected.lessonKind}`}</small>
            <div>
              <button type="button" className="ghost-button" disabled={busy} onClick={updateTemplate}><Save size={14} />用当前设置更新</button>
              <button type="button" className="icon-button danger-icon" disabled={busy} onClick={removeTemplate} aria-label={`删除模板 ${selected.name}`}><Trash2 size={14} /></button>
            </div>
          </div>
        ) : null}
        <div className="template-create-row">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="把当前设置存为模板" aria-label="新模板名称" />
          <button type="button" className="ghost-button" disabled={busy || !name.trim()} onClick={createTemplate}><BookmarkPlus size={15} />保存</button>
        </div>
        <p>模板仅保存课型、时长、教材和生成要求，不保存学生姓名、成绩或学情。</p>
      </div>
    </details>
  );
}
