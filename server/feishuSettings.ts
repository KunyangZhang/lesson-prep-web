import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { config } from "./config.js";
import { runLarkCliWithCurrentAuth } from "./larkCli.js";

export interface FeishuSettings {
  syncEnabled: boolean;
  folderToken: string;
  notifyEnabled: boolean;
  notifyOpenId: string;
  calendarEnabled: boolean;
  calendarId: string;
  attendeeIds: string;
}

interface AuthStatus {
  appId?: string;
  identities?: { user?: { available?: boolean; userName?: string } };
}

interface Authorization {
  ownerId: string;
  verificationUrl: string;
  expiresAt: string;
  state: "pending" | "authorized" | "failed" | "expired";
}

type CliRunner = (args: string[], options?: { timeoutMs?: number; stdin?: string }) => Promise<{ data: unknown }>;

class SetupError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function normalizeFolderToken(value: string) {
  const input = value.trim();
  if (!input) return "";
  if (/^[A-Za-z0-9_-]{5,200}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const token = /^\/drive\/folder\/([A-Za-z0-9_-]{5,200})\/?$/.exec(url.pathname)?.[1];
    if (url.protocol === "https:" && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) && token) return token;
  } catch { /* Return a clear input error below. */ }
  throw new SetupError("请粘贴飞书文件夹链接，或填写有效的文件夹 token。");
}

export class FeishuSettingsService {
  private authorization: Authorization | null = null;
  private connecting = false;

  constructor(
    private readonly settingsPath = path.join(config.dataDir, "feishu-settings.json"),
    private readonly runCli: CliRunner = runLarkCliWithCurrentAuth,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  settings(): FeishuSettings {
    const env = this.environment;
    const freshAccount = Boolean(env.PREP_ACCOUNT_ID) && env.PREP_LEGACY_ACCOUNT !== "true";
    const defaults: FeishuSettings = {
      syncEnabled: freshAccount ? false : env.FEISHU_SYNC_ENABLED !== "false",
      folderToken: freshAccount ? "" : env.LESSON_FEISHU_PARENT_FOLDER_TOKEN || env.FEISHU_LESSON_PARENT_FOLDER_TOKEN || "LY9efBiWjlEAQWdqPrucuLl4nic",
      notifyEnabled: true,
      notifyOpenId: freshAccount ? "" : env.FEISHU_NOTIFY_OPEN_ID || env.FEISHU_CLI_NOTIFY_OPEN_ID || env.FEISHU_LESSON_NOTIFY_OPEN_ID || "",
      calendarEnabled: freshAccount ? false : env.FEISHU_LESSON_CALENDAR_ENABLED !== "false",
      calendarId: freshAccount ? "" : env.FEISHU_LESSON_CALENDAR_ID || "",
      attendeeIds: freshAccount ? "" : env.FEISHU_LESSON_CALENDAR_ATTENDEE_IDS || ""
    };
    if (!fs.existsSync(this.settingsPath)) return defaults;
    return { ...defaults, ...JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) as Partial<FeishuSettings> };
  }

