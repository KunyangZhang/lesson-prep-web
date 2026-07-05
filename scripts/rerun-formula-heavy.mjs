import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../dist/server/store.js";
import { checkpointRagIndex, markMaterialIndexFailed } from "../dist/server/rag.js";

const projectRoot = "/root/lesson-prep-web";
const listPath = path.join(projectRoot, "data/rag-formula-heavy-reindex.txt");
const logPath = path.join(projectRoot, "data/logs/rag-formula-heavy-rerun.log");
const workerPath = path.join(projectRoot, "dist/server/rag-worker.js");
const timeoutMs = Number(process.env.RAG_FORMULA_RERUN_TIMEOUT_MS || 300_000);
const heapMb = Number(process.env.RAG_FORMULA_RERUN_HEAP_MB || process.env.RAG_WORKER_MAX_OLD_SPACE_MB || 384);

function log(message, details = {}) {
  const line = `[formula-rerun] ${new Date().toISOString()} ${message} ${JSON.stringify(details)}`;
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
    const timer = setTimeout(() => {
      if (settled) return;
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
        signal === "SIGKILL"
          ? `worker timeout after ${Math.round(timeoutMs / 1000)}s${detail ? `: ${detail}` : ""}`
          : `worker ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`;
      resolve({ ok: false, error });
    });
  });
}

const files = fs
  .readFileSync(listPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

log("batch-start", { total: files.length, timeoutMs, heapMb });
for (let index = 0; index < files.length; index += 1) {
  const file = files[index];
  const startedAt = Date.now();
  log("file-start", { index: index + 1, total: files.length, file });
  const result = await runWorker(file);
  const elapsedMs = Date.now() - startedAt;
  if (result.ok) {
    log("file-indexed", { index: index + 1, total: files.length, elapsedMs, file });
  } else {
    const error = result.error || "索引进程失败";
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
}
log("batch-end", { total: files.length });
try {
  log("wal-checkpoint", { mode: "TRUNCATE", result: checkpointRagIndex() });
} catch (error) {
  log("wal-checkpoint-failed", { mode: "TRUNCATE", error: error instanceof Error ? error.message : String(error) });
}
