import type { ReactNode } from "react";
import {
  BookOpenText,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  CircleUserRound,
  GraduationCap,
  LayoutDashboard,
  LibraryBig
} from "lucide-react";
import type { SystemInfo, User } from "../types";

export type AppView = "dashboard" | "students" | "courses" | "materials";

const navigation: Array<{ key: AppView; label: string; hint: string; icon: typeof LayoutDashboard }> = [
  { key: "dashboard", label: "今日", hint: "总览与待办", icon: LayoutDashboard },
  { key: "students", label: "学生", hint: "档案与学情", icon: GraduationCap },
  { key: "courses", label: "课程", hint: "计划与产物", icon: CalendarDays },
  { key: "materials", label: "资料库", hint: "检索与索引", icon: LibraryBig }
];

export function AppShell({
  view,
  collapsed,
  user,
  system,
  error,
  utility,
  children,
  onViewChange,
  onToggle,
  onDismissError
}: {
  view: AppView;
  collapsed: boolean;
  user: User;
  system: SystemInfo | null;
  error: string;
  utility: ReactNode;
  children: ReactNode;
  onViewChange: (view: AppView) => void;
  onToggle: () => void;
  onDismissError: () => void;
}) {
  return (
    <main className={collapsed ? "app-shell studio-shell-frame sidebar-collapsed" : "app-shell studio-shell-frame"}>
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <aside className="sidebar studio-sidebar" aria-label="主导航">
        <div className="brand studio-brand">
          <div className="brand-mark" aria-hidden="true">
            <BookOpenText size={20} />
          </div>
          <div className="brand-copy">
            <span className="brand-kicker">Lesson studio</span>
            <h1>备课工作台</h1>
          </div>
          <button
            className="tiny-icon-button sidebar-toggle"
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            onClick={onToggle}
          >
            {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          </button>
        </div>

        <nav className="studio-nav" aria-label="工作区">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={view === item.key ? "studio-nav-item active" : "studio-nav-item"}
                aria-current={view === item.key ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                onClick={() => onViewChange(item.key)}
              >
                <Icon size={19} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />

        <section className="studio-system-card" aria-label="系统状态">
          <span className="system-pulse" aria-hidden="true" />
          <div>
            <strong>{system?.codexRunner === "ssh" ? "远程 Agent 就绪" : "本机 Agent 就绪"}</strong>
            <small>{system?.ragChunkCount || 0} 条知识可检索</small>
          </div>
        </section>

        <section className="studio-utility">
          <div className="utility-user" title={user.username}>
            <CircleUserRound size={18} />
            <span>
              <strong>{user.username}</strong>
              <small>个人工作区</small>
            </span>
          </div>
          {utility}
        </section>
      </aside>

      <section className="workspace studio-workspace" id="main-content" tabIndex={-1}>
        {error ? (
          <div className="error-bar studio-error" role="alert">
            <span>{error}</span>
            <button onClick={onDismissError}>关闭</button>
          </div>
        ) : null}
        {children}
      </section>
    </main>
  );
}
