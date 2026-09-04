import { BookOpen, Boxes, FileQuestion, Search } from "lucide-react";
import type { ReactNode } from "react";

export function MaterialsLibraryHeader({
  uploadRoot,
  total,
  indexed,
  questions,
  snippets,
  searchable,
  actions
}: {
  uploadRoot: string;
  total: number;
  indexed: number;
  questions: number;
  snippets: number;
  searchable: number;
  actions: ReactNode;
}) {
  const metrics = [
    { label: "资料文件", value: total, note: `${indexed} 份已索引`, icon: Boxes, tone: "green" },
    { label: "题目记录", value: questions, note: "可用于选题", icon: FileQuestion, tone: "orange" },
    { label: "知识片段", value: snippets, note: "解析与说明", icon: BookOpen, tone: "blue" },
    { label: "可检索内容", value: searchable, note: "题目 + 片段", icon: Search, tone: "gold" }
  ];

  return (
    <>
      <header className="materials-command-header">
        <div>
          <p className="eyebrow">Knowledge library</p>
          <h2>资料与题库</h2>
          <span>{uploadRoot || "资料库/网页上传"}</span>
        </div>
        <div className="materials-command-actions">{actions}</div>
      </header>
      <section className="library-metrics" aria-label="资料库指标">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <article key={metric.label}>
              <span className={`library-metric-icon tone-${metric.tone}`}><Icon size={17} /></span>
              <div><strong>{metric.value}</strong><span>{metric.label}</span><small>{metric.note}</small></div>
            </article>
          );
        })}
      </section>
    </>
  );
}
