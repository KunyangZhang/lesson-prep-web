import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, CheckCircle2, ChevronRight, ExternalLink, FolderOpen, Link2, Loader2, RefreshCcw, Save, X } from "lucide-react";
import { api } from "../../api";

interface Settings {
  syncEnabled: boolean;
  folderToken: string;
  notifyEnabled: boolean;
  notifyOpenId: string;
  calendarEnabled: boolean;
  calendarId: string;
  attendeeIds: string;
}
interface Status {
  settings: Settings;
  connection: { appConfigured: boolean; appId: string; connected: boolean; userName: string; message: string };
  authorization: { verificationUrl: string; expiresAt: string; state: "pending" | "authorized" | "failed" | "expired" } | null;
}

const steps = ["配置应用", "连接账号", "同步选项"];

export function FeishuSetup({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [step, setStep] = useState(0);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [changingApp, setChangingApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (verify = false) => {
    const data = verify ? await api.post<Status>("/api/feishu/verify") : await api.get<Status>("/api/feishu/settings");
    setStatus(data);
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    api.get<Status>("/api/feishu/settings").then((data) => {
      if (!active) return;
      setStatus(data); setForm(data.settings); setAppId(data.connection.appId);
      setStep(data.connection.connected ? 2 : data.connection.appConfigured ? 1 : 0);
    }).catch((err: Error) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (status?.authorization?.state !== "pending") return;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      refresh().catch((err: Error) => setError(err.message)).finally(() => { checking = false; });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [status?.authorization?.state, refresh]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select, textarea, [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);

  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(""); setSaved(false);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current); setSaved(false);
  }
  async function configureApp(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const data = await api.post<Status>("/api/feishu/app", { appId, appSecret });
      setStatus(data); setAppSecret(""); setChangingApp(false); setStep(1);
    });
  }
  async function authorize() {
    await action(async () => {
      const authorization = await api.post<NonNullable<Status["authorization"]>>("/api/feishu/authorize");
      setStatus((current) => current ? { ...current, authorization } : current);
    });
  }
  async function save() {
    await action(async () => {
      const data = await api.patch<{ settings: Settings }>("/api/feishu/settings", form);
      setForm(data.settings); setSaved(true);
    });
  }

  return createPortal(
    <div className="setup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="feishu-setup" role="dialog" aria-modal="true" aria-labelledby="feishu-setup-title" tabIndex={-1} ref={dialog} onSubmit={(event) => event.stopPropagation()}>
        <header className="setup-header">
          <div className="setup-brand"><span><Link2 size={23} /></span><div><p className="eyebrow">飞书集成</p><h2 id="feishu-setup-title">连接你的备课空间</h2></div></div>
          <button type="button" className="icon-button" aria-label="关闭飞书设置" onClick={onClose}><X size={19} /></button>
        </header>
        <p className="setup-intro">连接当前登录账号的飞书，将备课文件、课程日历和完成提醒放在一起。授权与配置仅属于你的账号。</p>
        <ol className="setup-steps" aria-label="飞书配置步骤">
          {steps.map((label, index) => <li key={label} className={step === index ? "current" : step > index ? "done" : ""}>
            <button type="button" aria-current={step === index ? "step" : undefined} disabled={loading || busy || (index > 0 && !status?.connection.appConfigured)} onClick={() => setStep(index)}>
              <i>{step > index ? <Check size={13} /> : index + 1}</i><span>{label}</span>
            </button>
          </li>)}
        </ol>
        {loading ? <div className="setup-loading"><Loader2 className="spin" size={22} />正在读取连接状态</div> : null}
        {error ? <div className="setup-feedback error" role="alert">{error}{!status ? <button type="button" onClick={() => { setLoading(true); refresh().then((data) => { setForm(data.settings); setAppId(data.connection.appId); setError(""); }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false)); }}>重试</button> : null}</div> : null}
        {!loading && status && form ? <div className="setup-content">
          {step === 0 ? <section>
            <div className="setup-section-title"><h3>先准备一个飞书应用</h3><p>在飞书开放平台创建企业自建应用，复制凭证到这里。</p></div>
            {status.connection.appConfigured && !changingApp ? <>
              <div className="setup-connection"><CheckCircle2 size={22} /><div><strong>已配置应用</strong><small>{status.connection.appId}</small></div><button type="button" className="text-button" onClick={() => setChangingApp(true)}>更换</button></div>
              <div className="setup-footer"><span>可以直接继续连接你的飞书账号。</span><button type="button" className="primary-button" onClick={() => setStep(1)}>下一步<ChevronRight size={15} /></button></div>
            </> : <form onSubmit={configureApp} className="setup-app-form">
              <a className="setup-help-link" href="https://open.feishu.cn/app" target="_blank" rel="noreferrer"><ExternalLink size={15} />打开飞书开放平台<ChevronRight size={14} /></a>
              <div className="setup-instructions"><span>1. 创建企业自建应用</span><span>2. 打开「凭证与基础信息」</span><span>3. 复制 App ID 和 App Secret</span></div>
              <label>App ID<input autoComplete="off" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" required /></label>
              <label>App Secret<input type="password" autoComplete="new-password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder="粘贴应用密钥" required /></label>
              <small className="setup-muted">密钥保存在服务器端，保存后不会回显。</small>
              <div className="setup-footer"><span>{changingApp ? "更换应用后需重新授权。" : "下一步将在飞书中确认授权。"}</span><button className="primary-button" disabled={busy}>{busy ? <Loader2 className="spin" size={15} /> : null}保存并继续<ChevronRight size={15} /></button></div>
            </form>}
          </section> : null}
          {step === 1 ? <section>
            <div className="setup-section-title"><h3>授权你的飞书账号</h3><p>允许备课工作台管理云文档、云盘、课程日历和消息。</p></div>
            <div className={`setup-connection${status.connection.connected ? " connected" : ""}`}><Link2 size={24} /><div><strong>{status.connection.connected ? status.connection.userName || "账号已连接" : "等待连接飞书"}</strong><small>{status.connection.message}</small></div></div>
            {status.authorization?.state === "pending" ? <div className="setup-authorization">
              <strong>在飞书页面完成授权</strong><p>打开下方链接，在飞书中确认。完成后这里会自动更新。</p>
              <a className="primary-button" href={status.authorization.verificationUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开飞书授权页面</a>
              <small><Loader2 className="spin" size={13} />等待授权 · 链接有效至 {new Date(status.authorization.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
            </div> : null}
            {status.authorization && ["failed", "expired"].includes(status.authorization.state) ? <p className="setup-feedback">授权未完成或链接已过期，请重新连接。</p> : null}
            {!status.connection.connected && status.authorization?.state !== "pending" ? <button type="button" className="primary-button" disabled={busy} onClick={authorize}>{busy ? <Loader2 className="spin" size={16} /> : <Link2 size={16} />}连接飞书账号</button> : null}
            <div className="setup-permissions"><strong>权限提示</strong><p>如飞书提示权限不足，请在应用的「权限管理」中开通相应权限并发布版本，再重新授权。</p></div>
            <div className="setup-footer"><button type="button" className="text-button" onClick={() => setStep(0)}><ArrowLeft size={14} />上一步</button><div><button type="button" className="ghost-button" disabled={busy} onClick={() => action(async () => { await refresh(true); })}><RefreshCcw className={busy ? "spin" : ""} size={14} />检查连接</button><button type="button" className="primary-button" onClick={() => setStep(2)}>同步选项<ChevronRight size={15} /></button></div></div>
          </section> : null}
          {step === 2 ? <section>
            <div className="setup-section-title"><h3>选择备课内容的去处</h3><p>保存后立即生效，下次备课完成时会使用这些设置。</p></div>
            {!status.connection.connected ? <div className="setup-feedback">飞书账号尚未连接，保存后还需要完成授权。<button type="button" className="text-button" onClick={() => setStep(1)}>前往连接</button></div> : null}
            <div className="setup-option"><div><strong><FolderOpen size={17} />同步备课文件</strong><small>每节课创建独立文件夹，保存讲义与备课产物。</small></div><input type="checkbox" role="switch" aria-label="同步备课文件" checked={form.syncEnabled} onChange={(event) => update("syncEnabled", event.target.checked)} /></div>
            {form.syncEnabled ? <label className="setup-indented">保存位置<input value={form.folderToken} onChange={(event) => update("folderToken", event.target.value)} placeholder="粘贴飞书云盘文件夹链接" /><small>在飞书云盘打开目标文件夹，复制浏览器地址。</small></label> : null}
            <div className="setup-option"><div><strong>完成后通知我</strong><small>备课完成时，通过飞书发送结果提醒。</small></div><input type="checkbox" role="switch" aria-label="飞书完成通知" checked={form.notifyEnabled} onChange={(event) => update("notifyEnabled", event.target.checked)} /></div>
            <div className="setup-option"><div><strong>同步课程日历</strong><small>根据上课时间和课时创建日历安排。</small></div><input type="checkbox" role="switch" aria-label="同步课程日历" checked={form.calendarEnabled} onChange={(event) => update("calendarEnabled", event.target.checked)} /></div>
            <details className="setup-advanced"><summary>更多选项（可选）</summary>
              <label>通知接收人 Open ID<input value={form.notifyOpenId} onChange={(event) => update("notifyOpenId", event.target.value)} placeholder="留空则通知当前授权用户" /></label>
              <label>日历 ID<input value={form.calendarId} onChange={(event) => update("calendarId", event.target.value)} placeholder="留空使用默认日历" /></label>
              <label>日历参与人<input value={form.attendeeIds} onChange={(event) => update("attendeeIds", event.target.value)} placeholder="多个 Open ID 用逗号分隔" /></label>
            </details>
            {saved ? <div className="setup-saved" role="status"><CheckCircle2 size={18} />已保存当前账号的飞书配置。</div> : null}
            <div className="setup-footer"><button type="button" className="text-button" onClick={() => setStep(1)}><ArrowLeft size={14} />上一步</button><div>{saved ? <button type="button" className="ghost-button" onClick={onClose}>完成</button> : null}<button type="button" className="primary-button" disabled={busy} onClick={save}>{busy ? <Loader2 className="spin" size={15} /> : <Save size={15} />}保存配置</button></div></div>
          </section> : null}
        </div> : null}
      </div>
    </div>, document.body
  );
}
