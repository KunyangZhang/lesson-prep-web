import fs from "node:fs";
import path from "node:path";
import { listCourseFiles } from "./files.js";
import {
  createCalendarEventWithLarkCli,
  createDriveFolderWithLarkCli,
  formatLarkPermissionError,
  importMarkdownWithLarkCli,
  sendTextWithCurrentUserLarkCli,
  uploadFileWithLarkCli
} from "./larkCli.js";
import type { Course, Job } from "./types.js";
import type { Store } from "./store.js";

interface SyncResult {
  name: string;
  action: "imported" | "uploaded" | "skipped" | "failed";
  detail: string;
  url?: string;
  token?: string;
}

interface CalendarResult {
  action: "created" | "skipped" | "failed";
  detail: string;
}

function notifyTargetFromEnv() {
  const receiveId =
    process.env.FEISHU_NOTIFY_OPEN_ID ||
    process.env.FEISHU_CLI_NOTIFY_OPEN_ID ||
    process.env.FEISHU_LESSON_NOTIFY_OPEN_ID ||
    "ou_034209f962a2451251af0282fe555c20";
  if (!receiveId) return null;
  return {
    receiveIdType: "open_id" as const,
    receiveId
  };
}

function formatCourseTitle(store: Store, course: Course) {
  const student = store.findStudent(course.studentId);
  return `${student?.name || "未知学生"} / ${course.type === "trial" ? "试听课" : "正式课"} / ${course.desiredContent || "备课"}`;
}

function lessonParentFolderToken() {
  return (
    process.env.LESSON_FEISHU_PARENT_FOLDER_TOKEN ||
    process.env.FEISHU_LESSON_PARENT_FOLDER_TOKEN ||
    "LY9efBiWjlEAQWdqPrucuLl4nic"
  );
}

