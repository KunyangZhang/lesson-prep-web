import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FeishuSettingsService, normalizeFolderToken } from "./feishuSettings.js";
import { larkCliEnvironment } from "./larkCli.js";

test("new accounts do not inherit legacy Feishu destinations or environment settings", () => {
  const service = new FeishuSettingsService("/nonexistent/test-feishu-settings", undefined, {
    PREP_ACCOUNT_ID: "user_new", FEISHU_NOTIFY_OPEN_ID: "ou_legacy", LESSON_FEISHU_PARENT_FOLDER_TOKEN: "legacy-folder", FEISHU_LESSON_CALENDAR_ID: "legacy-calendar"
  });
  assert.deepEqual(service.settings(), { syncEnabled: false, folderToken: "", notifyEnabled: true, notifyOpenId: "", calendarEnabled: false, calendarId: "", attendeeIds: "" });
});

test("Feishu options persist independently for each account and exclude credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-options-"));
  try {
    const one = new FeishuSettingsService(path.join(directory, "one.json"), undefined, { PREP_ACCOUNT_ID: "user_one" });
    const two = new FeishuSettingsService(path.join(directory, "two.json"), undefined, { PREP_ACCOUNT_ID: "user_two" });
    one.save({ syncEnabled: true, folderToken: "https://example.feishu.cn/drive/folder/FolderOne123?from=test", appSecret: "not-saved", device_code: "not-saved" });
    two.save({ calendarEnabled: true, folderToken: "FolderTwo123" });
    assert.equal(one.settings().folderToken, "FolderOne123");
    assert.equal(two.settings().folderToken, "FolderTwo123");
    assert.equal(two.settings().syncEnabled, false);
    assert.equal(one.settings().calendarEnabled, false);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, "one.json"), "utf8"), /appSecret|device_code|not-saved/);
    assert.equal(fs.statSync(path.join(directory, "one.json")).mode & 0o777, 0o600);
    assert.throws(() => one.save({ folderToken: "https://example.com/drive/folder/FolderOne123" }));
    assert.equal(one.settings().folderToken, "FolderOne123");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("folder selection rejects unsafe or malformed URLs", () => {
  assert.equal(normalizeFolderToken(" https://tenant.feishu.cn/drive/folder/Abcdef123/ "), "Abcdef123");
  for (const input of ["http://tenant.feishu.cn/drive/folder/Abcdef123", "https://feishu.cn.evil.example/drive/folder/Abcdef123", "../../secret", "https://tenant.feishu.cn/docx/Abcdef123"]) {
    assert.throws(() => normalizeFolderToken(input));
  }
});

test("app secrets use stdin and never appear in API responses", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const service = new FeishuSettingsService("/nonexistent/test-feishu-settings", async (args, options) => {
    calls.push({ args, stdin: options?.stdin });
    return { data: { appId: "cli_test", identities: { user: { available: false } } } };
  }, { PREP_ACCOUNT_ID: "user_test" });
  const response = await service.configureApp("user_test", { appId: "cli_test", appSecret: "test-secret" });
  assert.ok(calls[0]!.args.includes("--app-secret-stdin"));
  assert.ok(!calls[0]!.args.includes("test-secret"));
  assert.equal(calls[0]!.stdin, "test-secret\n");
  assert.doesNotMatch(JSON.stringify(response), /test-secret/);
});

test("each account has a separate Feishu config, encrypted keychain and log directory", () => {
  const inherited = { PREP_ACCOUNT_ID: "user_one", LARKSUITE_CLI_APP_SECRET: "legacy-secret", LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "legacy-token", LARKSUITE_CLI_CONFIG_DIR: "/legacy/config" };
  const one = larkCliEnvironment("/accounts/one", inherited);
  const two = larkCliEnvironment("/accounts/two", { ...inherited, PREP_ACCOUNT_ID: "user_two" });
  assert.notEqual(one.LARKSUITE_CLI_CONFIG_DIR, two.LARKSUITE_CLI_CONFIG_DIR);
  assert.notEqual(one.LARKSUITE_CLI_DATA_DIR, two.LARKSUITE_CLI_DATA_DIR);
  assert.notEqual(one.LARKSUITE_CLI_LOG_DIR, two.LARKSUITE_CLI_LOG_DIR);
  assert.equal(one.LARKSUITE_CLI_APP_SECRET, undefined);
  assert.equal(one.LARKSUITE_CLI_TENANT_ACCESS_TOKEN, undefined);
  const legacy = larkCliEnvironment("/legacy/data", { ...inherited, PREP_LEGACY_ACCOUNT: "true" });
  assert.equal(legacy.LARKSUITE_CLI_CONFIG_DIR, "/legacy/config");
});

test("device authorization responds immediately, hides the device code, and isolates owners", async () => {
  let finish!: (value: { data: unknown }) => void;
  let starts = 0;
  const service = new FeishuSettingsService("/nonexistent/test-feishu-settings", async (args) => {
    if (args.includes("--no-wait")) { starts++; return { data: { device_code: "private-device-code", verification_url: "https://accounts.feishu.cn/device?user_code=abc", expires_in: 60 } }; }
    if (args.includes("--device-code")) return new Promise((resolve) => { finish = resolve; });
    return { data: { appId: "cli_test", identities: { user: { available: false } } } };
  });
  const response = await service.authorize("user_one");
  assert.equal(response?.state, "pending");
  assert.doesNotMatch(JSON.stringify(response), /private-device-code/);
  assert.equal((await service.status("user_two")).authorization, null);
  await assert.rejects(service.authorize("user_two"), /其他用户/);
  assert.deepEqual(await service.authorize("user_one"), response);
  assert.equal(starts, 1);
  finish({ data: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.status("user_one")).authorization?.state, "authorized");
});
