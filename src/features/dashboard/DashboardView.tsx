import {
  ArrowRight,
  BookMarked,
  CalendarCheck2,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileStack,
  GraduationCap,
  RefreshCcw,
  Sparkles,
  TrendingUp
} from "lucide-react";
import { EmptyState, LoadingState } from "../../components/Feedback";
import { StatusBadge } from "../../components/StatusBadge";
import type { AppView } from "../../components/AppShell";
import type { DashboardActivity, DashboardCourseSummary, DashboardSnapshot } from "../../types";
import type { LearningInsights } from "../../types";
import { InsightsPanel } from "../insights/InsightsPanel";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function compactDate(value: string) {
  if (!value) return "时间待定";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function actionLabel(action: DashboardCourseSummary["nextAction"]) {
  if (action === "monitor") return "查看进度";
  if (action === "retry") return "继续处理";
  if (action === "post_class") return "完成课后总结";
  if (action === "review") return "查看产物";
  return "开始准备";
}

function ActivityIcon({ item }: { item: DashboardActivity }) {
  if (item.kind === "material") return <BookMarked size={16} />;
  if (item.kind === "job") return <Sparkles size={16} />;
  return <CalendarCheck2 size={16} />;
}

export function DashboardView({
  dashboard,
  insights,
  loading,
  userName,
  onRefresh,
  onRefreshInsights,
  onNavigate,
  onOpenCourse
}: {
  dashboard: DashboardSnapshot | null;
  insights: LearningInsights | null;
  loading: boolean;
  userName: string;
  onRefresh: () => void;
  onRefreshInsights: () => void;
  onNavigate: (view: AppView) => void;
  onOpenCourse: (course: DashboardCourseSummary) => void;
}) {
  if (loading && !dashboard) return <LoadingState />;

  const metrics = dashboard?.metrics;
  const todayLabel = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

  return (
    <div className="dashboard-view">
      <header className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="eyebrow">{todayLabel}</p>
          <h2>{greeting()}，{userName}</h2>
          <p>先处理需要关注的课程，再开始新的备课。工作台已经把进度、质量和课后沉淀放到一处。</p>
          <div className="dashboard-hero-actions">
            <button className="primary-button warm-primary" onClick={() => onNavigate("courses")}>
              <Sparkles size={17} />
              准备一节课
            </button>
            <button className="ghost-button" onClick={() => onNavigate("materials")}>
              <BookMarked size={17} />
              打开资料库
            </button>
          </div>
        </div>
        <div className="dashboard-focus-card">
          <span>今日焦点</span>
          <strong>{metrics?.activeJobCount || metrics?.postClassPendingCount || metrics?.upcomingCourseCount || 0}</strong>
          <p>
            {metrics?.activeJobCount
              ? `${metrics.activeJobCount} 个生成任务正在运行`
              : metrics?.postClassPendingCount
                ? `${metrics.postClassPendingCount} 节课等待课后确认`
                : metrics?.upcomingCourseCount
                  ? `${metrics.upcomingCourseCount} 节课程已经排入计划`
                  : "当前没有紧急事项"}
          </p>
          <span className="focus-orbit" aria-hidden="true" />
        </div>
      </header>

      <section className="dashboard-metrics" aria-label="工作台指标">
        <article>
          <span className="metric-icon metric-students"><GraduationCap size={18} /></span>
          <div><strong>{metrics?.studentCount || 0}</strong><span>学生档案</span></div>
          <small>{metrics?.courseCount || 0} 节累计课程</small>
        </article>
        <article>
          <span className="metric-icon metric-upcoming"><Clock3 size={18} /></span>
          <div><strong>{metrics?.upcomingCourseCount || 0}</strong><span>计划课程</span></div>
          <small>{metrics?.activeJobCount || 0} 个任务运行中</small>
        </article>
        <article>
          <span className="metric-icon metric-review"><CheckCircle2 size={18} /></span>
          <div><strong>{metrics?.completedCourseCount || 0}</strong><span>已完成课程</span></div>
          <small>{metrics?.postClassPendingCount || 0} 节待课后沉淀</small>
        </article>
        <article>
          <span className="metric-icon metric-materials"><FileStack size={18} /></span>
          <div><strong>{metrics?.indexedKnowledgeCount || 0}</strong><span>知识条目</span></div>
          <small>{metrics?.indexedMaterialCount || 0} 份资料已索引</small>
        </article>
        <article>
          <span className="metric-icon metric-quality"><TrendingUp size={18} /></span>
          <div><strong>{metrics?.averageQualityScore ?? "—"}</strong><span>平均质量分</span></div>
          <small>基于已完成的质量检查</small>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="dashboard-panel dashboard-attention">
          <div className="dashboard-panel-head">
            <div>
              <p className="eyebrow">Next actions</p>
              <h3>现在需要你处理</h3>
            </div>
            <button className="icon-button" aria-label="刷新工作台" title="刷新工作台" onClick={onRefresh}>
              <RefreshCcw className={loading ? "spin" : ""} size={17} />
            </button>
          </div>
          {dashboard?.attention.length ? (
            <div className="attention-list">
              {dashboard.attention.map((item) => (
                <button key={item.courseId} className="attention-item" onClick={() => onOpenCourse(item)}>
                  <span className="attention-signal"><CircleAlert size={17} /></span>
                  <span className="attention-copy">
                    <small>{item.studentName} · {item.type === "trial" ? "试听课" : "正式课"}</small>
                    <strong>{item.title}</strong>
                    <span>{item.reason}</span>
                  </span>
                  <span className="attention-action">{actionLabel(item.nextAction)} <ArrowRight size={15} /></span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="今天很从容" description="没有失败任务或待确认的课后总结，可以开始准备下一节课。" />
          )}
        </section>

        <section className="dashboard-panel dashboard-upcoming">
          <div className="dashboard-panel-head">
            <div>
              <p className="eyebrow">Schedule</p>
              <h3>接下来的课程</h3>
            </div>
            <button className="text-button" onClick={() => onNavigate("courses")}>全部课程 <ArrowRight size={15} /></button>
          </div>
          {dashboard?.upcomingCourses.length ? (
            <div className="upcoming-list">
              {dashboard.upcomingCourses.map((item) => (
                <button key={item.courseId} className="upcoming-item" onClick={() => onOpenCourse(item)}>
                  <span className="upcoming-time">{compactDate(item.lessonTime)}</span>
                  <span className="upcoming-copy"><strong>{item.title}</strong><small>{item.studentName} · {item.durationMinutes} 分钟</small></span>
                  <StatusBadge status={item.status} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="还没有排课" description="创建课程并设置上课时间后，会自动出现在这里。" />
          )}
        </section>

        <section className="dashboard-panel dashboard-activity">
          <div className="dashboard-panel-head">
            <div>
              <p className="eyebrow">Activity</p>
              <h3>最近动态</h3>
            </div>
          </div>
          {dashboard?.recentActivity.length ? (
            <div className="activity-list">
              {dashboard.recentActivity.slice(0, 7).map((item) => (
                <button
                  key={item.id}
                  className="activity-item"
                  disabled={!item.courseId}
                  onClick={() => {
                    if (!item.courseId || !item.studentId) return;
                    onOpenCourse({
                      courseId: item.courseId,
                      studentId: item.studentId,
                      studentName: "",
                      title: item.title,
                      type: "formal",
                      lessonTime: "",
                      durationMinutes: 0,
                      status: item.status as DashboardCourseSummary["status"],
                      updatedAt: item.occurredAt,
                      nextAction: "review"
                    });
                  }}
                >
                  <span className="activity-icon"><ActivityIcon item={item} /></span>
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  <time>{compactDate(item.occurredAt)}</time>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="暂无动态" description="新建课程、运行任务或上传资料后，这里会记录最近变化。" />
          )}
        </section>
      </div>

      <InsightsPanel insights={insights} onRefresh={onRefreshInsights} />
    </div>
  );
}
