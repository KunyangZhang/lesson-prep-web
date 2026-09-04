import { CalendarDays, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge";
import type { Course } from "../../types";

type QueueFilter = "all" | "active" | "upcoming" | "completed";

function dateValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function courseDate(value: string) {
  if (!value) return "时间待定";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function nextAction(course: Course) {
  if (course.status === "running" || course.status === "queued") return "查看生成进度";
  if (course.status === "failed" || course.status === "canceled") return "继续生成";
  if (course.status === "completed" && course.postClassSummary?.status !== "confirmed") return "完成课后沉淀";
  if (course.status === "completed") return "查看课程产物";
  return "完善信息并开始";
}

export function CourseQueue({
  courses,
  selectedId,
  onSelect,
  onDelete
}: {
  courses: Course[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onDelete: (course: Course) => void;
}) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const now = Date.now();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return courses.filter((course) => {
      if (normalized && ![course.desiredContent, course.grade, course.textbook, course.lessonKind]
        .some((value) => value?.toLowerCase().includes(normalized))) return false;
      if (filter === "active") return ["queued", "running", "failed"].includes(course.status);
      if (filter === "upcoming") return Boolean(course.lessonTime) && dateValue(course.lessonTime) >= now;
      if (filter === "completed") return course.status === "completed";
      return true;
    });
  }, [courses, filter, now, query]);

  return (
    <section className="course-board course-queue-panel">
      <div className="section-title course-queue-title">
        <div>
          <p className="eyebrow">Lesson queue</p>
          <strong>课程队列</strong>
          <small>{filtered.length} / {courses.length} 节课程</small>
        </div>
        <CalendarDays size={19} />
      </div>

      <div className="queue-toolbar">
        <label className="queue-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程" aria-label="搜索课程" />
        </label>
        <div className="queue-filters" aria-label="筛选课程">
          {([
            ["all", "全部"],
            ["active", "进行中"],
            ["upcoming", "接下来"],
            ["completed", "已完成"]
          ] as const).map(([key, label]) => (
            <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="quiet-empty">没有符合当前筛选的课程</div>
      ) : (
        <div className="course-list queue-course-list">
          {filtered.map((course) => (
            <div key={course.id} className={course.id === selectedId ? "course-item active" : "course-item"}>
              <button className="course-select" onClick={() => onSelect(course.id)}>
                <span className="queue-card-head">
                  <StatusBadge status={course.status} />
                  <time>{courseDate(course.lessonTime)}</time>
                </span>
                <strong>{course.desiredContent || "未命名课程"}</strong>
                <small>{course.type === "trial" ? "试听课" : "正式课"} · {course.grade || "年级待填"} · {course.durationMinutes} 分钟</small>
                <span className="queue-next-action">{nextAction(course)}</span>
              </button>
              <button
                className="icon-button danger-icon"
                title={`删除课程 ${course.desiredContent || "未命名课程"}`}
                aria-label={`删除课程 ${course.desiredContent || "未命名课程"}`}
                onClick={() => onDelete(course)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
