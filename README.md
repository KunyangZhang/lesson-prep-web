# 备课工作台

一个本地优先的备课 Web 应用，面向单人/小团队部署。

## 功能

- 首次初始化管理员账号，之后登录使用。
- 创建学生，按学生创建试听课或正式课。
- 课程创建后可自动调用 `codex exec`，使用项目内置 `trial-lesson-prep` 或 `formal-lesson-prep` skill 生成备课产物。
- 读取课程目录里的 `md` 和 `pdf` 文件，直接在网页里预览。
- 上传资料到资料库，抽取文本并建立本地 RAG 索引。
- 支持单文件上传和文件夹上传，文件夹结构会保留。
- 资料库按文件夹浏览，上传数量上限可配置。
- 创建课程时会把 RAG 命中的资料片段写进 Codex prompt，减少重复搜索。
- 课程生成后可以新页面预览 `md` / `pdf`，也可以基于上一次记录继续提交 Codex 补充内容。
- 账号设置里可以下载应用数据备份，保存学生、课程、任务、资料索引等数据库快照。
- 账号设置里可以运行系统诊断，检查 Codex、项目内置 skill、工作区、资料库和最近失败任务。

## 开发运行

```powershell
cd C:\Users\kunya\Documents\备课\lesson-prep-web
npm install
npm run dev
```

打开 `http://localhost:4178`。

## 部署

```powershell
npm run build
npm start
```

部署前可以先做一次自检：

```powershell
npm run deploy:check
```

它会检查 Node 版本、构建产物、两个项目内置 skill、工作区/资料库路径、Codex CLI 或 SSH 运行配置。出现 `FAIL` 时先按提示修好再启动生产服务；`WARN` 通常是不阻断启动但建议确认的项。

改动后还可以跑一次隔离冒烟测试：

```powershell
npm run build
npm run smoke
```

`smoke` 会用临时工作区和临时数据目录启动一套服务，验证初始化账号、登录、学生/课程增删改、资料上传、RAG 检索、课程附件、Markdown/PDF 预览入口、质量检查、备份和诊断接口。它还会用一个临时的 fake Codex 命令验证“创建课程后后台自动启动 Codex 任务、接收 prompt、生成四个核心文件、完成质量检查”的链路，不会写入真实备课数据。

项目已经内置两个备课 skill：

- `skills/trial-lesson-prep`
- `skills/formal-lesson-prep`

部署到服务器时请把整个 `lesson-prep-web` 项目目录一起上传，不需要再手动把这两个 skill 安装到服务器的 `~/.codex/skills`。

Linux 服务器部署可以参考：

- `deploy/env.production.example`: 生产环境变量示例。
- `deploy/systemd/lesson-prep-web.service.example`: systemd 常驻服务示例。
- `deploy/nginx/lesson-prep-web.conf.example`: Nginx 反向代理示例。

推荐 Linux 部署流程：

```bash
cd /home/kunya/lesson-prep-web
cp deploy/env.production.example .env
npm ci
npm run build
npm run deploy:check
npm start
```

确认能打开后，再把 `deploy/systemd/lesson-prep-web.service.example` 按服务器用户名和目录改好，复制到 `/etc/systemd/system/lesson-prep-web.service`，用 systemd 常驻运行。

如果从本机打包上传服务器，可以先生成发布包：

```powershell
npm run build
npm run package:release
```

生成的 zip 在 `release/` 目录里。发布包包含构建产物、源码、部署示例和两个项目内置 skill，但不会包含 `node_modules`、`.env`、应用数据库、日志或真实备课资料。上传到服务器后：

```bash
unzip lesson-prep-web-*.zip
cd lesson-prep-web-0.1.0
cp deploy/env.production.example .env
nano .env
bash scripts/server-setup.sh
npm start
```

如果你希望在服务器上也运行 `npm run smoke`，请用 `npm ci` 安装开发依赖；`smoke` 会使用临时 fake Codex，不会消耗真实 Codex 任务。

也可以让向导脚本顺手运行 smoke：

```bash
bash scripts/server-setup.sh --smoke
```

服务器上确认 Codex CLI 已安装并登录后，可以跑一次真实 Codex 烟测：

```bash
npm run codex:smoke
```

这个命令会用临时工作区启动一套隔离服务，真实调用服务器上的 `codex exec`，验证后台任务是否能生成四个核心文件。它会消耗一次真实 Codex 调用，所以不要放进常规自动化里。

生产长期运行仍建议使用 `deploy/systemd/lesson-prep-web.service.example`，不要长期依赖 SSH 终端里的 `npm start`。

健康检查地址：

```text
GET /api/health
```

建议在服务器上设置环境变量：

