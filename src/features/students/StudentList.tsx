import { Search, Trash2, UsersRound } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Student } from "../../types";

export function StudentList({
  students,
  selectedId,
  createSlot,
  onSelect,
  onDelete
}: {
  students: Student[];
  selectedId: string;
  createSlot: ReactNode;
  onSelect: (id: string) => void;
  onDelete: (student: Student) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleStudents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return students;
    return students.filter((student) =>
      [student.name, student.stage, student.weakPoints, student.learningRoadmap]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized))
    );
  }, [query, students]);

  return (
    <section className="student-roster-panel student-library-panel">
      <div className="source-head">
        <div>
          <p className="eyebrow">Student library</p>
          <h2>学生档案</h2>
        </div>
        <span>{students.length}</span>
      </div>

      <div className="student-create-slot">{createSlot}</div>

      <label className="student-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索姓名、学段或薄弱点"
          aria-label="搜索学生"
        />
      </label>

      <div className="student-roster-list">
        {visibleStudents.map((item) => (
          <div key={item.id} className={item.id === selectedId ? "student-chip active" : "student-chip"}>
            <button className="student-source-main" onClick={() => onSelect(item.id)}>
              <span className="student-avatar" aria-hidden="true">{item.name.slice(0, 1)}</span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.stage || "未设置学段"} · {item.courseCount || 0} 节课</small>
              </span>
            </button>
            <button
              className="icon-button danger-icon"
              title={`删除学生 ${item.name}`}
              aria-label={`删除学生 ${item.name}`}
              onClick={() => onDelete(item)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {visibleStudents.length === 0 ? (
          <div className="student-list-empty">
            <UsersRound size={22} />
            <strong>{students.length ? "没有匹配的学生" : "建立第一份学生档案"}</strong>
            <small>{students.length ? "换一个关键词试试" : "档案会串联课程、学情与课后沉淀"}</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}
