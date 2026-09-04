import { BookOpenCheck, ExternalLink, FileCheck2, GraduationCap, NotebookPen } from "lucide-react";
import type { CourseFile } from "../../types";

type OutputGroup = "teacher" | "student" | "homework" | "notes";

const groupMeta: Record<OutputGroup, { label: string; icon: typeof GraduationCap }> = {
  teacher: { label: "教师授课", icon: NotebookPen },
  student: { label: "学生课堂", icon: GraduationCap },
  homework: { label: "作业练习", icon: FileCheck2 },
  notes: { label: "说明文档", icon: BookOpenCheck }
};

function normalize(file: CourseFile) {
  return file.relativePath.replace(/\\/g, "/");
}

function groupFor(file: CourseFile): OutputGroup {
  const name = file.name;
  if (name.includes("作业")) return "homework";
  if (name.includes("授课一体版") || name.includes("老师逐字稿") || name.includes("知识点详解")) return "teacher";
  if (file.kind === "pdf" && !normalize(file).includes("/")) return "student";
  return "notes";
}

function fileKind(file: CourseFile) {
  if (file.kind === "pdf") return "PDF";
  if (file.kind === "markdown") return "文档";
  if (file.kind === "image") return "图片";
  return file.kind;
}

export function OutputReview({
  files,
  selectedPath,
  onSelect
}: {
  files: CourseFile[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  if (files.length === 0) return <div className="quiet-empty">等待生成课程产物</div>;
  const groups = (Object.keys(groupMeta) as OutputGroup[])
    .map((key) => ({ key, files: files.filter((file) => groupFor(file) === key) }))
    .filter((group) => group.files.length > 0);

  return (
    <div className="output-review-list">
      {groups.map((group) => {
        const meta = groupMeta[group.key];
        const Icon = meta.icon;
        return (
          <section key={group.key} className="output-group">
            <header><Icon size={15} /><strong>{meta.label}</strong><span>{group.files.length}</span></header>
            {group.files.map((file) => (
              <div key={file.path} className={file.path === selectedPath ? "output-file active" : "output-file"}>
                <button onClick={() => onSelect(file.path)}>
                  <strong>{file.name}</strong>
                  <small>{fileKind(file)} · {Math.max(1, Math.round(file.size / 1024))} KB</small>
                </button>
                <a
                  className="icon-button"
                  title={`新页面打开 ${file.name}`}
                  aria-label={`新页面打开 ${file.name}`}
                  href={`/viewer?path=${encodeURIComponent(file.path)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={14} />
                </a>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