- `PREP_WORKSPACE`: 备课工作区根目录。
- `PREP_MATERIAL_ROOT`: 资料库根目录，默认可设为 `${PREP_WORKSPACE}/资料库`。
- `APP_DATA_DIR`: 应用数据库、日志和索引目录。
- `CODEX_COMMAND`: Codex CLI 命令，默认 `codex`。
- `CODEX_AUTO_RUN`: 是否允许课程创建后自动调用 Codex，默认 `true`。
- `CODEX_RUNNER`: `local` 或 `ssh`。网页部署在 Linux 服务器上时用 `local` 即可。
- `CODEX_SSH_HOST` / `CODEX_SSH_USER` / `CODEX_SSH_PORT` / `CODEX_SSH_KEY`: `CODEX_RUNNER=ssh` 时用于远程调用 Linux 服务器上的 Codex。
- `CODEX_REMOTE_WORKSPACE`: Linux 服务器上的备课工作区路径。SSH 模式下，prompt 里的工作区和输出目录会映射到这个路径。
- `CODEX_REMOTE_PROJECT_ROOT`: Linux 服务器上的 `lesson-prep-web` 项目路径。SSH 模式下如果项目目录不在 `CODEX_REMOTE_WORKSPACE` 里面，需要设置它，Codex 才能读到项目内置 skill。
- `MAX_UPLOAD_FILES`: 单次上传最多文件数，默认 `5000`。上传大文件夹提示文件太多时调大这个值。
- `RAG_MAX_REINDEX_FILES`: 重建索引时最多扫描文件数，默认 `300`。
- `SECURE_COOKIES`: HTTPS 部署后建议设为 `true`；如果只是用 HTTP 初测，先保持 `false`。
- `ENABLE_HSTS`: 确认 HTTPS 正常后再设为 `true`。
- `TRUST_PROXY`: 通过 Nginx 反向代理部署时建议设为 `true`，登录限流会使用真实客户端 IP。
- `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS`: 登录和初始化接口限流，默认 10 分钟 8 次。

如果公网部署，请务必使用 HTTPS、强密码，并只开放给自己或可信网络。应用会给登录和初始化接口做基础限流，并在生产环境发送 CSP、X-Frame-Options、X-Content-Type-Options 等安全响应头。

## 备份

网页右下角/侧边栏的“账号设置”里有“下载数据备份”和“系统诊断”。

备份文件是 zip，包含：

- `app-db.json`: 应用数据库快照，包括学生、课程、任务、资料索引和账号密码哈希。
- `manifest.json`: 备份时间、工作区路径和数据数量统计。

生成的 `md` / `pdf` 课件、上传到资料库的原始文件仍保存在 `PREP_WORKSPACE` 里。服务器上线后建议同时备份整个 `PREP_WORKSPACE` 目录和 `APP_DATA_DIR`。

系统诊断会检查 Codex CLI 或 SSH 运行配置、两个项目内置 skill、工作区路径、资料库路径、应用数据目录、资料索引数量和最近失败任务。

## 飞书集成

项目不再提供飞书机器人入口。备课任务仍然从网页创建和运行；任务完成后，服务端使用当前机器已经登录的官方 `lark-cli` 用户身份自动收尾：

- 在固定父目录下按学生/课程创建子文件夹。
- 将 `老师逐字稿.md`、`知识点详解.md`、`课后反馈.md` 导入为飞书新版文档。
- 将 `课堂课件.pdf` 上传为云空间文件。
- 如果课程时间有效，创建飞书日程，并把本地目录、飞书目录和四个文件结果写进日程描述。
- 通过 `lark-cli im +messages-send --as user` 把同步结果发给 `FEISHU_NOTIFY_OPEN_ID`。

服务器运行前先在同一用户下完成一次登录：

```bash
lark-cli auth login --recommend
```

服务器 `.env` 只需要保留同步配置：

```bash
FEISHU_LESSON_PARENT_FOLDER_TOKEN=LY9efBiWjlEAQWdqPrucuLl4nic
FEISHU_NOTIFY_OPEN_ID=
FEISHU_SYNC_ENABLED=true
FEISHU_LESSON_CALENDAR_ENABLED=true
FEISHU_LESSON_CALENDAR_ID=
FEISHU_LESSON_CALENDAR_ATTENDEE_IDS=
```

备课产物默认会在 `FEISHU_LESSON_PARENT_FOLDER_TOKEN` 指定的父目录下按学生/课程创建子文件夹，然后把三个 Markdown 导入为飞书新版文档、把 PDF 上传为云空间文件。默认父目录是：

```text
https://my.feishu.cn/drive/folder/LY9efBiWjlEAQWdqPrucuLl4nic
```

所有飞书操作都使用当前 `lark-cli` 登录用户执行，不再注入 App ID / App Secret，不再使用 bot strict mode。可用 `FEISHU_SYNC_ENABLED=false` 关闭完成后同步；可用 `FEISHU_LESSON_CALENDAR_ENABLED=false` 只关闭日程创建。
