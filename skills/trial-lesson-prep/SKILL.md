---
name: trial-lesson-prep
description: Prepare structured one-on-one junior-high or high-school math trial lessons from student information, a recursive local material library, and verified web exam-question research. Use whenever the user mentions 试听课, 体验课, 试讲, 试听备课, 试听课流程, 试听课反馈, 转化, 家长沟通, 初中数学, 高中数学, 中考真题, 高考真题, 省市题, 搜题, 大招, 解题技巧, 知识点详解, 老师逐字稿, LaTeX课件, Beamer课件, or asks for a classroom PDF with writable tablet space and detailed teacher solutions.
---

# Trial Lesson Prep

## Core Rule

Prepare a trial math lesson that creates a visible and honest learning gain while remaining educationally useful. Use Chinese unless the user asks otherwise. If information is missing, still create a usable draft with `[待确认]` placeholders and a short `课前需确认` section.

Read [references/math-lesson-core.md](references/math-lesson-core.md) first. Its output, source-reliability, difficulty, solution, and PDF rules are mandatory. Read [references/class-questions-flow.md](references/class-questions-flow.md) for operational communication and follow-up details.

## Sub-Agent Delegation Rule

Large lesson-prep tasks must use sub-agent division of labor before final deliverables are assembled. For trial lessons, use these default workstreams:

1. `题目提取`: extract questions from user-provided local files, library candidates, screenshots, and web exam sources; build an internal question index and identify missing figures or unclear text.
2. `答案核对`: independently solve and verify every selected question, checking conditions, calculations, diagrams, and answer forms.
3. `课件生成`: build the Beamer classroom PDF from the verified question sequence, keeping it student-facing and aligned with the visible-gain flow.
4. `逐字稿和内容丰富`: expand the lesson content and teacher script after the verified question sequence is set; add enough diagnostic, model, same-type validation, variant, and homework questions; write page-by-page teaching language, follow-up prompts, likely student responses, correction wording, board notes, and `大招/爽感` moments.

The main agent owns task decomposition, integration, conflict resolution, and the final quality gate. Do not skip `答案核对`, question-volume expansion, or teacher-script enrichment on substantial courses.

## Internal Working Files

Create intermediate working files in `_work/` for substantial lesson-prep jobs. These files are internal QA artifacts and are not user-facing deliverables:

1. `_work/题目索引.md`: extracted local, library, screenshot, and web questions with internal IDs, topics, teaching roles, and missing information.
2. `_work/候选题池.md`: shortlisted and rejected candidates, fit rationale, and whether a question is verified authentic exam, official exam, simulation/mock, local, adapted, or self-written.
3. `_work/答案核对表.md`: independent solutions, final answers, condition checks, diagram checks, and unresolved doubts.
4. `_work/课件页码映射.md`: classroom PDF page numbers mapped to the visible `第X题` labels and teacher-script sections.
5. `_work/内容丰富清单.md`: checks for sufficient diagnosis, model, same-type validation, variant/authentic-style, homework, prompts, and common-error coverage.

Do not require these working files to be uploaded or emphasized in the final user-facing materials unless the user asks.

## Two-Stage Internal Workflow

Run lesson preparation in two internal stages:

1. Stage 1: complete question extraction, `_work/题目索引.md`, `_work/候选题池.md`, `_work/答案核对表.md`, and the visible-gain course skeleton before drafting final materials.
2. Stage 2: generate the Beamer classroom PDF, write the teacher script, enrich the content and conversion/follow-up wording, complete the final four deliverables, and run the quality gate.

Do not enter Stage 2 until the selected question sequence has been checked for answer correctness, topic fit, visible-gain design, and enough question volume for the requested class length.

## Required Outputs

Create exactly these user-facing lesson deliverables unless the user asks otherwise:

1. `老师逐字稿.md`
2. `知识点详解.md`
3. `课堂课件.pdf`
4. `课后反馈.md`

Include pre-class communication and follow-up/conversion wording inside `老师逐字稿.md`. Generate parent-facing post-class feedback as a separate `课后反馈.md` file by default. Do not create a student handout by default.

## Trial Lesson Feel: 大招 And 爽感

