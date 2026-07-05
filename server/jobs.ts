import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config, logsDir, materialRoot } from "./config.js";
import { listCourseFiles } from "./files.js";
import { emitJobFinished } from "./jobEvents.js";
import { assessCourseQuality } from "./quality.js";
import { coreOutputFileNames, courseClassroomPdfFileName, ensureCourseClassroomPdfFileName, recoverCourseOutputDir } from "./courseOutput.js";
import { buildRagPlan, type RagPlan } from "./rag.js";
import type { Course, Job, Student } from "./types.js";
import type { Store } from "./store.js";
import { newId, nowIso } from "./store.js";

const activeJobs = new Map<string, ChildProcess>();

interface CodexJobOptions {
  refineInstruction?: string;
}

function quoteArg(value: string) {
  if (/^[\w.:\-/\\]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function shQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function courseTypeLabel(type: Course["type"]) {
  return type === "trial" ? "试听课" : "正式课";
}

function skillName(type: Course["type"]) {
  return type === "trial" ? "trial-lesson-prep" : "formal-lesson-prep";
}

function packagedSkillDir(type: Course["type"]) {
  return path.join(config.projectRoot, "skills", skillName(type));
}

function runnerWorkspace() {
  if (config.codexRunner === "ssh" && config.codexRemoteWorkspace) return config.codexRemoteWorkspace;
  return config.workspaceRoot;
}

function toRunnerPath(filePath: string) {
  if (config.codexRunner !== "ssh" || !config.codexRemoteWorkspace) return filePath;

  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;

  const root = path.resolve(config.workspaceRoot);
  const resolved = path.resolve(trimmed);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return filePath;

  const relative = path.relative(root, resolved).split(path.sep).filter(Boolean);
  return relative.length === 0 ? config.codexRemoteWorkspace : path.posix.join(config.codexRemoteWorkspace, ...relative);
}

function toRunnerProjectPath(filePath: string) {
  if (config.codexRunner !== "ssh") return filePath;

  const projectRoot = path.resolve(config.projectRoot);
  const resolved = path.resolve(filePath);
  const isInsideProject = resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`);
  if (isInsideProject && config.codexRemoteProjectRoot) {
    const relative = path.relative(projectRoot, resolved).split(path.sep).filter(Boolean);
    return relative.length === 0 ? config.codexRemoteProjectRoot : path.posix.join(config.codexRemoteProjectRoot, ...relative);
  }

  return toRunnerPath(filePath);
}

function mapRunnerPaths(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => toRunnerPath(line))
    .join("\n");
}

function readSmallFile(filePath: string, maxChars = 8000) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  return content.slice(-maxChars);
}

function buildExistingWorkContext(store: Store, course: Course) {
  const files = listCourseFiles(course.outputDir)
    .map((file) => `- ${file.kind}: ${toRunnerPath(file.path)}`)
    .join("\n");
  const previousJob = store.data.jobs
    .filter((job) => job.courseId === course.id && job.status === "completed")
    .sort((a, b) => (b.endedAt || b.createdAt).localeCompare(a.endedAt || a.createdAt))[0];
  const previousMessage = previousJob?.lastMessagePath ? readSmallFile(previousJob.lastMessagePath) : "";

  return [
    files ? `现有产物文件：\n${files}` : "现有产物文件：暂无可预览文件。",
    previousMessage ? `上一次 Codex 最终回复摘录：\n${previousMessage}` : "上一次 Codex 最终回复摘录：暂无。"
  ].join("\n\n");
}

function buildAutoQualityRefineInstruction(course: Course, failedJob: Job, student?: Student) {
  const pdfName = courseClassroomPdfFileName(course, student?.name);
  const issueLines =
    failedJob.quality?.items
      .filter((check) => check.status === "fail" || check.status === "warn")
      .slice(0, 12)
      .map((check) => `- ${check.label}：${check.message}`)
      .join("\n") || "- 质量检查未通过，但没有详细条目。";

  return `
这是系统根据质量检查自动发起的补救生成，不要从零重做。

本次只补救以下问题：
${issueLines}

补救要求：
1. 先阅读课程目录现有文件，保留可用内容。
2. 必须补齐或修正 _work/题目索引.md、_work/候选题池.md、_work/答案核对表.md。
3. 若题量不足，按 ${course.type === "trial" ? "试听课" : "正式课"} 和 ${course.durationMinutes} 分钟课长补充诊断、例题、变式、巩固、作业或口头微变式。
4. 若答案核对表缺项或有存疑题，逐题重算并写清最终答案、关键条件、关键步骤、易错点、核对结论。
5. 若逐字稿存在跳步或内容薄，按课堂页码逐页补老师说、追问、学生可能回答、纠错话术、板书或批注。
6. 最终产物仍是老师逐字稿.md、知识点详解.md、${pdfName}、课后反馈.md；最终产物不需要标注本地PDF来源，只有真题/模考题需要可靠来源。
`.trim();
}

function formatRagResult(result: RagPlan["selected"][number], index: number) {
  const question = result.question;
  const sourceText = question
    ? [
        `题号：${question.questionNumber || question.label}`,
        `来源状态：${question.sourceKind}`,
        question.examSource ? `考试来源：${question.examSource}` : "",
        `题型：${question.questionType}`,
        `难度：${question.difficulty}`,
        `教学角色：${question.teachingRoles.join("、")}`,
        question.hasAnswer ? "答案解析：有" : "答案解析：未检测到，需独立验算"
      ]
        .filter(Boolean)
        .join("；")
    : `资料片段：${result.snippet?.kind || "reference"}`;
  return [
    `【候选 ${index + 1}】${result.material.title}`,
    `路径：${toRunnerPath(result.material.path)}`,
    `相关度：${result.score}`,
    `命中原因：${result.reason}`,
    `匹配标签：${result.matchedTags.length > 0 ? result.matchedTags.join("、") : "[无]"}`,
    sourceText,
    question ? `题面摘录：${result.excerpt}` : `参考摘录：${result.excerpt}`
  ].join("\n");
}

function formatConfirmedAiDraft(student: Student, course: Course) {
  return `
用户确认后的 AI 草稿（这是本次调用 Codex 的主依据，已包含用户手动修改后的字段）：
- 学生姓名：${student.name || "[待确认]"}
- 学生长期画像：${student.notes || "[无]"}
- 薄弱点：${student.weakPoints || "[无]"}
- 常错题型/方法：${student.commonMistakes || "[无]"}
- 家长/老师沟通：${student.parentNotes || "[无]"}
- 下次课建议：${student.nextLessonSuggestion || "[无]"}
- 学段：${course.stage || "[待确认]"}
- 年级：${course.grade || "[待确认]"}
- 当前分数/水平：${course.score || "[待确认]"}
- 省市/试卷地区：${course.province || "[待确认]"}
- 教材版本：${course.textbook || "[待确认]"}
- 课程类型：${courseTypeLabel(course.type)}
- 课程性质：${course.lessonKind || "[待确认]"}
- 本次课程主题：${course.desiredContent || "[待确认]"}
- 上课时间：${course.lessonTime || "[待确认]"}
- 课长：${course.durationMinutes || "[待确认]"} 分钟
- 用户提供的本地题目/资料路径：${course.localFiles ? mapRunnerPaths(course.localFiles) : "[无]"}

AI 整理的备课执行要求 / 原始沟通材料（辅助依据，不能覆盖上面用户确认后的结构化字段）：
${course.notes || "[无]"}
`.trim();
}

export async function buildCodexPrompt(store: Store, student: Student, course: Course, options: CodexJobOptions = {}) {
  const skillDir = packagedSkillDir(course.type);
  const skillMd = path.join(skillDir, "SKILL.md");
  const classroomPdfName = courseClassroomPdfFileName(course, student.name);
  const finalOutputNames = coreOutputFileNames(course, student.name).join("、");
  const ragPlan = await buildRagPlan(store, course, 8);
  const pool = ragPlan.candidatePool;
  const ragContext =
    ragPlan.selected.length === 0
      ? "本地 RAG 暂无命中资料。仍需按 skill 要求搜索本地资料库和可靠网页来源。"
      : [
          `检索查询：${ragPlan.query || "[空]"}`,
          `意图标签：${ragPlan.intentTags.length > 0 ? ragPlan.intentTags.join("、") : "[未识别]"}`,
          "",
          "候选题池 - 可直接上课：",
          ...(pool.direct.length > 0 ? pool.direct.map(formatRagResult) : ["[无]"]),
          "",
          "候选题池 - 可改编为变式/巩固：",
          ...(pool.variants.length > 0 ? pool.variants.map(formatRagResult) : ["[无]"]),
          "",
          "候选题池 - 可做作业：",
          ...(pool.homework.length > 0 ? pool.homework.map(formatRagResult) : ["[无]"]),
          "",
          "候选资料 - 知识点/解析参考：",
          ...(pool.reference.length > 0 ? pool.reference.map(formatRagResult) : ["[无]"]),
          "",
          "综合入选候选：",
          ...ragPlan.selected.map(formatRagResult),
          ragPlan.rejected.length > 0
            ? [
                "",
                "未入选候选：",
                ...ragPlan.rejected.map((item) => `- ${item.title}（${item.score}）：${item.reason}`)
              ].join("\n")
            : ""
        ]
          .filter(Boolean)
          .join("\n\n");

  const basePrompt = `
请使用项目内置 Codex skill：${skillName(course.type)}，为下面学生准备一节${courseTypeLabel(course.type)}。

项目内置 skill 位置：
- skill 目录：${toRunnerProjectPath(skillDir)}
- SKILL.md：${toRunnerProjectPath(skillMd)}

执行要求：
1. 先完整阅读上面的 SKILL.md。
2. 如果 SKILL.md 引用 references、scripts 或 assets，请按 skill 目录的相对路径读取和使用。
3. 不要依赖个人 ~/.codex/skills 里是否安装了同名 skill；以项目内置版本为准。

硬性要求：
1. 工作目录是 ${runnerWorkspace()}
2. 所有最终产物必须保存到这个课程目录：${toRunnerPath(course.outputDir)}
   - 目录名必须完全一致，不能为了简短而截断、重命名或另建同级目录。
3. 必须生成 skill 要求的四个用户可用产物：${finalOutputNames}
   - 课堂 PDF 文件名必须使用：${classroomPdfName}
   - 不要把课堂 PDF 保存为旧固定名“课堂课件.pdf”。
4. 不要修改 lesson-prep-web 项目文件，不要移动无关历史备课文件
5. 如果信息不足，请按 skill 规则使用 [待确认]，但仍生成可上课的初稿
6. 资料库根目录是 ${toRunnerPath(materialRoot)}
7. 优先阅读并使用“用户提供的本地题目/资料路径”中的文件；这些是人工指定资料，优先级高于自动 RAG
8. 按下面的 RAG 检索计划使用入选资料：先阅读路径，再判断哪些题型/讲法适合本课；不要只复制摘录
9. 仍需按 skill 要求做本地资料库检索和可靠网页真题检索，必要时补充 RAG 未覆盖的真题
10. 大任务固定使用 sub-agent 分工；备课任务默认拆成四个工作流：题目提取、答案核对、课件生成、逐字稿和内容丰富。主 Agent 负责分派、整合和最终质量门禁，不能跳过答案核对、题量补充和逐字稿扩写。
11. 必须先生成中间工作文件，再生成最终四件套；中间文件放在课程目录的 _work/ 下：
   - _work/题目索引.md：列出候选与最终采用题，标注教学角色、难度、是否真题、是否进入课件；本地资料题不需要写入最终产物来源。
   - _work/候选题池.md：把本地资料、RAG、网页真题整理成候选题池，区分可直接上课、可改编成变式、只适合作参考、不采用。
   - _work/答案核对表.md：逐题写最终答案、关键条件、关键步骤、易错点、核对结论；不能出现未核对题。
12. 采用两阶段内部流程：第一阶段完成题目提取、候选题池、答案核对、课程骨架；第二阶段再做课件生成、逐字稿和内容丰富、最终四件套。不要一上来直接写最终稿。
13. 内容必须充实：题目序列要覆盖诊断、例题、变式、巩固、课后作业，逐字稿要按课堂页码逐页展开讲法、追问、学生可能反应、纠错话术和板书提示；不能只生成少量题或简略提纲。
14. 资料详细程度与学生分数段无关：无论学生多少分，“知识点详解.md”和“老师逐字稿.md”都必须按最高备课密度写，让老师拿着资料直接讲，不会在“这一步为什么可以这样做”上卡壳。“60分学生能听懂”只是语言清晰度和前置铺垫的最低门槛，不是降低资料深度的理由。
15. 知识点详解必须区分“一般结论”和“二级结论”：
   - 一般结论（定义、标准方程、基本符号、课本直接性质）可以直接给出，但必须写清成立条件、符号含义和易错边界。
   - 二级结论（焦半径、通径、焦点弦、弦长公式、中点弦/点差法、角相等转斜率、定点定值整理、参数法少算一个根、韦达条件转换、面积/距离快捷表达等）必须详细写出“从哪里来、逐步推导、每一步为什么成立、什么时候不能用、课堂怎么讲”。不能只列公式或只说“由结论得”。推导时必须拆到最小可教学步骤，展开、移项、通分、因式分解、除以非零量、开方、代入定义、检查参数范围都要分开写。
16. 题目过程必须“一小步都不能跳”，比普通板书更细。每道题都要说明：为什么这样设、为什么这样消元、为什么能用这个公式/结论、每一步代数如何展开和化简、哪里需要验算或讨论特殊情况。禁止用“显然”“直接可得”“代入整理得”“通分化简得”“由韦达可得”“联立解得”跳过关键过程；必须写出中间等式链和操作理由，尤其是通分、因式分解、韦达代入、向量/角度/斜率转换。
17. 如果题目使用了二级结论，必须在题目解答处复述必要推导或明确指向“知识点详解.md”中对应推导，并检查本题是否满足适用条件。
18. 课长最低题量标准：40-60分钟试听课至少包含诊断/陷阱题、模型题、同类验证题、变式或真题风格题、课后练习；90分钟正式课至少包含完整的诊断、例题、指导练习、独立变式、巩固检查和作业题组。若因用户指定资料太少而少于标准，必须在最终说明或逐字稿中说明原因并补充口头微变式或作业。
19. 来源规则：最终产物不需要标注本地PDF、本地页码或普通改编题来源；只有真题、官方考试题、模考题必须核验来源，写清年份、地区、试卷/考试名称、题号或URL。不能把本地题、改编题、资料库题伪称为真题。
20. 最终自检重点是：答案是否已经核对、解法是否跳步、二级结论是否有推导、知识点是否足够支撑老师不卡壳地讲、题量是否不足、逐字稿是否只是提纲。发现问题要先修正再结束。
21. ${classroomPdfName} 的形态必须是 A4 竖版数学课堂讲义，不是 PPT 或 16:9 幻灯片：
   - 使用项目 skill 的 assets/tablet-beamer-template.tex 作为模板；该模板虽然保留历史文件名，但内容是 A4 竖版讲义模板。
   - 页面标题使用正常课堂讲义抬头，例如“[课程主题]课堂讲义”；不要写学生/日期副标题，也不要把“学校试卷风”“A4竖版”“题目与留白”等样式说明写进正式 PDF。
   - PDF 顺序必须是：知识点展示页 -> 题目页/题组页 -> 常用套路模板总结页。
   - 知识点展示页必须像教辅书的“基础知识梳理”完整展开，不是课前导入提纲，也不是只服务后面几道题的局部提示。先把本专题学生上课会听到的基本知识系统写全，再进入题目页；内容详实且不留书写空白。
   - 知识点展示页只写抽象通用内容：定义/对象/符号、成立条件和范围、公式或性质、图像/几何/表格表征、判定方法、常见题型信号、易错边界。不要引用后面题目的题号、具体函数式、具体数字、局部题目条件、完整解题过程、答案或教师话术。
   - 知识点展示页宁可多页也不要薄。每个核心知识对象至少按“是什么、什么时候能用、怎么表示或画图、能推出什么、怎么判定、哪里容易错”展开；一页放不下就继续加知识点页，不能压缩成几条空泛总结。
   - 函数专题要覆盖函数定义、定义域、值域、对应法则、相同函数判定、解析式/图像/表格/文字表示、图像点的含义、单调性、奇偶性或对称性、最值、零点、端点、参数影响等适用内容。二次函数要覆盖一般式/顶点式/交点式、开口方向、对称轴、顶点、判别式、根、与 x 轴交点、单调区间、区间最值和图像示意。最值要明确“区间最值通常来自端点值、内部极值点、不可导点或边界临界点”，并写清极值的必要条件和充分条件。零点要用图像说明与 x 轴交点，并区分穿过、相切、无交点和含参临界状态。
   - PDF 的题目页只放学生需要看到的题目、条件、必要图形、表格、坐标系和干净书写留白；不要放答案、完整过程、提示页、关键步骤 reveal 页或教师来源说明；书写留白不要画横线框框。
   - 智能混排：大题通常一题一页；同类小题可以合并一页，但必须保留足够书写空间。
   - 几何、函数图像、坐标系、向量/复平面、统计图表等能用 LaTeX 画出的题，课堂 PDF 必须用 TikZ、pgfplots 或 LaTeX 表格画出来；不要省略与解题相关的图像。
   - 最后的“常用套路模板总结”不能硬总结：只有本节课题型确实有高频可迁移套路时才总结；每条写清适用题型/识别信号、使用条件、操作顺序和容易失效的情况。
22. Markdown 里的数学公式必须规范：
   - 行内公式统一使用美元符号包裹，例如 $\\vec{a}=(2,-1)$、$X\\sim N(\\mu,\\sigma^2)$
   - 独立展示公式统一使用双美元符号块
   - 不要把 LaTeX 公式写成普通括号形式，例如不要写 (\\vec{a}=(2,-1))、(E(X)=n\\cdot\\frac{M}{N})
   - 不要留下未包裹的 LaTeX 片段，例如不要写「求 \\vec{a}\\cdot\\vec{b}」，必须写成「求 $\\vec{a}\\cdot\\vec{b}$」
   - 不要混用 \\(...\\)、\\[...\\] 和普通括号包公式；如果引用资料里有这种写法，写入最终 md 前必须改成美元符号格式
   - 向量命令优先写成带花括号形式，例如 \\vec{a}、\\vec{b}
23. 只负责生成本地四个产物；不要在 Codex 任务内部调用 lark-cli。任务完成后，宿主服务会用当前机器已登录的 lark-cli user 身份统一完成飞书上传、日程创建和消息通知。

${formatConfirmedAiDraft(student, course)}

本地 RAG 检索计划：
${ragContext}

请完成备课并在最后简短列出生成的文件路径，路径必须位于指定课程目录下。`.trim();

  if (!options.refineInstruction) return basePrompt;

  return `
这是一次基于既有课程目录的补充生成，不是从零重做。

补充要求：
${options.refineInstruction}

处理原则：
1. 先阅读课程目录里已经生成的文件，再补充内容少、缺项、讲解不够细或排版不够好的部分。
2. 尽量在原文件基础上增补和改写，不要无理由删除已有内容。
3. 仍需保持四个核心产物可用：${finalOutputNames}。
4. 如需重新编译 PDF，请确保 ${classroomPdfName} 可打开。

${buildExistingWorkContext(store, course)}

${basePrompt}`.trim();
}

function buildCodexExecArgs(workspace: string, lastMessagePath?: string) {
  const args = ["exec", "-C", workspace, "--sandbox", "danger-full-access"];
  if (lastMessagePath) args.push("--output-last-message", lastMessagePath);
  if (config.codexModel) args.push("--model", config.codexModel);
  args.push("-");
  return args;
}

async function buildLessonFeishuEnv() {
  const parentFolderToken =
    process.env.LESSON_FEISHU_PARENT_FOLDER_TOKEN || process.env.FEISHU_LESSON_PARENT_FOLDER_TOKEN || "LY9efBiWjlEAQWdqPrucuLl4nic";
  return {
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER || "1",
    LARKSUITE_CLI_REMOTE_META: process.env.LARKSUITE_CLI_REMOTE_META || "off",
    LESSON_FEISHU_PARENT_FOLDER_TOKEN: parentFolderToken,
    FEISHU_LESSON_PARENT_FOLDER_TOKEN: parentFolderToken,
    FEISHU_LESSON_CALENDAR_ENABLED: process.env.FEISHU_LESSON_CALENDAR_ENABLED || "true",
    FEISHU_LESSON_CALENDAR_ID: process.env.FEISHU_LESSON_CALENDAR_ID || "",
    FEISHU_LESSON_CALENDAR_ATTENDEE_IDS: process.env.FEISHU_LESSON_CALENDAR_ATTENDEE_IDS || ""
  };
}

function buildJobCommand(course: Course, lastMessagePath: string) {
  if (config.codexRunner === "ssh") {
    if (!config.codexSshHost) throw new Error("CODEX_RUNNER=ssh requires CODEX_SSH_HOST.");
    const remoteWorkspace = runnerWorkspace();
    const remoteOutputDir = toRunnerPath(course.outputDir);
    const target = config.codexSshUser ? `${config.codexSshUser}@${config.codexSshHost}` : config.codexSshHost;
    const codexArgs = buildCodexExecArgs(remoteWorkspace);
    const remoteEnv = [
      `PREP_WORKSPACE=${shQuote(remoteWorkspace)}`,
      `PREP_MATERIAL_ROOT=${shQuote(toRunnerPath(materialRoot))}`
    ];
    if (config.codexRemoteProjectRoot) {
      remoteEnv.push(`LESSON_PREP_WEB_ROOT=${shQuote(config.codexRemoteProjectRoot)}`);
    }
    const remoteCommand = [
      "mkdir",
      "-p",
      shQuote(remoteOutputDir),
      "&&",
      ...remoteEnv,
      shQuote(config.codexRemoteCommand),
      ...codexArgs.map(shQuote)
    ].join(" ");
    const args = [];
    if (config.codexSshPort) args.push("-p", String(config.codexSshPort));
    if (config.codexSshKey) args.push("-i", config.codexSshKey);
    args.push(target, remoteCommand);
    return { command: "ssh", args, runner: "ssh" as const };
  }

  return {
    command: config.codexCommand,
    args: buildCodexExecArgs(config.workspaceRoot, lastMessagePath),
    runner: "local" as const
  };
}

export function createCodexJob(store: Store, course: Course, options: CodexJobOptions = {}) {
  const jobId = newId("job");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${jobId}.log`);
  const lastMessagePath = path.join(logsDir, `${jobId}.last.md`);
  const runnerCommand = buildJobCommand(course, lastMessagePath);

  const job: Job = {
    id: jobId,
    courseId: course.id,
    status: "queued",
    logPath,
    lastMessagePath,
    command: [runnerCommand.command, ...runnerCommand.args.map(quoteArg)].join(" "),
    args: runnerCommand.args,
    runner: runnerCommand.runner,
    refineInstruction: options.refineInstruction,
    createdAt: nowIso()
  };

  store.addJob(job);
  course.jobId = job.id;
  course.status = "queued";
  course.updatedAt = nowIso();
  store.save();
  return job;
}

export function runCodexJob(store: Store, jobId: string) {
  if (activeJobs.has(jobId)) return;
  const job = store.findJob(jobId);
  if (!job) return;
  const course = store.findCourse(job.courseId);
  const student = course ? store.findStudent(course.studentId) : null;
  if (!course || !student) {
    job.status = "failed";
    job.error = "Course or student was not found.";
    job.endedAt = nowIso();
    store.save();
    return;
  }

  fs.mkdirSync(course.outputDir, { recursive: true });

  job.status = "running";
  job.startedAt = nowIso();
  course.status = "running";
  course.updatedAt = nowIso();
  store.save();

  const append = (chunk: Buffer | string) => {
    fs.appendFileSync(job.logPath, chunk.toString(), "utf8");
  };

  const failBeforeSpawn = (error: Error) => {
    job.status = "failed";
    job.error = error.message;
    job.endedAt = nowIso();
    course.status = "failed";
    course.updatedAt = nowIso();
    activeJobs.delete(jobId);
    store.save();
    append(`\n[spawn error] ${error.message}\n`);
    emitJobFinished(store, course, job);
  };

  void (async () => {
    const prompt = course.codexPromptOverride && !job.refineInstruction
      ? course.codexPromptOverride
      : await buildCodexPrompt(store, student, course, {
          refineInstruction: job.refineInstruction
        });
    fs.writeFileSync(job.logPath, `# ${job.command}\n\n${prompt}\n\n--- CODEx OUTPUT ---\n`, "utf8");

    let lessonFeishuEnv: Record<string, string> = {};
    try {
      lessonFeishuEnv = await buildLessonFeishuEnv();
    } catch (error) {
      append(
        `\n[feishu env warning] failed to prepare lark-cli sync env: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }

    const command = job.runner === "ssh" ? "ssh" : config.codexCommand;
    const child = spawn(command, job.args || [], {
      cwd: config.workspaceRoot,
      env: {
        ...process.env,
        ...lessonFeishuEnv,
        PREP_WORKSPACE: config.workspaceRoot,
        PREP_MATERIAL_ROOT: materialRoot,
        LESSON_PREP_WEB_ROOT: config.projectRoot
      },
      shell: process.platform === "win32",
      windowsHide: true
    });
    activeJobs.set(jobId, child);

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("error", failBeforeSpawn);

    child.on("close", (code) => {
      activeJobs.delete(jobId);
      if (job.status === "canceled") {
        store.save();
        return;
      }
      const recovery = recoverCourseOutputDir(course, job);
      if (recovery.changed) {
        append(`\n[system] ${recovery.reason}\n`);
      }
      ensureCourseClassroomPdfFileName(course, student.name);
      const files = listCourseFiles(course.outputDir);
      job.exitCode = code;
      job.endedAt = nowIso();
      job.quality = assessCourseQuality(course, student.name);
      const qualityFailed = job.quality.status === "fail";
      const shouldAutoRefine = code === 0 && files.length > 0 && qualityFailed && !job.refineInstruction;
      if (shouldAutoRefine) {
        job.status = "failed";
        job.error = "生成质量检查未通过，系统已自动发起补救生成。";
        course.updatedAt = nowIso();
        store.save();
        const refineJob = createCodexJob(store, course, {
          refineInstruction: buildAutoQualityRefineInstruction(course, job, student)
        });
        runCodexJob(store, refineJob.id);
        return;
      }
      if (code === 0 && files.length > 0 && !qualityFailed) {
        job.status = "completed";
        course.status = "completed";
      } else {
        job.status = "failed";
        course.status = "failed";
        job.error =
          code === 0 && qualityFailed
            ? "生成质量检查未通过，请查看缺失文件或异常项。"
            : code === 0
            ? "Codex exited successfully, but no previewable course files were found."
            : `Codex exited with code ${code}.`;
      }
      course.updatedAt = nowIso();
      store.save();
      emitJobFinished(store, course, job);
    });
  })().catch(failBeforeSpawn);
}

export function cancelCodexJob(store: Store, jobId: string) {
  const job = store.findJob(jobId);
  if (!job) return { ok: false, status: 404, error: "Job not found." };
  const course = store.findCourse(job.courseId);
  if (job.status !== "queued" && job.status !== "running") {
    return { ok: false, status: 409, error: "该任务当前不能取消。" };
  }

  job.status = "canceled";
  job.error = "用户取消生成。";
  job.endedAt = nowIso();
  if (course) {
    course.status = "canceled";
    course.updatedAt = nowIso();
  }

  const child = activeJobs.get(jobId);
  if (child) {
    fs.appendFileSync(job.logPath, "\n[system] 用户取消生成。\n", "utf8");
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  }

  activeJobs.delete(jobId);
  store.save();
  return { ok: true, job, course };
}

export function recoverInterruptedJobs(store: Store) {
  for (const job of store.data.jobs) {
    if (job.status === "running" || job.status === "queued") {
      job.status = "failed";
      job.error = "Server restarted before this job finished.";
      job.endedAt = nowIso();
      const course = store.findCourse(job.courseId);
      if (course && (course.status === "running" || course.status === "queued")) {
        course.status = "failed";
        course.updatedAt = nowIso();
      }
    }
  }
  store.save();
}
