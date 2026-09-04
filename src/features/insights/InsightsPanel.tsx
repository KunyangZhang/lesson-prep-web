import { Activity, BookCheck, RefreshCcw, RotateCw, Target } from "lucide-react";
import type { LearningInsights } from "../../types";

export function InsightsPanel({ insights, onRefresh }: { insights: LearningInsights | null; onRefresh: () => void }) {
  if (!insights) return null;
  const maxLessons = Math.max(1, ...insights.weeklyLessons.map((item) => item.count));

  return (
    <section className="insights-panel">
      <header className="insights-head">
        <div><p className="eyebrow">Teaching signals</p><h3>教学与备课趋势</h3><span>只统计系统内可验证的课程、任务和质量记录</span></div>
        <button className="icon-button" onClick={onRefresh} aria-label="刷新趋势" title="刷新趋势"><RefreshCcw size={16} /></button>
      </header>

      <div className="insights-summary">
        <article><Activity size={17} /><strong>{insights.summary.weeklyLessonCount}</strong><span>本周课程</span></article>
        <article><BookCheck size={17} /><strong>{insights.summary.completionRate}%</strong><span>课程完成率</span></article>
        <article><Target size={17} /><strong>{insights.summary.postClassConfirmationRate}%</strong><span>课后确认率</span></article>
        <article><RotateCw size={17} /><strong>{insights.summary.refineRate}%</strong><span>补充生成率</span></article>
      </div>

      <div className="insights-grid">
        <section className="weekly-chart">
          <div className="insight-title"><strong>近六周课程量</strong><small>按课程时间统计</small></div>
          <div className="weekly-bars">
            {insights.weeklyLessons.map((week) => (
              <div key={week.start} className="weekly-bar-item">
                <span>{week.count}</span>
                <i style={{ height: `${Math.max(7, (week.count / maxLessons) * 100)}%` }} />
                <small>{week.label.split("-")[0]}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="weak-points-card">
          <div className="insight-title"><strong>高频薄弱点</strong><small>来自学生长期档案</small></div>
          {insights.recurringWeakPoints.length ? (
            <div className="weak-point-list">
              {insights.recurringWeakPoints.slice(0, 6).map((item) => (
                <span key={item.label}><strong>{item.label}</strong><small>{item.count} 人次</small></span>
              ))}
            </div>
          ) : <div className="insight-empty">完善学生薄弱点后，这里会显示共同教学重点。</div>}
        </section>

        <section className="quality-trend-card">
          <div className="insight-title"><strong>质量与迭代</strong><small>最近 {insights.qualityTrend.length} 次检查</small></div>
          <div className="quality-trend-summary">
            <span><strong>{insights.summary.averageQualityScore ?? "—"}</strong><small>平均质量分</small></span>
            <span><strong>{insights.revisions.coursesWithRevisions}</strong><small>有修订的课程</small></span>
            <span><strong>{insights.revisions.totalRefinements}</strong><small>补充生成次数</small></span>
          </div>
          {insights.qualityTrend.length ? (
            <div className="quality-sparkline" aria-label="质量分趋势">
              {insights.qualityTrend.map((item) => <i key={item.jobId} style={{ height: `${Math.max(8, item.score)}%` }} title={`${item.score} 分`} />)}
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}
