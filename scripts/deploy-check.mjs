import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
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

loadDotEnv();

const env = process.env;

const checks = [];

function add(level, name, message, detail = "") {
  checks.push({ level, name, message, detail });
}

function ok(name, message, detail) {
  add("ok", name, message, detail);
}

function warn(name, message, detail) {
  add("warn", name, message, detail);
}

function fail(name, message, detail) {
  add("fail", name, message, detail);
}

function exists(relativePath) {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

function resolveFromProject(value, fallback) {
  const target = value || fallback;
  return path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
}

function commandWorks(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 15000
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  };
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok("node", `Node ${process.versions.node}`);
  else fail("node", `Node ${process.versions.node}`, "Use Node 20+ on the server.");
}

function checkPackage() {
  const pkg = readJson("package.json");
  for (const scriptName of ["build", "start", "check", "deploy:check"]) {
    if (pkg.scripts?.[scriptName]) ok(`script:${scriptName}`, `npm script exists: ${scriptName}`);
    else fail(`script:${scriptName}`, `missing npm script: ${scriptName}`);
  }
  if (exists("package-lock.json")) ok("lockfile", "package-lock.json exists");
  else warn("lockfile", "package-lock.json missing", "Run npm install before deploying.");
}

function checkBuildOutput() {
  if (exists("dist/server/index.js")) ok("dist:server", "server build exists");
  else warn("dist:server", "server build missing", "Run npm run build before production start.");

  if (exists("dist/client/index.html")) ok("dist:client", "client build exists");
  else warn("dist:client", "client build missing", "Run npm run build before production start.");
}

function checkSkills() {
  const skills = ["trial-lesson-prep", "formal-lesson-prep"];
  for (const skill of skills) {
    const base = path.join("skills", skill);
    if (!exists(path.join(base, "SKILL.md"))) {
      fail(`skill:${skill}`, `${skill} SKILL.md missing`);
      continue;
    }
    ok(`skill:${skill}`, `${skill} is packaged`);

    for (const required of [
      "scripts/find_materials.py",
      "scripts/find_materials.ps1",
      "references/math-lesson-core.md",
      "assets/tablet-beamer-template.tex"
    ]) {
      if (exists(path.join(base, required))) ok(`skill:${skill}:${required}`, "required skill file exists");
      else fail(`skill:${skill}:${required}`, "required skill file missing");
    }
  }
}

function checkPaths() {
  const workspace = resolveFromProject(env.PREP_WORKSPACE, "..");
  const materialRoot = resolveFromProject(env.PREP_MATERIAL_ROOT, path.join(workspace, "\u8d44\u6599\u5e93"));
  const dataDir = resolveFromProject(env.APP_DATA_DIR, "data");

  if (fs.existsSync(workspace) && fs.statSync(workspace).isDirectory()) {
    ok("path:workspace", `workspace exists: ${workspace}`);
  } else {
    fail("path:workspace", `workspace missing: ${workspace}`, "Set PREP_WORKSPACE to the lesson-prep root.");
  }

  const materialParent = path.dirname(materialRoot);
  if (fs.existsSync(materialRoot) || fs.existsSync(materialParent)) {
    ok("path:materials", `material root is usable: ${materialRoot}`);
  } else {
    warn("path:materials", `material root parent missing: ${materialParent}`);
  }

  const dataParent = path.dirname(dataDir);
  if (fs.existsSync(dataDir) || fs.existsSync(dataParent)) {
    ok("path:data", `data dir is usable: ${dataDir}`);
  } else {
    warn("path:data", `data dir parent missing: ${dataParent}`);
  }
}

function checkCodex() {
  const runner = env.CODEX_RUNNER || "local";
  const autoRun = parseBool(env.CODEX_AUTO_RUN, true);
  if (!autoRun) {
    warn("codex:auto-run", "CODEX_AUTO_RUN is disabled", "Courses will not generate automatically.");
  }

  if (runner === "ssh") {
    const required = ["CODEX_SSH_HOST", "CODEX_REMOTE_WORKSPACE"];
    for (const name of required) {
      if (env[name]) ok(`codex:ssh:${name}`, `${name} is set`);
      else fail(`codex:ssh:${name}`, `${name} is required for CODEX_RUNNER=ssh`);
    }
    if (env.CODEX_REMOTE_PROJECT_ROOT) ok("codex:ssh:project", "CODEX_REMOTE_PROJECT_ROOT is set");
    else warn("codex:ssh:project", "CODEX_REMOTE_PROJECT_ROOT is empty", "Set it if the project is not inside CODEX_REMOTE_WORKSPACE.");
    return;
  }

  if (runner !== "local") {
    fail("codex:runner", `unsupported CODEX_RUNNER: ${runner}`, "Use local or ssh.");
    return;
  }

  const command = env.CODEX_COMMAND || "codex";
  const result = commandWorks(command);
  if (result.ok) ok("codex:command", `Codex command works: ${command}`, result.output.split(/\r?\n/)[0]);
  else fail("codex:command", `Codex command failed: ${command}`, result.output || "Install/login Codex CLI on the server.");
}

function checkSecurity() {
  const isProduction = (env.NODE_ENV || "").toLowerCase() === "production";
  const secureCookies = parseBool(env.SECURE_COOKIES, isProduction);
  const enableHsts = parseBool(env.ENABLE_HSTS, false);
  const trustProxy = parseBool(env.TRUST_PROXY, false);
  const maxAttempts = Number(env.AUTH_RATE_LIMIT_MAX || 8);
  const windowMs = Number(env.AUTH_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);

  if (isProduction && secureCookies) ok("security:cookies", "Secure cookies enabled");
  else if (isProduction) warn("security:cookies", "Secure cookies are disabled", "Set SECURE_COOKIES=true after HTTPS is configured.");
  else ok("security:cookies", "Secure cookies not forced in local mode");

  if (enableHsts) ok("security:hsts", "HSTS enabled");
  else if (isProduction) warn("security:hsts", "HSTS disabled", "Enable only after HTTPS is confirmed for the public domain.");
  else ok("security:hsts", "HSTS not forced in local mode");

  if (trustProxy) ok("security:proxy", "TRUST_PROXY enabled");
  else if (isProduction) warn("security:proxy", "TRUST_PROXY disabled", "Enable behind Nginx if you want login rate limiting to use the real client IP.");
  else ok("security:proxy", "TRUST_PROXY not forced in local mode");

  if (Number.isFinite(maxAttempts) && maxAttempts > 0 && Number.isFinite(windowMs) && windowMs > 0) {
    ok("security:rate-limit", `auth rate limit ${maxAttempts} attempts / ${Math.round(windowMs / 1000)}s`);
  } else {
    fail("security:rate-limit", "invalid auth rate limit configuration");
  }
}

function printResults() {
  const icon = { ok: "OK", warn: "WARN", fail: "FAIL" };
  for (const check of checks) {
    console.log(`[${icon[check.level]}] ${check.name}: ${check.message}`);
    if (check.detail) console.log(`       ${check.detail}`);
  }
  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  console.log("");
  console.log(`Deploy check: ${failures} failure(s), ${warnings} warning(s).`);
  if (failures > 0) process.exitCode = 1;
}

checkNode();
checkPackage();
checkBuildOutput();
checkSkills();
checkPaths();
checkCodex();
checkSecurity();
printResults();
