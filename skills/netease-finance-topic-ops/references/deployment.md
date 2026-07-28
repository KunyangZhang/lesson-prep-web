# 跨电脑部署

## 支持范围

便携包面向已安装Codex Desktop的Windows、macOS或Linux电脑。它包含父 Skill 和6个资讯子 Skill 的必要源码、脚本、锁定文件、部署清单和依赖清单，不包含真实API Key、Cookie、账号、`node_modules`、Python虚拟环境、Codex产品运行时或腾讯新闻CLI二进制文件。完整组件清单见 `assets/portable-manifest.json`。

内置子 Skill：

1. `mx-finance-search`
2. `tencent-news`
3. `wechat-article-search`
4. `news-aggregator-skill`
5. `toutiao-news-trends`
6. `a-stock-analysis`

上述6个子 Skill 均位于 `assets/bundled-skills/`，安装脚本会把它们与父 Skill 一起复制到目标电脑的Codex skills目录。`skill-creator`只用于开发和校验本 Skill，不是运行依赖；Word由包内生成器完成，不要求另装文档 Skill；Excel使用Codex Desktop提供的工作区依赖加载器和 `@oai/artifact-tool`，这两项属于产品运行时，不能随ZIP复制。

## 目标电脑前提

- Codex Desktop已安装并登录。
- Python 3.10或更高版本。
- Node.js 20.18.1或更高版本及npm。
- 可访问东方财富、腾讯新闻、搜狗微信、36氪、华尔街见闻、今日头条和新浪财经等站点。
- 有权使用相应站点和接口，并遵守其使用条款及抓取频率限制。

## 安装

### Windows

在解压后的 `netease-finance-topic-ops` 目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-portable.ps1
```

脚本会把父 Skill 和6个子 Skill复制到 `${CODEX_HOME}\skills`；未设置 `CODEX_HOME` 时使用 `%USERPROFILE%\.codex\skills`。它会安装父 Skill 的Python依赖，并在微信公众号子 Skill 内执行锁定的 `npm ci`。重复运行时默认把新版文件合并到既有目录并补装缺失组件；使用 `-Force` 才整目录替换。使用 `-SkipDependencies` 可只复制代码。

在 Codex Desktop 中安装时，把工作区依赖加载器返回的 Python 传给 `-PythonExecutable`，避免把依赖装到另一套系统 Python：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-portable.ps1 -PythonExecutable "C:\path\to\codex-python.exe"
```

安装脚本会在当前进程设置 `PYTHONUTF8=1`，避免Windows中文控制台编码错误；如需长期使用系统Python，可在用户环境中持久设置该变量。

### macOS/Linux

```sh
sh scripts/install-portable.sh
```

可设置 `CODEX_HOME` 改变目标目录；设置 `SKIP_DEPENDENCIES=1` 可只复制代码。

## 腾讯新闻CLI

腾讯新闻 Skill 的源码已内置，但官方CLI需在目标电脑单独安装：

- Windows：`irm https://mat1.gtimg.com/qqcdn/qqnews/cli/hub/tencent-news/setup.ps1 | iex`
- macOS/Linux：`curl -fsSL https://mat1.gtimg.com/qqcdn/qqnews/cli/hub/tencent-news/setup.sh | sh`

这是外部官方安装脚本；执行前可先下载并审阅。安装后运行 `tencent-news-cli help`。

## 配置密钥

按 `references/api-keys.md` 配置 `EM_API_KEY` 和腾讯新闻API Key。要在新电脑保持与原电脑相同的优先级搜索覆盖，这两项都必须配置。其他4个内置资讯子 Skill 不需要API Key。配置完成后重新打开终端和Codex，使环境变量生效。

## 预检

每次运行选题流程都必须先加载 Codex 工作区依赖，然后用加载器返回的 Python 执行自动保障：

```powershell
& "C:\path\to\codex-python.exe" scripts/ensure_ready.py --artifact-node-modules "C:\path\to\node_modules" --node-executable "C:\path\to\node.exe"
```

保障脚本会幂等执行以下动作：

- 按内置副本的文件哈希补齐或修复缺失、残缺、版本不一致的6个资讯子 Skill。
- 用当前正在执行脚本的 Python 安装缺失依赖，避免系统 Python 与 Codex Python 错位。
- 按 `package-lock.json` 补齐微信公众号搜索的 Node 依赖。
- 验证 Python、Node.js、npm、全部子 Skill、两项凭证、腾讯新闻CLI和 `@oai/artifact-tool`。

只有输出 `ready: true` 才可继续当天搜索。凭证、官方腾讯新闻CLI和 Codex 产品运行时不能由便携包安全代填或替代；若这些组件缺失，保障脚本会返回非零状态并停止流程。预检只报告密钥是否存在，不输出密钥值。

## 数据迁移

要保留历史查重能力，另行复制现用的 `topic-ledger.sqlite` 到目标电脑的日常工作目录。不要把数据库放进 Skill 目录，否则升级或重新部署可能混淆程序与业务数据。Excel和Word历史文件可按编辑部归档规则迁移。

## 版本与限制

- 公开网页和非正式接口可能改版；预检通过不代表所有站点实时可达。
- `@oai/artifact-tool` 是Codex产品运行时，不随ZIP分发；离开Codex环境时Excel生成不受支持。
- Word、SQLite、公开源搜索脚本可在满足Python/Node依赖的普通终端中运行。
- 每次迁移后先用 `assets/sample-candidates.json` 验证未达标时仍能生成Word，再实际跑一次当天搜索验证完整门槛；不能只以文件复制成功作为可用证明。
- 本便携包不要求 `OPENAI_API_KEY`；Codex能力由目标电脑上的Codex Desktop登录授权提供。
