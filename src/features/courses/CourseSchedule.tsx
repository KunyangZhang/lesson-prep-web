import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Search } from "lucide-react";
import type { Course, Student } from "../../types";
import { shortCourseTitle } from "../../courseTitle";
import { StatusBadge } from "../../components/StatusBadge";
import { calendarMonth, dayKey, lessonClock, lessonDate, monthDays } from "./schedule";

const studentColors = ["#347965", "#b66b42", "#6577b5", "#9b6d9e", "#438994", "#ad853b"];

export function CourseSchedule({ courses, students, selectedStudentId, selectedId, scope, onStudentChange, onSelect }: {
  courses: Course[];
  students: Student[];
  selectedStudentId: string;
  selectedId?: string;
  scope: "all" | "student";
  onStudentChange: (studentId: string) => void;
  onSelect: (course: Course) => void;
}) {
  const [month, setMonth] = useState(() => calendarMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => dayKey(new Date()));
  const [tab, setTab] = useState<"calendar" | "unscheduled">("calendar");
  const [query, setQuery] = useState("");
  const selectedStudent = students.find((student) => student.id === selectedStudentId);
  const studentMap = useMemo(() => new Map(students.map((student) => [student.id, { ...student, color: studentColors[Array.from(student.id).reduce((sum, character) => sum + character.codePointAt(0)!, 0) % studentColors.length] }])), [students]);
  const currentLessonTime = courses.find((course) => course.id === selectedId)?.lessonTime;

  useEffect(() => {
    const date = lessonDate(currentLessonTime || "");
    if (date) { setMonth(calendarMonth(date)); setSelectedDay(dayKey(date)); setTab("calendar"); }
  }, [selectedId, currentLessonTime]);

  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return courses.filter((course) => (scope === "all" || course.studentId === selectedStudentId) &&
      (!search || [course.desiredContent, studentMap.get(course.studentId)?.name || "", course.grade].some((value) => value.toLocaleLowerCase().includes(search))));
  }, [courses, scope, selectedStudentId, query, studentMap]);
  const { dated, unscheduled } = useMemo(() => {
    const dated = new Map<string, Course[]>();
    const unscheduled: Course[] = [];
    for (const course of visible) {
      const date = lessonDate(course.lessonTime);
      if (!date) { unscheduled.push(course); continue; }
      const key = dayKey(date);
      const group = dated.get(key) || [];
      group.push(course); dated.set(key, group);
    }
    for (const group of dated.values()) group.sort((a, b) => lessonDate(a.lessonTime)!.getTime() - lessonDate(b.lessonTime)!.getTime());
    return { dated, unscheduled };
  }, [visible]);
  const dailyCourses = dated.get(selectedDay) || [];
  const grid = useMemo(() => monthDays(month), [month]);
  const today = dayKey(new Date());
  const monthCount = visible.filter((course) => {
    const date = lessonDate(course.lessonTime);
    return date && dayKey(date).slice(0, 7) === dayKey(month).slice(0, 7);
  }).length;
  const selectedDate = lessonDate(selectedDay)!;

  function selectCourse(course: Course) {
    const date = lessonDate(course.lessonTime);
    if (date) { setSelectedDay(dayKey(date)); setMonth(calendarMonth(date)); }
    onSelect(course);
  }

  function selectDay(date: Date) {
    setSelectedDay(dayKey(date));
    if (date.getMonth() !== month.getMonth() || date.getFullYear() !== month.getFullYear()) setMonth(calendarMonth(date));
  }

  function agenda(items: Course[]) {
    return items.length ? <div className="schedule-agenda-list">{items.map((course) => {
      const student = studentMap.get(course.studentId);
      return <button type="button" key={course.id} className={`schedule-lesson${selectedId === course.id ? " selected" : ""}`} style={{ "--student-color": student?.color || studentColors[0] } as CSSProperties} onClick={() => selectCourse(course)} aria-pressed={selectedId === course.id}>
        <div className="schedule-time"><strong>{lessonClock(course.lessonTime)}</strong><small>{course.durationMinutes} 分钟</small></div>
        <div className="schedule-lesson-copy"><span><i aria-hidden="true" />{student?.name || "未命名学生"}<small>{course.type === "trial" ? "试听课" : "正式课"}</small></span><strong title={course.desiredContent}>{shortCourseTitle(course.desiredContent)}</strong></div>
        <StatusBadge status={course.status} /><ChevronRight size={15} />
      </button>;
    })}</div> : <div className="schedule-empty"><CalendarDays size={25} /><strong>{tab === "unscheduled" ? "所有课程均已安排时间" : "这一天没有安排课程"}</strong><p>{query ? "可以换个关键词，或切换到全部学生。" : tab === "unscheduled" ? "未设置上课时间的课程会显示在这里。" : "选择其他日期查看，也可以在未排期课程中设置上课时间。"}</p></div>;
  }

  return <section className="course-schedule" aria-label="课程日程表">
    <div className="schedule-filters">
      <label className="schedule-student-filter">学生
        <select aria-label="按学生筛选日程" value={scope === "all" ? "" : selectedStudentId} onChange={(event) => onStudentChange(event.target.value)}>
          <option value="">全部学生</option>
          {students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
        </select>
      </label>
      <label className="queue-search schedule-search"><Search size={14} /><input aria-label="搜索日程" placeholder="搜索学生或课程" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    <div className="schedule-view-tabs" aria-label="日程视图">
      <button type="button" className={tab === "calendar" ? "active" : ""} aria-pressed={tab === "calendar"} onClick={() => setTab("calendar")}><CalendarDays size={15} />月历</button>
      <button type="button" className={tab === "unscheduled" ? "active" : ""} aria-pressed={tab === "unscheduled"} onClick={() => setTab("unscheduled")}><Clock3 size={15} />未排期<span>{unscheduled.length}</span></button>
      <small>{scope === "all" ? "全部学生" : selectedStudent?.name} · {visible.length} 节课程</small>
    </div>
    {tab === "calendar" ? <>
      <header className="schedule-month-toolbar">
        <div><h3>{month.getFullYear()} 年 {month.getMonth() + 1} 月</h3><small>本月 {monthCount} 节课</small></div>
        <div><button type="button" className="icon-button" aria-label="上个月" onClick={() => setMonth(calendarMonth(month, -1))}><ChevronLeft size={17} /></button><button type="button" className="schedule-today" onClick={() => { const date = new Date(); setMonth(calendarMonth(date)); setSelectedDay(dayKey(date)); }}>今天</button><button type="button" className="icon-button" aria-label="下个月" onClick={() => setMonth(calendarMonth(month, 1))}><ChevronRight size={17} /></button></div>
      </header>
      <div className="schedule-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="schedule-month-grid" role="group" aria-label={`${month.getFullYear()}年${month.getMonth() + 1}月课程日历`}>
        {grid.map((date) => {
          const key = dayKey(date), items = dated.get(key) || [];
          return <div key={key} className={`schedule-day${date.getMonth() !== month.getMonth() ? " outside" : ""}${key === selectedDay ? " selected" : ""}${key === today ? " today" : ""}`}>
            <button type="button" className="schedule-date" aria-label={`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日，${items.length}节课`} aria-pressed={key === selectedDay} aria-current={key === today ? "date" : undefined} onClick={() => selectDay(date)}><span>{date.getDate()}</span>{items.length ? <small>{items.length}</small> : null}</button>
            <div className="schedule-day-events">{items.slice(0, 2).map((course) => <button type="button" key={course.id} className={selectedId === course.id ? "active" : ""} style={{ "--student-color": studentMap.get(course.studentId)?.color || studentColors[0] } as CSSProperties} title={`${lessonClock(course.lessonTime)} ${studentMap.get(course.studentId)?.name} · ${shortCourseTitle(course.desiredContent)}`} aria-label={`查看${studentMap.get(course.studentId)?.name}的课程：${shortCourseTitle(course.desiredContent)}`} onClick={() => selectCourse(course)}><i aria-hidden="true" /><span>{lessonClock(course.lessonTime)} {studentMap.get(course.studentId)?.name}</span></button>)}{items.length > 2 ? <button type="button" className="schedule-more" onClick={() => selectDay(date)}>+{items.length - 2} 节</button> : null}</div>
          </div>;
        })}
      </div>
      <div className="schedule-agenda-heading"><div><strong>{selectedDate.getMonth() + 1} 月 {selectedDate.getDate()} 日</strong><span>{selectedDate.toLocaleDateString("zh-CN", { weekday: "long" })}</span></div><small>{dailyCourses.length} 节课</small></div>
      {agenda(dailyCourses)}
    </> : <><div className="schedule-unscheduled-copy"><strong>待安排上课时间</strong><p>点击课程进入对应学生的备课台，在「编辑设置」中补充上课时间，即可加入日历。</p></div>{agenda(unscheduled)}</>}
  </section>;
}