Every trial lesson must create a visible, honest "爽感": the student first feels a real bottleneck, then learns a named repeatable method, then immediately proves the gain on a same-type question. Name the method as a memorable `大招`, but state its conditions clearly and avoid flashy tricks with hidden assumptions.

For a 60-minute trial lesson, use a wider version of the default flow:

- 0-5 min: rapport, goal, and promise of one visible gain.
- 5-12 min: diagnostic/trap attempt from the student's materials.
- 12-22 min: expose the bottleneck and teach the first named method.
- 22-34 min: guided practice so the student experiences the first win.
- 34-46 min: teach the second linked method or an upgraded version.
- 46-54 min: same-type validation or authentic exam-style question.
- 54-60 min: before-and-after recap, next-step hook, homework, and parent-facing summary cue.

If a local PDF/question document is provided, use it as the primary lesson spine. Classroom PDF problem pages should show student-facing labels like `第7题`; keep any local page/question-number mapping in `_work/题目索引.md` or `_work/课件页码映射.md` for internal verification. The teacher script only needs to align with classroom PDF page numbers and visible `第X题` labels, plus the detailed teaching script.

## Inputs To Collect Or Infer

Identify:

- Student name, junior-high or high-school stage, grade, province or paper region, school topic, exact knowledge point, and class length.
- Recent score, ranking, school level, exam difficulty, recent paper, answer sheet, wrong questions, or screenshots.
- Student goal, confidence, likely bottleneck, and the observable result to demonstrate.
- Parent or advisor notes, schedule, and conversion concerns when available.

If only a topic is provided, assume a 40-minute one-on-one trial lesson and mark missing details as `[待确认]`.

## Workflow

### 1. Diagnose The Student

Build a student-specific diagnosis. Do not classify solely by score or force a fixed taxonomy. Use score, paper difficulty, wrong-answer patterns, confidence, current progress, and lesson duration to define a custom lesson ladder.

Name each layer for this student, explain its purpose, connect it to selected questions, and state the condition for moving forward.

### 2. Run Dual-Track Research

Research local materials and web exam questions in parallel:

- Determine the local material root from, in order: a user-provided path, `PREP_MATERIAL_ROOT`, `${PREP_WORKSPACE}/资料库`, or the web app workspace's `资料库` directory.
- Prefer the cross-platform helper:
  `python3 scripts/find_materials.py --root "<资料库路径>" --stage "<初中数学或高中数学>" --grade "<年级>" --keywords "<知识点>,<题型>" --limit 80`
- On Windows, if Python is unavailable but PowerShell is available, use:
  `powershell -ExecutionPolicy Bypass -File scripts/find_materials.ps1 -Root "<资料库路径>" -Stage "<初中数学或高中数学>" -Grade "<年级>" -Keywords "<知识点>,<题型>" -Limit 80`
- Recursively search regardless of directory depth. Use path matches to shortlist files, then inspect only relevant candidates.
- Search verified web sources for localized 中考, 高考, school mock-exam, and teaching-research questions.
- Treat authentic exam questions as a core source, especially when the lesson needs authority, diagnosis, or a memorable method.
For authentic exam, official exam, and mock/simulation questions, verify and record reliable source information. For local, adapted, or self-written questions, do not force a source label, but never present them as authentic exam questions unless that status is verified.

### 3. Design A Visible Gain

Build a before-and-after contrast:

- Start with a diagnostic or trap question that matches the student.
- Let the student attempt it.
- Expose the bottleneck without blame.
- Teach a small, honest, repeatable method with explicit conditions.
- Give a same-type variant so the student proves the gain.
- Leave a next-lesson hook that points toward systematic learning.
- Explicitly write the `大招名称`, `适用条件`, `爽感设计`, and `学生证明自己会了的动作` in `老师逐字稿.md`.

### 4. Verify Every Question

For every used question:

- Verify the mathematics independently.
- Record teaching role, fit, recognition signals, solution plan, full solution, checks, alternative routes when useful, common wrong paths, and a hint ladder.
- For authentic exam, official exam, and mock/simulation questions, keep reliable source information; local, adapted, or self-written questions do not need forced source labels and must not be mislabeled as authentic exam questions.
- Include detailed reasoning in `老师逐字稿.md`, not only a final answer.
- Expand each selected question into teachable content: setup, first observation, micro-step solution, teacher prompts, expected student responses, common wrong turns, correction wording, and a same-type validation or transfer prompt.

