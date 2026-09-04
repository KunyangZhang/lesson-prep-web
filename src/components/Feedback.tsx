import { Inbox, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

export function LoadingState({ label = "正在整理工作台" }: { label?: string }) {
  return (
    <div className="feedback-state" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={24} />
      <strong>{label}</strong>
      <span>正在读取最新的课程与任务状态</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="feedback-state empty-feedback">
      <Inbox size={24} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{description}</span>
      {action}
    </div>
  );
}

export function RetryButton({ onClick, label = "重新加载" }: { onClick: () => void; label?: string }) {
  return (
    <button className="ghost-button" onClick={onClick}>
      <RotateCcw size={16} />
      {label}
    </button>
  );
}
