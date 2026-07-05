import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../dist/server/store.js";
import { checkpointRagIndex, markMaterialIndexFailed } from "../dist/server/rag.js";

const projectRoot = "/root/lesson-prep-web";
const listPath = process.argv[2];
if (!listPath) {
  console.error("Usage: node scripts/rerun-rag-files.mjs <file-list.txt>");
  process.exit(1);
}

const logPath = path.join(projectRoot, "data/logs/rag-rerun-files.log");
const workerPath = path.join(projectRoot, "dist/server/rag-worker.js");
const timeoutMs = Number(process.env.RAG_RERUN_TIMEOUT_MS || process.env.RAG_WORKER_TIMEOUT_MS || 300_000);
const heapMb = Number(process.env.RAG_RERUN_HEAP_MB || process.env.RAG_WORKER_MAX_OLD_SPACE_MB || 512);

function log(message, details = {}) {
  const line = `[rag-rerun-files] ${new Date().toISOString()} ${message} ${JSON.stringify(details)}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
  console.log(line);
}

function runWorker(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, workerPath, filePath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: true
    });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = stderr.trim();
      const error =
        signal === "SIGKILL" && timedOut
          ? `worker timeout after ${Math.round(timeoutMs / 1000)}s${detail ? `: ${detail}` : ""}`
          : signal === "SIGKILL"
          ? `worker killed${detail ? `: ${detail}` : ""}`
          : `worker ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`;
      resolve({ ok: false, error });
    });
  });
}

const files = fs
  .readFileSync(path.resolve(listPath), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const failures = [];
log("batch-start", { total: files.length, timeoutMs, heapMb, listPath: path.resolve(listPath) });
for (let index = 0; index < files.length; index += 1) {
  const file = files[index];
  const startedAt = Date.now();
  log("file-start", { index: index + 1, total: files.length, file });
  const result = await runWorker(file);
  const elapsedMs = Date.now() - startedAt;
  if (result.ok) {
    log("file-indexed", { index: index + 1, total: files.length, elapsedMs, file });
    continue;
  }

  const error = result.error || "索引进程失败";
  failures.push({ file, error });
  try {
    const store = new Store();
    markMaterialIndexFailed(store, file, error);
    log("file-failed-marked", { index: index + 1, total: files.length, elapsedMs, file, error });
  } catch (markError) {
    log("file-failed-mark-error", {
      index: index + 1,
      total: files.length,
      elapsedMs,
      file,
      error,
      markError: markError instanceof Error ? markError.message : String(markError)
    });
  }
}
log("batch-end", { total: files.length, failures: failures.length });
try {
  log("wal-checkpoint", { mode: "TRUNCATE", result: checkpointRagIndex() });
} catch (error) {
  log("wal-checkpoint-failed", { mode: "TRUNCATE", error: error instanceof Error ? error.message : String(error) });
}
if (failures.length > 0) process.exitCode = 1;