The question set must be rich enough for the requested class length and visible-gain design. For a 40-60 minute trial lesson, include at minimum a diagnostic/trap question, one model question, one guided same-type question, one independent validation question, one variant or authentic exam-style question, and homework or next-step practice. If fewer questions are pedagogically appropriate, explicitly explain why and add richer oral checks, micro-variants, or extension prompts instead of leaving the lesson thin.

### 5. Design The 40-Minute Class

Use this default structure unless the user gives another duration:

- 0-3 min: build rapport, confirm target, set today's result.
- 3-8 min: diagnostic warm-up or trap question.
- 8-15 min: identify the key bottleneck and why the old path stalls.
- 15-25 min: teach the method and model it.
- 25-33 min: guided practice with student writing or explanation.
- 33-38 min: variant or authentic exam-style validation.
- 38-40 min: summarize the gain and name the next target.

Ensure the student has at least 15 minutes of thinking, writing, or answering time.

### 6. Build The Tablet-Annotation PDF

Create a clean LaTeX Beamer PDF for live annotation. Use formulas, text, TikZ, and programmatic plots precisely. Keep problem pages spacious and separate prompts from reveal pages. Do not add decorative illustrations.

Use image generation only when a problem genuinely requires a complex situational or hard-to-redraw visual. Follow the image boundary and PDF QA rules in [references/math-lesson-core.md](references/math-lesson-core.md).

## Teacher Script

`老师逐字稿.md` must include:

- A no-step-skipping teaching standard: write the script so a teacher who has not learned the topic before can still teach it accurately by reading and following it.
- Micro-step explanations for every derivation, calculation, diagram observation, theorem use, and transition. Do not rely on "显然", "直接可得", "套公式", or unstated mental steps.
- Only in-scope knowledge from the student's current grade, textbook progress, and lesson topic. If a prerequisite is missing, teach it briefly before using it; do not introduce later-grade or unlearned shortcuts unless explicitly approved and marked.
- Class metadata, assumptions, student diagnosis, objective, and the custom lesson ladder.
- A minute-by-minute timeline.
- Natural spoken Chinese under labels such as `老师说`, `学生可能回答`, `追问`, and `板书或批注`.
- For every question: visible `第X题` label when it appears in the classroom PDF, detailed thinking path, full answer, common wrong paths, correction wording, hints from light to explicit, checks for understanding, and where the question appears in the PDF.
- A before-and-after recap.
- Pre-class messages, a group introduction, parent-facing post-class feedback, homework, and follow-up wording.

## Mandatory Conversation Modules

Every `老师逐字稿.md` must include these two spoken modules unless the user explicitly removes them:

- `知识点对话（专业度+真题关联）`: place it near the opening after confirming today's target. State today's exact knowledge point, its appearance in recent or representative 高考/地方卷/模考 questions, and why it matters for scoring. Prefer concrete citations such as `2017年全国I卷第21题` or `2022年新高考I卷第22题`; verify sources during research. If exact frequency cannot be verified, write `近年多次出现（具体频次待检索确认）` rather than inventing a count. Use natural spoken wording in this structure: `今天我们要讲的是[知识点]。它在[试卷范围]中经常以[题型/位置]出现，比如[年份+试卷+题号]。这个知识点重要，是因为[大题核心/小题陷阱/后续模块基础]。掌握好它，你可以在[板块]稳定拿分，并为[后续内容]打基础。`
- `课程总结（结束前2分钟）`: place it in the last two minutes. Make the student see the learning path and preview the next lesson. Include four parts: `学习内容`（具体知识点/题型 and 1-2个核心方法）, `学生表现`（专注度、回答、练习正确率、主要错误、潜力；未上课时用 `[课后填写]`）, `待提升点`（概念理解、步骤规范、速度/熟练度等具体点）, and `后续建议`（正式学习从哪个模块开始, 预计几次课见到明显改善用 `[待确认]` or a conservative range, and personalized plan wording). Do not fabricate real classroom performance before class happens.

## Knowledge Detail File

