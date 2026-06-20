import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config as appConfig } from "./config.js";

interface LarkCliRunOptions {
  cwd?: string;
  timeoutMs?: number;
}

interface CalendarCreateOptions {
  summary: string;
  start: string;
  end: string;
  description?: string;
  attendeeIds?: string;
  calendarId?: string;
}

interface CalendarUpdateOptions extends CalendarCreateOptions {
  eventId: string;
}

interface DriveCreateFolderData {
  folder_token?: string;
  token?: string;
  url?: string;
  name?: string;
}

interface DriveSearchOptions {
  query: string;
  folderToken?: string;
  docTypes?: string;
  pageSize?: number;
}

export interface LarkCliResult<T = unknown> {
  data: T;
  stdout: string;
  stderr: string;
}

export interface FeishuMessageTarget {
  receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  receiveId: string;
}

function larkCliBinary() {
  const localBin = path.join(appConfig.projectRoot, "node_modules", ".bin", process.platform === "win32" ? "lark-cli.cmd" : "lark-cli");
  return fs.existsSync(localBin) ? localBin : "lark-cli";
}

function truncate(value: string, maxChars = 1200) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function collectScopes(value: unknown, scopes = new Set<string>()) {
  if (!value || typeof value !== "object") return scopes;
  if (Array.isArray(value)) {
    for (const item of value) collectScopes(item, scopes);
    return scopes;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.subject === "string" && record.subject.includes(":")) scopes.add(record.subject);
  if (Array.isArray(record.permission_violations)) collectScopes(record.permission_violations, scopes);
  if (record.error) collectScopes(record.error, scopes);
  if (record.detail) collectScopes(record.detail, scopes);
  return scopes;
}

export function formatLarkPermissionError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  let parsed: unknown = null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    } catch {
      parsed = null;
    }
  }
  const scopes = Array.from(collectScopes(parsed));
  if (scopes.length === 0 && !/permission|scope|99991672|99991679|10013/i.test(raw)) return "";
  const lines = ["飞书权限不足，当前 lark-cli 登录用户或 CLI 应用缺少权限。"];
  if (scopes.length > 0) {
    lines.push("", "缺失 scope：", ...scopes.map((scope) => `- ${scope}`));
  } else {
    lines.push("", truncate(raw, 800));
  }
  return lines.join("\n");
}

function parseCliJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    throw new Error(`lark-cli returned non-JSON output: ${truncate(trimmed)}`);
  }
}

function unwrapCliData(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    const error = typeof record.error === "object" ? JSON.stringify(record.error) : String(record.error || "unknown error");
    throw new Error(error);
  }
  return record.data || record.result || value;
}

async function runLarkCliWithCurrentAuth<T>(args: string[], options: LarkCliRunOptions = {}): Promise<LarkCliResult<T>> {
  const timeoutMs = options.timeoutMs || 120_000;
  const env = { ...process.env };
  for (const key of [
    "LARKSUITE_CLI_APP_ID",
    "LARKSUITE_CLI_APP_SECRET",
    "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
    "LARKSUITE_CLI_DEFAULT_AS",
    "LARKSUITE_CLI_STRICT_MODE",
    "LARKSUITE_CLI_BRAND"
  ]) {
    delete env[key];
  }
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER || "1";
  return new Promise((resolve, reject) => {
    const child = spawn(larkCliBinary(), args, {
      cwd: options.cwd || appConfig.projectRoot,
      env,
      shell: process.platform === "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`lark-cli timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lark-cli exited ${code}: ${truncate(stderr || stdout)}`));
        return;
      }
      try {
        resolve({
          data: unwrapCliData(parseCliJson(stdout)) as T,
          stdout,
          stderr
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function fileArg(filePath: string) {
  return {
    cwd: path.dirname(filePath),
    relative: `.${path.sep}${path.basename(filePath)}`
  };
}

export async function sendTextWithCurrentUserLarkCli(target: FeishuMessageTarget, text: string) {
  const args = ["im", "+messages-send", "--as", "user"];
  if (target.receiveIdType === "chat_id") args.push("--chat-id", target.receiveId);
  else if (target.receiveIdType === "open_id") args.push("--user-id", target.receiveId);
  else throw new Error(`lark-cli message send does not support receive_id_type=${target.receiveIdType}`);
  args.push("--text", text, "--format", "json");
  return runLarkCliWithCurrentAuth(args, { timeoutMs: 60_000 });
}

export async function importMarkdownWithLarkCli(markdownPath: string, folderToken = "") {
  const file = fileArg(markdownPath);
  const name = path.basename(markdownPath, path.extname(markdownPath));
  const args = ["drive", "+import", "--as", "user", "--file", file.relative, "--type", "docx", "--name", name];
  if (folderToken) args.push("--folder-token", folderToken);
  args.push("--format", "json");
  return runLarkCliWithCurrentAuth(args, { cwd: file.cwd, timeoutMs: 180_000 });
}

export async function uploadFileWithLarkCli(filePath: string, folderToken = "") {
  const file = fileArg(filePath);
  const args = ["drive", "+upload", "--as", "user", "--file", file.relative, "--name", path.basename(filePath)];
  if (folderToken) args.push("--folder-token", folderToken);
  args.push("--format", "json");
  return runLarkCliWithCurrentAuth(args, { cwd: file.cwd, timeoutMs: 180_000 });
}

export async function createDriveFolderWithLarkCli(name: string, parentFolderToken = "") {
  const args = ["drive", "+create-folder", "--as", "user", "--name", name];
  if (parentFolderToken) args.push("--folder-token", parentFolderToken);
  args.push("--format", "json");
  return runLarkCliWithCurrentAuth<DriveCreateFolderData>(args, { timeoutMs: 60_000 });
}

export async function deleteDriveFolderWithLarkCli(folderToken: string) {
  const args = ["drive", "+delete", "--as", "user", "--file-token", folderToken, "--type", "folder", "--yes", "--format", "json"];
  return runLarkCliWithCurrentAuth(args, { timeoutMs: 180_000 });
}

export async function searchDriveWithLarkCli(options: DriveSearchOptions) {
  const args = ["drive", "+search", "--as", "user", "--query", options.query, "--only-title"];
  if (options.folderToken) args.push("--folder-tokens", options.folderToken);
  if (options.docTypes) args.push("--doc-types", options.docTypes);
  if (options.pageSize) args.push("--page-size", String(options.pageSize));
  args.push("--format", "json");
  return runLarkCliWithCurrentAuth(args, { timeoutMs: 60_000 });
}

export async function createCalendarEventWithLarkCli(options: CalendarCreateOptions) {
  const args = [
    "calendar",
    "+create",
    "--as",
    "user",
    "--summary",
    options.summary,
    "--start",
    options.start,
    "--end",
    options.end
  ];
  if (options.description) args.push("--description", options.description);
  if (options.attendeeIds) args.push("--attendee-ids", options.attendeeIds);
  if (options.calendarId) args.push("--calendar-id", options.calendarId);
  args.push("--format", "json");
  return runLarkCliWithCurrentAuth(args, { timeoutMs: 60_000 });
}

export async function updateCalendarEventWithLarkCli(options: CalendarUpdateOptions) {
  const args = [
    "calendar",
    "+update",
    "--as",
    "user",
    "--event-id",
    options.eventId,
    "--summary",
    options.summary,
    "--start",
    options.start,
    "--end",
    options.end
  ];
  if (options.description) args.push("--description", options.description);
  if (options.calendarId) args.push("--calendar-id", options.calendarId);
  args.push("--format", "json");
  return runLarkCliWithCurrentAuth(args, { timeoutMs: 60_000 });
}
