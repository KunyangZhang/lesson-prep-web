import fs from "node:fs";
import path from "node:path";
import { coreOutputFileNames, courseClassroomPdfFileName, ensureCoursePdfFileNames, recoverCourseOutputDir } from "./courseOutput.js";
import {
  createCalendarEventWithLarkCli,
  createDriveFolderWithLarkCli,
  deleteDriveFolderWithLarkCli,
  formatLarkPermissionError,
  getCurrentUserOpenIdWithLarkCli,
  importMarkdownWithLarkCli,
  searchDriveWithLarkCli,
  sendTextWithCurrentUserLarkCli,
  updateCalendarEventWithLarkCli,
  uploadFileWithLarkCli
} from "./larkCli.js";
import type { Course, Job } from "./types.js";
import type { Store } from "./store.js";
import { sanitizeFilename } from "./store.js";

interface SyncResult {
  name: string;
  action: "imported" | "uploaded" | "skipped" | "failed";
  detail: string;
  url?: string;
  token?: string;
}

interface CalendarResult {
  action: "created" | "updated" | "skipped" | "failed";
  detail: string;
  eventId?: string;
  calendarId?: string;
}

interface DeleteResult {
  action: "deleted" | "skipped" | "failed";
  detail: string;
}

interface NotificationResult {
  action: "sent" | "skipped" | "failed";
  detail: string;
  attemptedAt: string;
  sentAt?: string;
}

async function notificationTarget() {
  const receiveId =
    process.env.FEISHU_NOTIFY_OPEN_ID ||
    process.env.FEISHU_CLI_NOTIFY_OPEN_ID ||
    process.env.FEISHU_LESSON_NOTIFY_OPEN_ID ||
    (await getCurrentUserOpenIdWithLarkCli());
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
  return sanitizeFilename(value, "备课", 240);
}

function courseFolderName(store: Store, course: Course) {
  const student = store.findStudent(course.studentId);
  const time = course.lessonTime ? course.lessonTime.replace("T", " ").replace(/:/g, "-") : course.createdAt.slice(0, 16).replace("T", " ");
  const type = course.type === "trial" ? "试听课" : "正式课";
  return sanitizeFolderName(`${student?.name || "未知学生"} - ${time} - ${type} - ${course.desiredContent || "备课"}`);
}

