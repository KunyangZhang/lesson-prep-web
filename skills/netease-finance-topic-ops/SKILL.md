---
name: netease-finance-topic-ops
description: 自动完成网易财经消费行业每日选题运营，包括使用 Web Search、官方原始信源和多类资讯工具搜索至少100条四天内的去重资料，以S级信源为核心核验事实，力争筛选至少4条成熟选题，完成网易同题查重、Excel与SQLite双台账留痕，并无条件生成末尾集中列明信息来源的Word报送文档；同时内置资讯子Skill和跨电脑部署工具。用于“今日选题”“财经选题搜索”“选题台账”“查重”“选题Word报送”“部署选题Skill”或复盘历史选题等任务。
---

# 网易财经选题运营

把每日选题视为一条可审计的数据流水线。所有候选均入库；聚合平台只提供线索，最终事实必须回到官方、公告、财报或权威媒体原文。

## 启动前

1. 读取 `references/editorial-rules.md`、`references/channel-priority.md` 和 `references/source-reliability.md`。
2. 涉及字段、状态或查重时，再读取 `references/ledger-schema.md`。
3. 先确认 Web Search 可用，并把它作为发现线索和定位 S 级原文的主路径。内嵌资讯子 Skill 是补充渠道，不得作为开始搜索的前置条件，也不得替代 Web Search 和官方原文核验。
4. 需要调用内嵌子 Skill 时，再使用工作区依赖加载器取得 Python、Node.js 和 `@oai/artifact-tool` 路径，并用加载器返回的 Python 执行 `scripts/ensure_ready.py --artifact-node-modules <node_modules路径> --node-executable <node路径>`。某个子 Skill 不可用时记录 `unavailable`，继续使用 Web Search、官方网站和其他可用渠道；不得把未执行的渠道写成已完成。
5. 首次部署、更换电脑或保障失败时，读取 `references/deployment.md` 和 `references/api-keys.md`。
6. 将当天工作目录设为用户指定目录；未指定时使用当前目录下 `outputs/YYYY-MM-DD/`。
7. 沿用已有 `topic-ledger.sqlite`，不得为新一天另建历史库。

## 每日流程

### 1. 建立搜索窗口

- 以上海时区搜索日为基准，资料发布时间必须在搜索日当天及此前3个自然日内，共4个自然日。缺失发布时间、早于窗口或晚于搜索日的资料不计入搜索门槛，也不能作为最终选题信源。
- 聚焦食品、餐饮、酒水、饮料、美妆、日化、服装、医药、零售。
- 优先龙头、独角兽、国内企业及外企中国业务。
- 先列公司池和事件词，再按渠道优先级搜索；不得只搜宽泛的“财经新闻”。

### 2. 搜索并累计至少100条资料

严格按 `references/channel-priority.md` 执行。先用 Web Search 按公司、行业、事件词和站点限定搜索，优先定位 S 级官方、法定及直接责任主体原文；再用权威媒体和内嵌子 Skill 扩充线索。不得把内嵌 Skill 的结果当作唯一候选池。

这6个子 Skill 的可迁移源码位于 `assets/bundled-skills/`。正常运行时调用安装到 Codex skills 目录中的同名 Skill；缺失时可按部署说明补齐，但不得因此停止 Web Search 和官方源搜索。

每次查询必须记录：查询词、渠道、执行时间、时间窗、返回条数和错误；每条资料必须记录唯一结果ID、标题、URL、渠道、信源等级、发布时间、抓取时间和支持的线索。只统计发布时间位于四天窗口内的资料，按规范化URL去重后至少达到100条，且必须包含 Web Search 结果，才能开始拆解、评分和选题。搜索日志中的汇总数字不能代替逐条资料记录。少于100条时继续搜索，不得提前进入选题。

### 3. 回溯原始证据

- 每个最终候选必须绑定至少1个四天窗口内的S级来源；S级来源负责支撑事件成立、关键数字和核心结论。A级和B级来源只用于交叉验证、背景和补充，不得替代S级门槛。
- 对数字、日期、公司表述和监管结论逐项核验。
- 保存原文标题、URL、发布时间、抓取时间、关键句及其支持的事实。
- 社交平台、热榜和聚合摘要不得作为唯一可引用证据。

### 4. 拆解选题

把候选整理为：`公司 + 最新事件 + 关键数字 + 核心矛盾`。每题提炼2-3个互不重复的矛盾点，优先寻找战略与业绩、增长与盈利、扩张与闭店、提价与需求、品牌定位与渠道现实、国内承压与海外增长等可证实张力。不得广告化，也不得为了负面而硬黑。

