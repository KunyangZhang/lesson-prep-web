import { Check, Circle, LoaderCircle } from "lucide-react";
import type { Course, Job } from "../../types";

type StageState = "done" | "active" | "waiting" | "issue";

export function PreparationTimeline({
  course,
  job,
  fileCount,
  qualityReady
}: {
  course: Course;
  job: Job | null;
  fileCount: number;
  qualityReady: boolean;
}) {
  const generated = course.status === "completed" || fileCount > 0;
  const running = course.status === "queued" || course.status === "running";
  const failed = course.status === "failed" || course.status === "canceled";
  const delivered = Boolean(course.feishuSync?.lastSyncedAt || course.feishuSync?.pdfFileUrl);
  const postClassDone = course.postClassSummary?.status === "confirmed";
  const stages: Array<{ label: string; note: string; state: StageState }> = [
    { label: "课程信息", note: "目标与学情", state: "done" },
    { label: "资料依据", note: course.localFiles ? "资料已关联" : "可继续补充", state: course.localFiles ? "done" : "waiting" },
    {
      label: "AI 生成",
      note: running ? "正在生成" : failed ? "需要继续" : generated ? `${fileCount} 个产物` : "等待启动",
      state: running ? "active" : failed ? "issue" : generated ? "done" : "waiting"
    },
    { label: "质量检查", note: qualityReady ? "已有检查结果" : "尚未检查", state: qualityReady ? "done" : generated ? "active" : "waiting" },
    { label: "交付与沉淀", note: postClassDone ? "课后已确认" : delivered ? "已交付" : "待交付", state: postClassDone ? "done" : delivered ? "active" : "waiting" }
  ];

  return (
    <section className="preparation-timeline" aria-label="备课进度">
      <div className="timeline-heading">
        <div><strong>备课进度</strong><small>从课程信息到课后沉淀</small></div>
        {job?.status === "running" ? <span><LoaderCircle className="spin" size={14} /> Agent 工作中</span> : null}
      </div>
      <ol>
        {stages.map((stage, index) => (
          <li key={stage.label} className={`timeline-stage stage-${stage.state}`}>
            <span className="timeline-marker" aria-hidden="true">
              {stage.state === "done" ? <Check size={13} /> : stage.state === "active" ? <LoaderCircle className="spin" size={13} /> : <Circle size={10} />}
            </span>
            <span><strong>{stage.label}</strong><small>{stage.note}</small></span>
            {index < stages.length - 1 ? <i aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
