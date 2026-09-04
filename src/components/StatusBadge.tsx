import type { CourseStatus } from "../types";

const labels: Record<CourseStatus, string> = {
  draft: "待准备",
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "需处理",
  canceled: "已取消"
};

export function StatusBadge({ status }: { status: CourseStatus }) {
  return <span className={`studio-status status-${status}`}>{labels[status]}</span>;
}