  save(input: unknown) {
    if (!input || typeof input !== "object") throw new SetupError("配置格式不正确。");
    const body = input as Record<string, unknown>;
    const settings = this.settings();
    for (const key of ["syncEnabled", "notifyEnabled", "calendarEnabled"] as const) {
      if (key in body) {
        if (typeof body[key] !== "boolean") throw new SetupError("开关配置格式不正确。");
        settings[key] = body[key];
      }
    }
    for (const key of ["folderToken", "notifyOpenId", "calendarId", "attendeeIds"] as const) {
      if (key in body) {
        if (typeof body[key] !== "string" || body[key].length > 2000) throw new SetupError("配置内容过长或格式不正确。");
        settings[key] = body[key].trim();
      }
    }
    settings.folderToken = normalizeFolderToken(settings.folderToken);
    if (settings.syncEnabled && !settings.folderToken) throw new SetupError("请先选择用于保存备课文件的飞书文件夹。");
    if (settings.notifyOpenId && !/^ou_[A-Za-z0-9_-]+$/.test(settings.notifyOpenId)) throw new SetupError("通知接收人请填写以 ou_ 开头的 Open ID，也可以留空通知当前授权用户。");
    if (settings.calendarId && !/^[A-Za-z0-9_.@-]+$/.test(settings.calendarId)) throw new SetupError("日历 ID 格式不正确。");
    if (settings.attendeeIds && !/^[A-Za-z0-9_,\s-]+$/.test(settings.attendeeIds)) throw new SetupError("参与人 ID 格式不正确。");
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    const temp = `${this.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.settingsPath);
    return settings;
  }

  private publicAuthorization(ownerId: string) {
    const flow = this.authorization;
    if (!flow || flow.ownerId !== ownerId) return null;
    if (flow.state === "pending" && Date.parse(flow.expiresAt) <= Date.now()) flow.state = "expired";
    return { verificationUrl: flow.verificationUrl, expiresAt: flow.expiresAt, state: flow.state };
  }

  async status(ownerId: string, verify = false) {
    let connection = { appConfigured: false, appId: "", connected: false, userName: "", message: "尚未连接飞书，请先配置应用。" };
    try {
      const args = ["auth", "status", "--json"];
      if (verify) args.push("--verify");
      const result = await this.runCli(args, { timeoutMs: 20_000 });
      const data = result.data as AuthStatus;
      const user = data.identities?.user;
      connection = {
        appConfigured: Boolean(data.appId), appId: data.appId || "",
        connected: user?.available === true, userName: user?.userName || "",
        message: user?.available ? "飞书账号已连接。" : data.appId ? "应用已配置，请完成飞书账号授权。" : "尚未连接飞书，请先配置应用。"
      };
    } catch {
      connection.message = "暂时无法读取飞书连接状态，请检查应用配置后重试。";
    }
    return { settings: this.settings(), connection, authorization: this.publicAuthorization(ownerId) };
  }

  async configureApp(ownerId: string, input: unknown) {
    if (this.connecting || (this.authorization?.state === "pending" && Date.parse(this.authorization.expiresAt) > Date.now())) {
      throw new SetupError("正在授权飞书账号，请完成授权后再更换应用。", 409);
    }
    const body = (input || {}) as Record<string, unknown>;
    if (typeof body.appId !== "string" || !/^cli_[A-Za-z0-9]+$/.test(body.appId.trim())) throw new SetupError("请填写以 cli_ 开头的 App ID。");
    if (typeof body.appSecret !== "string" || body.appSecret.trim().length < 6 || body.appSecret.length > 512 || /[\r\n]/.test(body.appSecret)) throw new SetupError("请填写有效的 App Secret。");
    this.connecting = true;
    try {
      const args = ["config", "init", "--app-id", body.appId.trim(), "--app-secret-stdin", "--brand", "feishu"];
      await this.runCli(args, { stdin: `${body.appSecret.trim()}\n`, timeoutMs: 20_000 });
      this.authorization = null;
    } catch {
      throw new SetupError("应用配置未成功，请核对 App ID 和 App Secret 后重试。");
    } finally { this.connecting = false; }
    return this.status(ownerId);
  }

  async authorize(ownerId: string) {
    if (this.connecting) throw new SetupError("正在准备飞书连接，请稍后再试。", 409);
    const flow = this.authorization;
    if (flow?.state === "pending" && Date.parse(flow.expiresAt) > Date.now()) {
      if (flow.ownerId !== ownerId) throw new SetupError("其他用户正在连接飞书，请稍后再试。", 409);
      return this.publicAuthorization(ownerId);
    }
    this.connecting = true;
    try {
      const result = await this.runCli(["auth", "login", "--domain", "docs,drive,calendar,im", "--no-wait", "--json"], { timeoutMs: 30_000 });
      const data = result.data as { device_code?: string; verification_url?: string; expires_in?: number };
      const url = new URL(data.verification_url || "");
      if (!data.device_code || url.protocol !== "https:" || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) throw new Error("Invalid authorization response");
      const seconds = Math.min(600, Math.max(30, Number(data.expires_in) || 600));
      const next: Authorization = { ownerId, verificationUrl: url.href, expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), state: "pending" };
      this.authorization = next;
      // Poll in the background so the browser can show the authorization link immediately.
      void this.runCli(["auth", "login", "--device-code", data.device_code, "--json"], { timeoutMs: seconds * 1000 })
        .then(() => { if (this.authorization === next && next.state === "pending") next.state = "authorized"; })
        .catch(() => { if (this.authorization === next && next.state === "pending") next.state = Date.parse(next.expiresAt) <= Date.now() ? "expired" : "failed"; });
      return this.publicAuthorization(ownerId);
    } catch {
      throw new SetupError("无法发起飞书授权，请核对应用配置和网络后重试。");
    } finally { this.connecting = false; }
  }
}

export const feishuSettingsService = new FeishuSettingsService();
export const getFeishuSettings = () => feishuSettingsService.settings();

export function createFeishuSettingsRouter() {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const handle = (fn: (body: unknown, userId: string) => unknown) => async (req: import("express").Request, res: import("express").Response) => {
    try { res.json(await fn(req.body, res.locals.user.id as string)); }
    catch (error) { res.status(error instanceof SetupError ? error.status : 500).json({ error: error instanceof SetupError ? error.message : "飞书配置暂时不可用，请稍后重试。" }); }
  };
  router.get("/settings", handle((_body, id) => feishuSettingsService.status(id)));
  router.patch("/settings", handle((body) => ({ settings: feishuSettingsService.save(body) })));
  router.post("/app", handle((body, id) => feishuSettingsService.configureApp(id, body)));
  router.post("/authorize", handle((_body, id) => feishuSettingsService.authorize(id)));
  router.post("/verify", handle((_body, id) => feishuSettingsService.status(id, true)));
  return router;
}