function isPdfImageRefineJob(job: Job) {
  return job.kind === "pdf-image-refine";
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

async function deletePreviousCourseFolder(store: Store, course: Course, job: Job): Promise<DeleteResult> {
  if (isPdfImageRefineJob(job)) return { action: "skipped", detail: "pdf image refine keeps existing course folder" };
  if (!job.refineInstruction) return { action: "skipped", detail: "not a refine job" };
  const folderToken = course.feishuSync?.folderToken || (await findPreviousCourseFolderToken(store, course, job));
  if (!folderToken) return { action: "skipped", detail: "no previous folder token found" };
  try {
    await deleteDriveFolderWithLarkCli(folderToken);
    return { action: "deleted", detail: folderToken };
  } catch (error) {
    return {
      action: "failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function resultTitle(value: Record<string, unknown>) {
  return String(value.title || value.name || "");
}

function resultToken(value: Record<string, unknown>) {
  return String(value.token || value.file_token || value.obj_token || value.node_token || value.url_token || "");
}

async function findPreviousCourseFolderToken(store: Store, course: Course, job: Job) {
  if (!job.refineInstruction) return "";
  const parentToken = lessonParentFolderToken();
  const expectedName = courseFolderName(store, course);
  if (!parentToken || !expectedName) return "";

  try {
    const result = await searchDriveWithLarkCli({
      query: expectedName,
      folderToken: parentToken,
      docTypes: "folder",
      pageSize: 10
    });
    const data = result.data as Record<string, unknown>;
    const results = Array.isArray(data.results) ? data.results : [];
    const matches = results
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => resultTitle(item) === expectedName)
      .map((item) => resultToken(item))
      .filter(Boolean);
    return matches.length === 1 ? matches[0] : "";
  } catch {
    return "";
  }
}

function shouldCreateCourseFolder(job: Job, deleteResult: DeleteResult) {
  if (isPdfImageRefineJob(job)) return false;
  if (!job.refineInstruction) return true;
  return deleteResult.action === "deleted" || deleteResult.action === "skipped" || deleteResult.action === "failed";
}

async function syncOneFile(filePath: string, folderToken: string, fileToken = ""): Promise<SyncResult> {
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
      const result = (await uploadFileWithLarkCli(filePath, folderToken, fileToken)).data as {
        file_token?: string;
        url?: string;
      };
      return {
        name,
        action: "uploaded",
        detail: result.url || result.file_token || (fileToken ? "overwritten" : "uploaded"),
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

function formatNotificationError(error: unknown) {
  return formatLarkPermissionError(error) || (error instanceof Error ? error.message : String(error));
}

async function sendFeishuNotification(text: string): Promise<NotificationResult> {
  const attemptedAt = new Date().toISOString();
  const target = await notificationTarget();
  if (!target) return { action: "skipped", detail: "notification target is empty", attemptedAt };

  try {
    await sendTextWithCurrentUserLarkCli(target, text);
    return {
      action: "sent",
      detail: target.receiveId,
      attemptedAt,
      sentAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      action: "failed",
      detail: formatNotificationError(error),
      attemptedAt
    };
  }
}

function saveNotificationResult(store: Store, course: Course, result: NotificationResult, text: string) {
  course.feishuSync = {
    ...course.feishuSync,
    notificationStatus: result.action,
    notificationDetail: result.detail,
    notificationAttemptedAt: result.attemptedAt,
    notificationSentAt: result.sentAt || course.feishuSync?.notificationSentAt,
    lastNotificationText: text
  };
  store.save();
}

function buildFallbackNotificationText(store: Store, course: Course) {
  const title = formatCourseTitle(store, course);
  return [
    `备课任务已完成：${title}`,
    `本地目录：${course.outputDir}`,
    course.feishuSync?.folderUrl ? `飞书目录：${course.feishuSync.folderUrl}` : "",
    "",
    "飞书同步结果：",
    course.feishuSync?.lastSyncedAt ? `- 最近同步时间: ${course.feishuSync.lastSyncedAt}` : "- 未找到最近同步时间",
    course.feishuSync?.folderUrl ? "- 历史飞书目录已创建，详细文件链接请打开飞书目录查看。" : "- 未找到历史飞书目录记录。"
  ].filter((line) => line !== "").join("\n");
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

async function createLessonCalendarEvent(store: Store, course: Course, job: Job, results: SyncResult[], folderUrl?: string): Promise<CalendarResult> {
  if (!calendarConfigured()) return { action: "skipped", detail: "FEISHU_LESSON_CALENDAR_ENABLED=false" };
  if (isPdfImageRefineJob(job)) return { action: "skipped", detail: "pdf image refine does not update calendar" };
  const start = parseLessonDate(course.lessonTime);
  if (!start) return { action: "skipped", detail: "course lessonTime is empty or invalid" };

  const durationMinutes = Number.isFinite(course.durationMinutes) && course.durationMinutes > 0 ? course.durationMinutes : 90;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const attendeeIds = process.env.FEISHU_LESSON_CALENDAR_ATTENDEE_IDS || "";
  const calendarId = process.env.FEISHU_LESSON_CALENDAR_ID || "";
  const existingEventId = course.feishuSync?.calendarEventId || "";
  const existingCalendarId = course.feishuSync?.calendarId || calendarId;
  try {
    const options = {
      summary: calendarSummary(store, course),
      start: toIsoWithLocalOffset(start),
      end: toIsoWithLocalOffset(end),
      description: calendarDescription(store, course, results, folderUrl),
      attendeeIds,
      calendarId
    };
    if (existingEventId) {
      await updateCalendarEventWithLarkCli({
        ...options,
        eventId: existingEventId,
        calendarId: existingCalendarId
      });
      return { action: "updated", detail: existingEventId, eventId: existingEventId, calendarId: existingCalendarId };
    }

    if (job.refineInstruction) {
      return { action: "skipped", detail: "refine job has no previous calendar event id; not creating duplicate event" };
    }

    const result = await createCalendarEventWithLarkCli(options);
    const data = result.data as Record<string, unknown>;
    const eventId = String(data.event_id || data.eventId || data.id || "created");
    return { action: "created", detail: eventId, eventId, calendarId };
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
  const recovery = recoverCourseOutputDir(course, job);
  if (recovery.changed) store.save();
  if (!fs.existsSync(course.outputDir)) return;
  const student = store.findStudent(course.studentId);
  ensureCoursePdfFileNames(course, student?.name);

  const expectedNames = isPdfImageRefineJob(job)
    ? [courseClassroomPdfFileName(course, student?.name)]
    : coreOutputFileNames(course, student?.name);
  const files = expectedNames
    .map((name) => ({ name, path: path.join(course.outputDir, name) }))
    .filter((file) => fs.existsSync(file.path));
  const missingFiles = expectedNames.filter((name) => !fs.existsSync(path.join(course.outputDir, name)));
  const results: SyncResult[] = [];
  const deleteResult = await deletePreviousCourseFolder(store, course, job);
  let folderUrl = "";
  let folderToken = "";
  if (isPdfImageRefineJob(job)) {
    folderToken = course.feishuSync?.folderToken || (await findPreviousCourseFolderToken(store, course, job));
    folderUrl = course.feishuSync?.folderUrl || (folderToken ? `https://my.feishu.cn/drive/folder/${folderToken}` : "");
    if (!folderToken) {
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
    }
  } else if (shouldCreateCourseFolder(job, deleteResult)) {
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
  } else {
    results.push({
      name: "飞书课程文件夹",
      action: "skipped",
      detail: "refine job could not delete previous folder"
    });
  }
  for (const name of missingFiles) {
    results.push({ name, action: "failed", detail: "local core output file is missing" });
  }
  for (const file of files) {
    if (!folderToken) {
      results.push({ name: file.name, action: "skipped", detail: "course folder creation failed" });
    } else {
      const overwriteToken = isPdfImageRefineJob(job) && path.extname(file.name).toLowerCase() === ".pdf" ? course.feishuSync?.pdfFileToken || "" : "";
      results.push(await syncOneFile(file.path, folderToken, overwriteToken));
    }
  }
  const uploadedPdf = results.find((result) => result.action === "uploaded" && path.extname(result.name).toLowerCase() === ".pdf");
  const calendarResult = await createLessonCalendarEvent(store, course, job, results, folderUrl);
  if (folderToken || folderUrl || calendarResult.eventId || deleteResult.action === "deleted") {
    course.feishuSync = {
      ...course.feishuSync,
      folderToken: folderToken || (deleteResult.action === "deleted" ? undefined : course.feishuSync?.folderToken),
      folderUrl: folderUrl || (deleteResult.action === "deleted" ? undefined : course.feishuSync?.folderUrl),
      calendarEventId: calendarResult.eventId || course.feishuSync?.calendarEventId,
      calendarId: calendarResult.calendarId || course.feishuSync?.calendarId || process.env.FEISHU_LESSON_CALENDAR_ID || "",
      pdfFileToken: uploadedPdf?.token || course.feishuSync?.pdfFileToken,
      pdfFileUrl: uploadedPdf?.url || course.feishuSync?.pdfFileUrl,
      lastJobId: job.id,
      lastSyncedAt: new Date().toISOString()
    };
    store.save();
  }

  const title = formatCourseTitle(store, course);
  const eventTitle = isPdfImageRefineJob(job) ? `PDF 图形修订已完成：${title}` : `备课任务已完成：${title}`;
  const lines = [
    eventTitle,
    `本地目录：${course.outputDir}`,
    folderUrl ? `飞书目录：${folderUrl}` : "",
    "",
    "飞书同步结果：",
    `- 上次文件夹清理: ${deleteResult.action} (${deleteResult.detail})`,
    ...results.map((result) => `- ${syncResultLine(result)}`),
    `- 日程: ${calendarResult.action} (${calendarResult.detail})`
  ];
  console.log(`[feishu-sync] ${title}\n${lines.join("\n")}`);

  const notificationText = lines.join("\n");
  const notificationResult = await sendFeishuNotification(notificationText);
  saveNotificationResult(store, course, notificationResult, notificationText);
  if (notificationResult.action === "failed") {
    console.warn("[feishu-sync] lark-cli user message send failed", notificationResult.detail);
  }
}

export async function resendCourseFeishuNotification(store: Store, course: Course) {
  const text = course.feishuSync?.lastNotificationText || buildFallbackNotificationText(store, course);
  const result = await sendFeishuNotification(text);
  saveNotificationResult(store, course, result, text);
  return result;
}
