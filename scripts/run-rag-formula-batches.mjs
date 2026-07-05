import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = "/root/lesson-prep-web";
const startIndex = Number(process.argv[2] || 0);
const logPath = path.join(projectRoot, "data/logs/rag-formula-queue.log");
const pollMs = Number(process.env.RAG_FORMULA_QUEUE_POLL_MS || 30_000);

function log(message, details = {}) {
  const line = `[rag-formula-queue] ${new Date().toISOString()} ${message} ${JSON.stringify(details)}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
  console.log(line);
}

function hasRunningRerun() {
  try {
    const proc = fs.readdirSync("/proc");
    return proc.some((pid) => {
      if (!/^\d+$/.test(pid)) return false;
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (!fs.existsSync(cmdlinePath)) return false;
      const cmdline = fs.readFileSync(cmdlinePath, "utf8").replace(/\0/g, " ");
      return cmdline.includes("scripts/rerun-rag-files.mjs");
    });
  } catch {
    return false;
  }
}

function waitForNoRunningRerun() {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (hasRunningRerun()) return;
      clearInterval(timer);
      resolve();
    }, pollMs);
  });
}

function runBatch(batchPath) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "scripts/rerun-rag-files.mjs", batchPath],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          RAG_RERUN_TIMEOUT_MS: process.env.RAG_RERUN_TIMEOUT_MS || "900000",
          RAG_RERUN_HEAP_MB: process.env.RAG_RERUN_HEAP_MB || "512",
          RAG_MATHTYPE_BATCH_SIZE: process.env.RAG_MATHTYPE_BATCH_SIZE || "40"
        }
      }
    );
    child.stdout.on("data", (chunk) => fs.appendFileSync(logPath, chunk));
    child.stderr.on("data", (chunk) => fs.appendFileSync(logPath, chunk));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

const batches = fs
  .readdirSync(path.join(projectRoot, "data"))
  .filter((name) => /^rag-formula-retry-batch-\d+$/.test(name))
  .sort()
  .map((name) => path.join("data", name))
  .slice(startIndex);

log("queue-start", { startIndex, batches });
await waitForNoRunningRerun();
for (const batch of batches) {
  log("batch-start", { batch });
  const result = await runBatch(batch);
  log("batch-end", { batch, ...result });
}
log("queue-end", { batches: batches.length });
