import { useId, useState } from "react";
import { BookOpen, ChevronDown, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { shortCourseTitle } from "../../courseTitle";

function NoteBody({ content }: { content: string }) {
  return <div className="learning-note-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

export function LearningNote({ title, content }: { title: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const separator = /(?:^|\n)---\s*\n自动课后沉淀[：:]\s*/.exec(content);
  const manual = separator ? content.slice(0, separator.index).trim() : content.trim();
  const entries = separator ? content.slice(separator.index + separator[0].length)
    .split(/\s*<!-- auto:[^>]+-->\s*/).map((entry) => entry.trim()).filter(Boolean).reverse()
    .sort((a, b) => (b.match(/【(\d{4}-\d{2}-\d{2})/)?.[1] || "").localeCompare(a.match(/【(\d{4}-\d{2}-\d{2})/)?.[1] || "")) : [];
  const expandable = entries.length > 1 || content.length > 260 || content.split("\n").length > 5;

  return (
    <section className="learning-note">
      <div className="learning-note-heading">
        <span><BookOpen size={16} /><strong>{title}</strong></span>
        {entries.length ? <small>{entries.length} 次课后记录</small> : <small>备课时自动参考</small>}
      </div>
      <div id={id} className={`learning-note-content${expanded ? " expanded" : ""}`}>
        {manual ? <NoteBody content={manual} /> : null}
        {entries.length ? (
          <div className="learning-history">
            <div className="learning-history-label"><Sparkles size={13} />课后学习记录</div>
            {(expanded ? entries : entries.slice(0, 1)).map((entry, index) => {
              const match = /^【([^\n]+)】\s*\n?/.exec(entry);
              const heading = match?.[1] || "课堂反馈";
              const date = /^\d{4}-\d{2}-\d{2}/.exec(heading)?.[0];
              const topic = heading.replace(/^\d{4}-\d{2}-\d{2}\s*(试听课|正式课)?\s*/, "");
              return (
                <article className="learning-history-entry" key={`${heading}-${index}`}>
                  <div className="learning-history-title"><strong title={topic}>{shortCourseTitle(topic)}</strong>{date ? <time>{date}</time> : null}</div>
                  <NoteBody content={entry.slice(match?.[0].length || 0)} />
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
      {expandable ? <button type="button" className="learning-expand" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        {expanded ? "收起记录" : "展开全部记录"}<ChevronDown size={14} className={expanded ? "rotated" : ""} />
      </button> : null}
    </section>
  );
}