### 5. 评分与否决

按100分制评分：时效20、企业主体15、事件强度15、矛盾20、流量10、延展性10、证据10。先执行否决项，再比较总分。

以下任一项直接淘汰：网易财经或网易号外已发完全同题；核心事实无法核实；超过时效且无新增事实；纯广告；硬黑或明显失衡。

### 6. 历史查重

1. 先查 SQLite 的精确指纹。
2. 再查同公司、同事件类型和标准关键词的相似度。
3. 再人工搜索网易财经、网易号外和公众号后台；无法访问的渠道标记 `not_checked`，不得假定通过。
4. 旧题出现实质新增事实时，填写“新增事实”和“人工覆盖理由”。

使用：

```powershell
python scripts/topic_ops.py ingest --db topic-ledger.sqlite --input candidates.json --output normalized.json
```

### 7. 选出报送题

- 每日必须提交至少4条状态为 `submitted` 或 `approved` 的成熟选题。
- Word只收录状态为 `submitted` 或 `approved` 的最终题。
- 候选、淘汰、驳回、重复和已发布题仍全部保留在 SQLite 与Excel中。
- 若不足4题，扩大公司池、事件词、Web Search 查询和S级站点覆盖并继续搜索；仍不足时明确说明覆盖渠道、缺口和原因，禁止用低质量题凑数。无论最终有几条成功选题，都继续生成Word，并在Word中标明未达标原因。

### 8. 生成双台账与Word

先导出统一JSON：

```powershell
python scripts/topic_ops.py export --db topic-ledger.sqlite --output ledger-export.json
```

再生成Excel。运行前在当天工作目录建立指向加载器所给 `node_modules` 的目录联接：

```powershell
node scripts/build_workbook.mjs --input ledger-export.json --output 每日选题台账.xlsx
```

生成B版Word：

```powershell
python scripts/generate_report.py --input normalized.json --output 每日财经选题.docx
```

Word必须包含日期、完成状态、实际成功选题、第一至第三部分、编号分论点和末尾“信息来源”。即使搜索资料不足100条、成功选题不足4条或没有成功选题，也必须生成Word并写明实际结果与未达标原因。每个事实段统一写成`短结论：对应数据`，短结论控制在2至10个汉字，必须准确概括同段数据，结论与数据一一对应。事实段不使用项目符号，不得用短横线或手工字符模拟项目符号；正文禁止出现半角短横线、中文破折号和短破折号。不得添加封面、目录、表格、图片或彩色装饰。正文不使用脚注、尾注、上标编号或手工上标字符；所有被实际选题引用的来源去重后集中列在文档末尾。

### 9. 验证与交付

```powershell
python scripts/validate_outputs.py --db topic-ledger.sqlite --xlsx 每日选题台账.xlsx --docx 每日财经选题.docx
```

必须检查：SQLite记录与关系完整性、四天内去重资料数、Web Search覆盖、S级来源门槛、Excel四张工作表及公式错误、DOCX在任何结果下均存在、DOCX不含脚注或上标引用、末尾存在“信息来源”、每个事实段符合`短结论：对应数据`、正文不含半角短横线、中文破折号或短破折号。遵从用户要求，不进行图片渲染检查。

交付时报告：搜索截止时间、四天窗口起止日、去重资料总数、Web Search资料数、S级资料数、覆盖渠道、最终题数、淘汰与重复数量、未核验项、SQLite/Excel/Word路径及验证结果。不得把未执行的搜索或验证写成已完成。

## 跨电脑部署

便携包包含父 Skill、6个资讯子 Skill、依赖锁定文件、安装脚本和预检脚本。部署步骤与支持边界见 `references/deployment.md`；全部密钥名称、获取地址和配置方式见 `references/api-keys.md`。

- Windows：运行 `powershell -ExecutionPolicy Bypass -File scripts/install-portable.ps1`；在 Codex 中优先用 `-PythonExecutable` 指向工作区依赖加载器返回的 Python。
- macOS/Linux：运行 `sh scripts/install-portable.sh`。
- 安装完成后重启 Codex，加载工作区依赖，并运行 `scripts/ensure_ready.py`；该脚本补全可修复组件并调用严格预检。
- 不复制任何真实密钥、账号、Cookie、CLI凭据或本机缓存。
- `@oai/artifact-tool`、Codex文档运行时和工作区依赖加载器由 Codex Desktop 提供，便携包只检测，不从第三方安装。
