import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Link2, Loader2 } from "lucide-react";
import { api } from "../../api";
import { FeishuSetup } from "./FeishuSetup";

interface ConnectionStatus {
  connection: { appConfigured: boolean; connected: boolean; userName: string };
  settings: { syncEnabled: boolean };
}

export function FeishuConnectionPrompt() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.get<ConnectionStatus>("/api/feishu/settings"));
      setUnavailable(false);
    } catch { setUnavailable(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    api.get<ConnectionStatus>("/api/feishu/settings").then((data) => {
      if (active) { setStatus(data); setUnavailable(false); }
    }).catch(() => { if (active) setUnavailable(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const close = useCallback(() => { setOpen(false); void load(); }, [load]);
  const connected = status?.connection.connected && !unavailable;
  const ready = connected && status?.settings.syncEnabled;
  const title = loading ? "正在检查飞书连接" : unavailable ? "配置你的飞书连接" : ready ? "飞书已连接，备课完成后自动同步" : connected ? "飞书已连接，设置备课同步" : status?.connection.appConfigured ? "完成飞书授权，接收备课成果" : "连接飞书，让备课成果自动送达";
  const description = unavailable ? "暂时无法读取连接状态，你可以打开配置引导重新检查。" : ready ? "文件保存位置、课程日历和完成提醒，都可以在这里调整。" : "按引导连接你的飞书，设置文件保存位置、课程日历和完成提醒。";

  return (
    <>
      <section className={`feishu-home-prompt${ready ? " connected" : ""}`} aria-label="飞书配置提示">
        <span className="feishu-prompt-icon" aria-hidden="true">{loading ? <Loader2 className="spin" size={22} /> : ready ? <CheckCircle2 size={22} /> : <Link2 size={22} />}</span>
        <div className="feishu-prompt-copy">
          <div><h3>{title}</h3><span>{loading ? "检查中" : ready ? "已连接" : "当前账号"}</span></div>
          <p>{description}</p>
        </div>
        <button type="button" className={ready ? "ghost-button" : "primary-button"} onClick={() => setOpen(true)}>{ready ? "管理飞书" : "配置飞书"}<ArrowRight size={15} /></button>
      </section>
      {open ? <FeishuSetup onClose={close} /> : null}
    </>
  );
}
