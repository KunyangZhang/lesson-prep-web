import express from "express";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { Store } from "./store.js";
import { authMiddleware, clearSessionCookie, createAdminUser, getSecret, setSessionCookie, updateUserCredentials, verifyPassword } from "./auth.js";
import { authRateLimit, clearAuthRateLimit, securityHeaders } from "./security.js";
import type { User } from "./types.js";

// A separate application process per account also isolates jobs and RAG caches.
const registryPath = path.join(config.dataDir, "accounts.json");
const metaPath = path.join(config.dataDir, "accounts-meta.json");
fs.mkdirSync(config.dataDir, { recursive: true });
const registry = new Store(registryPath);
if (!fs.existsSync(registryPath)) {
  const legacy = new Store();
  registry.data.users = legacy.data.users;
  registry.save();
  fs.chmodSync(registryPath, 0o600);
}
if (!fs.existsSync(metaPath)) {
  const owner = registry.data.users.find((user) => user.username.toLowerCase() === "kunyang") || registry.data.users[0];
  fs.writeFileSync(metaPath, JSON.stringify({ legacyOwnerId: owner?.id || null }), { mode: 0o600 });
}
const legacyOwnerId = (JSON.parse(fs.readFileSync(metaPath, "utf8")) as { legacyOwnerId: string | null }).legacyOwnerId;
const secret = getSecret();
const workers = new Map<string, { child: ChildProcess; ready: Promise<number> }>();
const workerFile = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url));

function accountWorker(user: User): Promise<number> {
  const existing = workers.get(user.id);
  if (existing) return existing.ready;
  if (!/^user_[A-Za-z0-9_-]+$/.test(user.id)) return Promise.reject(new Error("账号 ID 无效。"));
  const legacy = user.id === legacyOwnerId;
  const accountRoot = path.join(config.dataDir, "accounts", user.id);
  const dataDir = legacy ? config.dataDir : path.join(accountRoot, "data");
  const workspaceRoot = legacy ? config.workspaceRoot : path.join(accountRoot, "workspace");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(dataDir, "app-db.json"));
  store.data.users = [user];
  store.save();
  const child = fork(workerFile, [], {
    cwd: config.projectRoot,
    env: {
      ...process.env, PORT: "0", PREP_LISTEN_HOST: "127.0.0.1",
      APP_DATA_DIR: dataDir, PREP_WORKSPACE: workspaceRoot, SESSION_SECRET: secret,
      PREP_ACCOUNT_ID: user.id, PREP_LEGACY_ACCOUNT: String(legacy),
      PREP_PRIVATE_DATA_ROOT: config.dataDir
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[account ${user.id}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[account ${user.id}] ${chunk}`));
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("账号工作台启动超时，请稍后重试。")); }, 30_000);
    child.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "type" in message && message.type === "ready" && "port" in message && typeof message.port === "number") {
        clearTimeout(timer); resolve(message.port);
      }
    });
    child.on("error", () => { clearTimeout(timer); workers.delete(user.id); reject(new Error("账号工作台启动失败。")); });
    child.on("exit", () => { clearTimeout(timer); workers.delete(user.id); reject(new Error("账号工作台已停止，请重试。")); });
  });
  workers.set(user.id, { child, ready });
  return ready;
}

const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
app.use(securityHeaders);
const json = express.json({ limit: "32kb" });
const requireAuth = authMiddleware(registry);

app.get("/api/health", (_req, res) => res.json({ ok: true, accountIsolation: true }));
app.get("/api/system", (_req, res) => res.json({ setupRequired: registry.data.users.length === 0, workspaceRoot: "当前账号独立工作区", codexAutoRun: config.codexAutoRun, codexRunner: config.codexRunner, ragChunkCount: 0 }));
app.post("/api/setup", json, authRateLimit, async (req, res, next) => {
  try {
    if (registry.data.users.length) { res.status(409).json({ error: "初始化已完成。" }); return; }
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (username.length < 2 || password.length < 8) { res.status(400).json({ error: "账号至少 2 个字符，密码至少 8 个字符。" }); return; }
    const user = await createAdminUser(registry, username, password);
    clearAuthRateLimit(req); setSessionCookie(res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  } catch (error) { next(error); }
});
app.post("/api/login", json, authRateLimit, async (req, res, next) => {
  try {
    const user = await verifyPassword(registry, typeof req.body.username === "string" ? req.body.username.trim() : "", typeof req.body.password === "string" ? req.body.password : "");
    if (!user) { res.status(401).json({ error: "用户名或密码不正确。" }); return; }
    clearAuthRateLimit(req); setSessionCookie(res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  } catch (error) { next(error); }
});
app.post("/api/logout", (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.get("/api/me", requireAuth, (_req, res) => res.json({ user: res.locals.user }));
app.patch("/api/me", json, requireAuth, async (req, res, next) => {
  try {
    const string = (value: unknown) => typeof value === "string" ? value : "";
    const user = await updateUserCredentials(registry, res.locals.user.id, string(req.body.currentPassword), string(req.body.username), string(req.body.newPassword));
    if (!user) { res.status(404).json({ error: "账号不存在。" }); return; }
    const worker = workers.get(user.id)?.child;
    if (worker?.connected) worker.send({ type: "identity-updated", user });
    setSessionCookie(res, user.id); res.json({ user: { id: user.id, username: user.username } });
  } catch (error) { next(error); }
});

app.use("/api", requireAuth, async (req, res, next) => {
  try {
    const user = registry.findUserById(res.locals.user.id)!;
    const port = await accountWorker(user);
    const upstream = http.request({ hostname: "127.0.0.1", port, method: req.method, path: req.originalUrl, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.status(502).json({ error: "账号工作台暂时不可用，请重试。" }); else res.destroy(); });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  } catch (error) { next(error); }
});

const clientRoot = path.join(config.projectRoot, "dist", "client");
if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientRoot));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(clientRoot, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root: config.projectRoot, server: { middlewareMode: true }, appType: "custom" });
  app.use(vite.middlewares);
  app.get(/.*/, async (req, res, next) => {
    try {
      const template = fs.readFileSync(path.join(config.projectRoot, "index.html"), "utf8");
      res.type("html").send(await vite.transformIndexHtml(req.originalUrl, template));
    } catch (error) { next(error); }
  });
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: error.message || "请求未完成，请重试。" });
});

const server = app.listen(config.port, process.env.PREP_LISTEN_HOST || "0.0.0.0", () => {
  console.log(`Account gateway listening on ${config.port}`);
  if (process.send) process.send({ type: "ready" });
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const worker of workers.values()) worker.child.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