`知识点详解.md` must include:

- A complete no-jump knowledge explanation that is detailed enough for a teacher who has not learned the topic before to understand and teach it.
- Clear scope boundaries: what this lesson may use, what is not allowed because it is beyond the student's current learning progress, and any `[超纲风险-需确认]` item.
- Topic overview and prerequisite map.
- Complete definitions, notation, formulas, properties, theorem conditions, derivations, and proof ideas.
- Question-type taxonomy and recognition signals.
- Method templates with `适用条件`, `思考路径`, `操作步骤`, `易错点`, `检查方式`, and `迁移方向`.
- Selected examples and authentic exam or mock/simulation questions with detailed solutions and reliable source labels when they are claimed as such. Local, adapted, or self-written questions do not need forced source labels, but must not be falsely labeled as authentic exam questions.
- A `知识点完整性检查` section.

## Post-Class Feedback File

`课后反馈.md` must be a separate user-facing deliverable for trial lessons. Follow any provided feedback template first. If no template is provided, use this structure:

- 学生姓名
- 授课时间
- 授课科目
- 本节课主要学习内容
- 学生课堂表现
- 知识掌握情况
- 课堂问题与改进方向
- 课后作业
- 学习建议
- 家长配合

Write in parent-facing Chinese. For trial lessons, connect the feedback to the visible learning gain, the student's bottleneck, the method learned, homework, and the recommended next-step course direction. Do not fabricate actual classroom performance or parent reactions; if the lesson has not happened yet, mark uncertain behavior as `[课后填写]` or write it as a post-class feedback draft.

Mirror the `课程总结（结束前2分钟）` structure in `课后反馈.md` when no stronger user template is provided: `学习内容`, `学生表现`, `待提升点`, and `后续建议`.

## Tone And Safety

- Encourage without shaming or pressure.
- Keep the conversion goal subordinate to educational value.
- Do not promise score improvements that the lesson cannot establish.
- Do not fabricate sources, scores, conversion status, or parent reactions.

## Quality Gate

Before finishing:

- Confirm all four required deliverables exist, including `课后反馈.md`.
- Confirm the `_work/` internal files exist for substantial jobs: `题目索引.md`, `候选题池.md`, `答案核对表.md`, `课件页码映射.md`, and `内容丰富清单.md`.
- Confirm the two-stage workflow was followed: extraction, candidate pool, answer verification, and visible-gain course skeleton before final PDF/script generation.
- Confirm `老师逐字稿.md` includes `知识点对话（专业度+真题关联）` and `课程总结（结束前2分钟）`.
- Confirm the knowledge-point dialogue uses verified exam citations or explicitly marks unverifiable frequency as `[待检索确认]`.
- Confirm any question called `真题`, `官方考试题`, or `模拟题` has a reliable source; confirm local, adapted, or self-written questions are not mislabeled as authentic exam questions.
- Confirm the 40-60 minute trial lesson has at least diagnostic/trap, model, guided same-type, independent validation, variant or authentic-style, and homework/next-step practice components.
- Confirm the Markdown files contain no fenced code blocks and use `$...$` or `$$...$$` math delimiters.
- Confirm there are no bare LaTeX commands in prose and no formulas wrapped only by ordinary parentheses.
- Confirm `老师逐字稿.md` and `知识点详解.md` contain no skipped reasoning steps, no unexplained formulas or theorem jumps, and no unapproved out-of-scope knowledge.
- Confirm every selected question's final answer and key reasoning have been independently checked; flag unresolved or possibly wrong answers before finalization.
- Compile the classroom PDF with XeLaTeX and confirm it opens.
- Render representative PDF pages and inspect readability, answer reveal order, and writable space.
- Confirm every displayed diagram is mathematically accurate.

## Feishu Finalization

Do not run `lark-cli` from inside this skill. The host web service owns Feishu finalization after the Codex job exits successfully.

After the four local deliverables pass the quality gate, finish with a concise local completion summary. The service will then use the current machine's logged-in `lark-cli --as user` identity to create the course folder under `LY9efBiWjlEAQWdqPrucuLl4nic`, import/upload the four files, create the calendar event when the lesson time is valid, and send the Feishu sync result message.
