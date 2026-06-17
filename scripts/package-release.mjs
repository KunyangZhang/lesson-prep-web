import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(projectRoot, "release");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

const includeRoots = [
  ".env.example",
  ".gitignore",
  "README.md",
  "deploy",
  "dist",
  "index.html",
  "package-lock.json",
  "package.json",
  "scripts",
  "server",
  "skills",
  "src",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts"
];

const excludedPathParts = new Set([
  "node_modules",
  "data",
  "release",
  ".git",
  ".vite",
  "coverage"
]);

const excludedNames = new Set([
  ".env",
  "server-run.log",
  "server-error.log",
  "smoke-server.log",
  "smoke-server-error.log"
]);

function assertExists(relativePath) {
  const target = path.join(projectRoot, relativePath);
  if (!fs.existsSync(target)) throw new Error(`missing required release path: ${relativePath}`);
}

function shouldExclude(relativePath) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => excludedPathParts.has(part))) return true;
  return excludedNames.has(path.basename(relativePath));
}

function walk(relativePath) {
  if (shouldExclude(relativePath)) return [];
  const absolutePath = path.join(projectRoot, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(absolutePath)
      .flatMap((entry) => walk(path.join(relativePath, entry)));
  }
  return [relativePath];
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join("");
}

for (const required of ["dist/server/index.js", "dist/client/index.html", "skills/trial-lesson-prep/SKILL.md", "skills/formal-lesson-prep/SKILL.md"]) {
  assertExists(required);
}

const zip = new JSZip();
const rootFolder = `lesson-prep-web-${packageJson.version}`;
const files = includeRoots.flatMap((entry) => {
  if (!fs.existsSync(path.join(projectRoot, entry))) return [];
  return walk(entry);
});

for (const relativePath of files) {
  const normalized = relativePath.split(path.sep).join("/");
  zip.file(`${rootFolder}/${normalized}`, fs.readFileSync(path.join(projectRoot, relativePath)));
}

const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  createdAt: new Date().toISOString(),
  rootFolder,
  includes: {
    dist: true,
    packagedSkills: ["trial-lesson-prep", "formal-lesson-prep"],
    deployExamples: true,
    source: true,
    nodeModules: false,
    appData: false,
    envSecrets: false
  },
  serverCommands: [
    "bash scripts/server-setup.sh",
    "nano .env",
    "npm start"
  ],
  notes: [
    "Copy deploy/env.production.example to .env on the server and edit paths/secrets before starting.",
    "Run bash scripts/server-setup.sh --smoke on the server if you want an isolated smoke test with fake Codex.",
    "Run npm run codex:smoke on the server after Codex CLI is installed and logged in to verify real Codex generation.",
    "Use systemd for long-running production service instead of leaving npm start in an SSH terminal."
  ]
};
zip.file(`${rootFolder}/release-manifest.json`, JSON.stringify(manifest, null, 2));

fs.mkdirSync(releaseDir, { recursive: true });
const outputPath = path.join(releaseDir, `${rootFolder}-${timestamp()}.zip`);
const buffer = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 }
});
fs.writeFileSync(outputPath, buffer);

const sizeMb = Math.round((buffer.length / 1024 / 1024) * 100) / 100;
console.log(`Release package: ${outputPath}`);
console.log(`Files: ${files.length + 1}`);
console.log(`Size: ${sizeMb} MB`);
