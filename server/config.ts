import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv(projectRoot: string) {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

function resolveFromProject(projectRoot: string, value: string) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

function optionalNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const currentFile = fileURLToPath(import.meta.url);
const serverDir = path.dirname(currentFile);
const runningFromDist = serverDir.includes(`${path.sep}dist${path.sep}server`);
const projectRoot = process.cwd().endsWith(`${path.sep}lesson-prep-web`)
  ? process.cwd()
  : path.resolve(serverDir, "..", "..");

loadDotEnv(projectRoot);

export const config = {
  projectRoot,
  workspaceRoot: resolveFromProject(
    projectRoot,
    process.env.PREP_WORKSPACE || path.resolve(projectRoot, "..")
  ),
  dataDir: resolveFromProject(projectRoot, process.env.APP_DATA_DIR || "data"),
  port: Number(process.env.PORT || 4178),
  codexCommand: process.env.CODEX_COMMAND || "codex",
  codexModel: process.env.CODEX_MODEL || "",
  codexAutoRun: (process.env.CODEX_AUTO_RUN || "true").toLowerCase() !== "false",
  codexRunner: (process.env.CODEX_RUNNER || "local").toLowerCase() === "ssh" ? "ssh" : "local",
  codexSshHost: process.env.CODEX_SSH_HOST || "",
  codexSshUser: process.env.CODEX_SSH_USER || "",
  codexSshPort: optionalNumber(process.env.CODEX_SSH_PORT),
  codexSshKey: process.env.CODEX_SSH_KEY || "",
  codexRemoteWorkspace: process.env.CODEX_REMOTE_WORKSPACE || "",
  codexRemoteProjectRoot: process.env.CODEX_REMOTE_PROJECT_ROOT || "",
  codexRemoteCommand: process.env.CODEX_REMOTE_COMMAND || process.env.CODEX_COMMAND || "codex",
  ragMaxReindexFiles: Number(process.env.RAG_MAX_REINDEX_FILES || 300),
  ragReindexBatchSize: Number(process.env.RAG_REINDEX_BATCH_SIZE || 10),
  ragMaxParseBytes: Number(process.env.RAG_MAX_PARSE_BYTES || 20 * 1024 * 1024),
  maxUploadFiles: Number(process.env.MAX_UPLOAD_FILES || 5000),
  trustProxy: optionalBoolean(process.env.TRUST_PROXY, false),
  secureCookies: optionalBoolean(process.env.SECURE_COOKIES, process.env.NODE_ENV === "production"),
  enableHsts: optionalBoolean(process.env.ENABLE_HSTS, false),
  authRateLimitWindowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX || 8),
  runningFromDist
};

export const uploadRoot = path.join(config.workspaceRoot, "资料库", "网页上传");
export const materialRoot = path.join(config.workspaceRoot, "资料库");
export const tempUploadDir = path.join(config.dataDir, "tmp");
export const logsDir = path.join(config.dataDir, "logs");

export function ensureAppDirs() {
  for (const dir of [config.dataDir, tempUploadDir, logsDir, uploadRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