function sanitizeFolderName(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function courseFolderName(store: Store, course: Course) {
  const student = store.findStudent(course.studentId);
  const time = course.lessonTime ? course.lessonTime.replace("T", " ").replace(/:/g, "-") : course.createdAt.slice(0, 16).replace("T", " ");
  const type = course.type === "trial" ? "试听课" : "正式课";
  return sanitizeFolderName(`${student?.name || "未知学生"} - ${time} - ${type} - ${course.desiredContent || "备课"}`);
}

async function createCourseFolder(store: Store, course: Course) {
  const parentToken = lessonParentFolderToken();
  const result = await createDriveFolderWithLarkCli(courseFolderName(store, course), parentToken);
  const data = result.data as Record<string, unknown>;
  const folderToken = String(data.folder_token || data.token || "");
  if (!folderToken) throw new Error(`lark-cli did not return folder_token: ${result.stdout}`);
  return {
    token: folderToken,
    url: typeof data.url === "string" ? data.url : `https://my.feishu.cn/drive/folder/${folderToken}`
  };
}

async function syncOneFile(filePath: string, folderToken: string): Promise<SyncResult> {
  const name = path.basename(filePath);
  try {
    if ([".md", ".markdown"].includes(path.extname(name).toLowerCase())) {
      const result = (await importMarkdownWithLarkCli(filePath, folderToken)).data as {
        ticket?: string;
        job_ticket?: string;
        token?: string;
        url?: string;
      };
      return {
        name,
        action: "imported",
        detail: result.url || result.token || result.ticket || result.job_ticket || "import task created",
        token: result.token,
        url: result.url
      };
    }
    if (path.extname(name).toLowerCase() === ".pdf") {
      const result = (await uploadFileWithLarkCli(filePath, folderToken)).data as {
        file_token?: string;
        url?: string;
      };
      return {
        name,
        action: "uploaded",
        detail: result.url || result.file_token || "uploaded",
        token: result.file_token,
        url: result.url
      };
    }
    return { name, action: "skipped", detail: "unsupported file type" };
  } catch (error) {
    return {
      name,
      action: "failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseLessonDate(value: string) {
  if (!value.trim()) return null;
  const normalized = value.trim().includes("T") ? value.trim() : value.trim().replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toIsoWithLocalOffset(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
    sign,
    pad(Math.floor(absOffset / 60)),
    ":",
    pad(absOffset % 60)
  ].join("");
}

function syncResultLine(result: SyncResult) {
  return `${result.name}: ${result.action} (${result.url || result.detail})`;
}

function calendarSummary(store: Store, course: Course) {
  const student = store.findStudent(course.studentId);
  return `${student?.name || "未知学生"}${course.type === "trial" ? "试听课" : "正式课"}`;
}

function calendarDescription(store: Store, course: Course, results: SyncResult[], folderUrl?: string) {
  const student = store.findStudent(course.studentId);
  return [
    `备课产物：${student?.name || "未知学生"} / ${course.type === "trial" ? "试听课" : "正式课"}`,
    `课程内容：${course.desiredContent || "[待确认]"}`,
    `本地目录：${course.outputDir}`,
    folderUrl ? `飞书目录：${folderUrl}` : "",
    "",
    "飞书云文档/文件：",
    ...results.map((result) => `- ${syncResultLine(result)}`)
  ].filter((line) => line !== "").join("\n");
}

function calendarConfigured() {
  return process.env.FEISHU_LESSON_CALENDAR_ENABLED !== "false";
}

async function createLessonCalendarEvent(store: Store, course: Course, results: SyncResult[], folderUrl?: string): Promise<CalendarResult> {
  if (!calendarConfigured()) return { action: "skipped", detail: "FEISHU_LESSON_CALENDAR_ENABLED=false" };
  const start = parseLessonDate(course.lessonTime);
  if (!start) return { action: "skipped", detail: "course lessonTime is empty or invalid" };

  const durationMinutes = Number.isFinite(course.durationMinutes) && course.durationMinutes > 0 ? course.durationMinutes : 90;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const attendeeIds = process.env.FEISHU_LESSON_CALENDAR_ATTENDEE_IDS || "";
  const calendarId = process.env.FEISHU_LESSON_CALENDAR_ID || "";
  try {
    const result = await createCalendarEventWithLarkCli({
      summary: calendarSummary(store, course),
      start: toIsoWithLocalOffset(start),
      end: toIsoWithLocalOffset(end),
      description: calendarDescription(store, course, results, folderUrl),
      attendeeIds,
      calendarId
    });
    const data = result.data as Record<string, unknown>;
    const eventId = String(data.event_id || data.eventId || data.id || "created");
    return { action: "created", detail: eventId };
  } catch (error) {
    const permissionHint = formatLarkPermissionError(error);
    return {
      action: "failed",
      detail: permissionHint || (error instanceof Error ? error.message : String(error))
    };
  }
}

export async function syncCourseToFeishu(store: Store, course: Course, job: Job) {
  if (process.env.FEISHU_SYNC_ENABLED === "false") return;
  if (job.status !== "completed") return;
  if (!fs.existsSync(course.outputDir)) return;
  const target = notifyTargetFromEnv();

  const wanted = new Set(["老师逐字稿.md", "知识点详解.md", "课后反馈.md", "课堂课件.pdf"]);
  const files = listCourseFiles(course.outputDir).filter((file) => wanted.has(file.name));
  const results: SyncResult[] = [];
  let folderUrl = "";
  let folderToken = "";
  try {
    const folder = await createCourseFolder(store, course);
    folderToken = folder.token;
    folderUrl = folder.url;
  } catch (error) {
    results.push({
      name: "飞书课程文件夹",
      action: "failed",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
  for (const file of files) {
    if (!folderToken) {
      results.push({ name: file.name, action: "skipped", detail: "course folder creation failed" });
    } else {
      results.push(await syncOneFile(file.path, folderToken));
    }
  }
  const calendarResult = await createLessonCalendarEvent(store, course, results, folderUrl);

  const title = formatCourseTitle(store, course);
  const lines = [
    `备课任务已完成：${title}`,
    `本地目录：${course.outputDir}`,
    folderUrl ? `飞书目录：${folderUrl}` : "",
    "",
    "飞书同步结果：",
    ...results.map((result) => `- ${syncResultLine(result)}`),
    `- 日程: ${calendarResult.action} (${calendarResult.detail})`
  ];
  console.log(`[feishu-sync] ${title}\n${lines.join("\n")}`);

  if (target) {
    try {
      await sendTextWithCurrentUserLarkCli(target, lines.join("\n"));
    } catch (error) {
      console.warn("[feishu-sync] lark-cli user message send failed", error instanceof Error ? error.message : error);
    }
  }
}
