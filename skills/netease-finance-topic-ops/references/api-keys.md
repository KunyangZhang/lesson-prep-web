# API密钥与授权清单

## 完整部署所需API Key

实际需要配置的外部API Key只有两项：`EM_API_KEY` 和腾讯新闻API Key。两项均配置后，才能保持父 Skill 设定的完整优先级搜索覆盖；缺少其中一项时只能按规则降级到其他渠道。

| 能力 | 配置名称 | 是否为环境变量 | 获取地址 | 配置方式 | 缺失影响 |
|---|---|---:|---|---|---|
| 东方财富妙想财经搜索 | `EM_API_KEY` | 是 | https://ai.eastmoney.com/mxClaw | Windows持久配置：`[Environment]::SetEnvironmentVariable("EM_API_KEY", "YOUR_KEY", "User")`；macOS/Linux写入个人shell配置：`export EM_API_KEY="YOUR_KEY"` | `mx-finance-search`不可用；仍可降级到其他渠道，但覆盖不完整 |
| 腾讯新闻 | Tencent News API Key | 否，由CLI安全存储 | https://news.qq.com/exchange?scene=appkey | `tencent-news-cli apikey-set YOUR_KEY`，再以 `tencent-news-cli apikey-get` 验证 | `tencent-news`不可用；其余渠道可继续 |

## 账号授权，不是API Key

| 能力 | 授权方式 | 配置方式 | 缺失影响 |
|---|---|---|---|
| Codex | Codex账号及工作区授权 | 登录目标电脑上的Codex Desktop并打开工作区 | 无法运行自动选题流程，也无法调用依赖加载器和 `@oai/artifact-tool` |

本便携包不需要配置 `OPENAI_API_KEY`。不得把Codex账号凭据、会话Cookie或产品内部令牌复制进Skill目录。

## 不需要API Key的内置渠道

| Skill | 数据访问方式 | 仍需条件 |
|---|---|---|
| `wechat-article-search` | 搜狗微信公开网页 | Node.js、`cheerio`、网络访问；可能触发反爬 |
| `news-aggregator-skill` | 公开网页和公开接口 | Python、`requests`、`beautifulsoup4`、网络访问 |
| `toutiao-news-trends` | 今日头条公开热榜接口 | Node.js和网络访问；接口结构可能变化 |
| `a-stock-analysis` | 新浪财经公开行情接口 | Python和网络访问；仅覆盖A股 |

## 产品运行时，不是用户API Key

- `@oai/artifact-tool`：由Codex Desktop工作区依赖加载器提供，用于生成Excel。不得从未知npm源安装同名替代品。
- `python-docx`：用于生成Word正文和末尾集中信息来源。
- SQLite：Python标准库自带，无单独密钥。

## 安全规则

- 便携包和Git中只保留变量名与占位符，不放真实值。
- 不在命令输出、日志、JSON、Excel、Word或截图中打印密钥。
- `EM_API_KEY`只从目标电脑环境变量读取。
- 腾讯新闻Key只通过官方CLI的 `apikey-set` 写入；不要把它转存到 `.env`。
- 密钥泄露时立即到签发方撤销并重建。
