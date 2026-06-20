---
name: formal-lesson-prep
description: Prepare systematic one-on-one junior-high or high-school math formal lessons from student information, a recursive local material library, and verified web exam-question research. Use when the user says 正式课, 常规课, 长期课, 正式学生, 备正式课, 初中数学, 高中数学, 课时设计, 同步课, 专题课, 错题复盘, 真题搜索, 知识点详解, 老师逐字稿, LaTeX课件, Beamer课件, or asks for a classroom PDF with writable tablet space and detailed teacher solutions.
---

# Formal Lesson Prep

## Core Rule

Prepare a systematic formal math lesson for long-term score improvement. Use Chinese unless the user asks otherwise. If information is missing, still create a usable draft with `[待确认]` placeholders and a short `课前需确认` section.

Read [references/math-lesson-core.md](references/math-lesson-core.md) first. Its output, source-reliability, difficulty, solution, and PDF rules are mandatory. Read [references/formal-course-flow.md](references/formal-course-flow.md) when designing the long-term lesson sequence.

## Sub-Agent Delegation Rule

Large lesson-prep tasks must use sub-agent division of labor before final deliverables are assembled. For formal lessons, use these default workstreams:

1. `题目提取`: extract questions from user-provided local files, library candidates, screenshots, and web exam sources; build an internal question index and identify missing figures or unclear text.
2. `答案核对`: independently solve and verify every selected question, checking conditions, calculations, diagrams, and answer forms.
3. `课件生成`: build the Beamer classroom PDF from the verified question sequence, keeping it student-facing and aligned with the teacher script.
4. `逐字稿和内容丰富`: expand the lesson content and teacher script after the verified question sequence is set; add enough diagnostic, model, variant, consolidation, and homework questions; write page-by-page teaching language, follow-up prompts, likely student responses, correction wording, and board notes.

The main agent owns task decomposition, integration, conflict resolution, and the final quality gate. Do not skip `答案核对`, question-volume expansion, or teacher-script enrichment on substantial courses.

## Internal Working Files

Create intermediate working files in `_work/` for substantial lesson-prep jobs. These files are internal QA artifacts and are not user-facing deliverables:

1. `_work/题目索引.md`: extracted local, library, screenshot, and web questions with internal IDs, topics, teaching roles, and missing information.
2. `_work/候选题池.md`: shortlisted and rejected candidates, fit rationale, and whether a question is verified authentic exam, official exam, simulation/mock, local, adapted, or self-written.
3. `_work/答案核对表.md`: independent solutions, final answers, condition checks, diagram checks, and unresolved doubts.
4. `_work/课件页码映射.md`: classroom PDF page numbers mapped to the visible `第X题` labels and teacher-script sections.
5. `_work/内容丰富清单.md`: checks for sufficient diagnostic, model, guided practice, variants, consolidation, homework, prompts, and common-error coverage.

Do not require these working files to be uploaded or emphasized in the final user-facing materials unless the user asks.

## Two-Stage Internal Workflow

Run lesson preparation in two internal stages:

1. Stage 1: complete question extraction, `_work/题目索引.md`, `_work/候选题池.md`, `_work/答案核对表.md`, and the course skeleton before drafting final materials.
2. Stage 2: generate the Beamer classroom PDF, write the teacher script, enrich the content, complete the final four deliverables, and run the quality gate.

Do not enter Stage 2 until the selected question sequence has been checked for answer correctness, topic fit, and enough question volume for the requested class length.

## Local PDF Question Rule

When the user provides a local PDF, screenshot set, DOCX, or other document that contains class questions, treat those questions as the primary lesson skeleton. Extract and inspect the local file first, preserve its question order unless there is a clear teaching reason to reorder, and keep any page/question-number mapping in `_work/题目索引.md` or `_work/课件页码映射.md` for internal use. Local materials, library content, and web exam questions may supplement, scaffold, or extend the class, but they must not displace the provided local questions without a teaching reason.

The classroom PDF and `老师逐字稿.md` must be paired:

- Every classroom PDF problem page must show the question number in the simple student-facing form `第X题`, not `本地PDF第X题`.
- `老师逐字稿.md` must follow the classroom PDF sequence and include the detailed solution, teaching wording, likely student responses, correction wording, hints, and checks at the corresponding classroom page/question location.
- The teacher script only needs to align to classroom PDF page numbers and visible `第X题` labels; it does not need to emphasize local PDF sources, local page numbers, or original local question-number mappings.
- Do not leave detailed solutions only in a separate appendix if the corresponding PDF page appears earlier in class; the teacher must be able to teach page-by-page from the script.

## Required Outputs

Create exactly these user-facing deliverables unless the user asks otherwise:

1. `老师逐字稿.md`
2. `知识点详解.md`
3. `课堂课件.pdf`
4. `课后反馈.md`

Do not create a student handout by default. Treat generated `.tex`, rendered page images, extracted material text, and generated question-image assets as working files rather than additional deliverables.

## Classroom PDF Answer Rule

Keep `课堂课件.pdf` student-facing. Do not put final answers, full solutions, or answer-key pages in the classroom PDF unless the user explicitly asks for answer reveals. Put answers, detailed solutions, correction wording, and verification notes in `老师逐字稿.md` and `知识点详解.md` instead.

## Inputs To Collect Or Infer

Identify:

- Student name, junior-high or high-school stage, grade, province or paper region, textbook version, school progress, and class length.
- Lesson type: 同步巩固, 专题提升, 错题复盘, 培优拓展, 考前冲刺, or 作业答疑.
- Exact knowledge point and scope.
- Recent score, school difficulty, current mistakes, recent paper, answer sheet, homework, or screenshots.
- The observable result the student should achieve by the end of class.

If only a topic is provided, assume a 90-minute one-on-one formal lesson and mark missing details as `[待确认]`.

## Workflow

### 1. Define A Student-Specific Target

Set one main objective and a custom lesson ladder. Do not force the student into a fixed three-level or four-level taxonomy. Name each layer for this student, explain why it exists, connect it to selected questions, and state the condition for advancing or stopping.

### 2. Run Dual-Track Research

Research local materials and web exam questions in parallel:

- Determine the local material root from, in order: a user-provided path, `PREP_MATERIAL_ROOT`, `${PREP_WORKSPACE}/资料库`, or the web app workspace's `资料库` directory.
- Prefer the cross-platform helper:
  `python3 scripts/find_materials.py --root "<资料库路径>" --stage "<初中数学或高中数学>" --grade "<年级>" --keywords "<知识点>,<题型>" --limit 80`
- On Windows, if Python is unavailable but PowerShell is available, use:
  `powershell -ExecutionPolicy Bypass -File scripts/find_materials.ps1 -Root "<资料库路径>" -Stage "<初中数学或高中数学>" -Grade "<年级>" -Keywords "<知识点>,<题型>" -Limit 80`
- Recursively search regardless of directory depth. Use path matches to shortlist files, then inspect only relevant candidates.
- Search verified web sources for localized 中考, 高考, school mock-exam, and teaching-research questions.
- Treat authentic exam questions as a core source, not as a fallback.
- If the user provided a local PDF/question document, extract its questions before selecting outside examples, and use those local questions as the default in-class sequence.

Record selected materials and rejected candidates briefly in `_work/候选题池.md` so the internal selection process is traceable.

### 3. Build The Detailed Knowledge Map

Cover prerequisites, definitions, notation, formulas, theorem conditions, derivations or proof ideas, question-type signals, method templates, common wrong paths, correction language, later-topic connections, and scoring points.

Write the full map to `知识点详解.md`. Keep it teacher-facing and detailed enough to support future lesson preparation.

### 4. Select And Verify Questions

Build a cumulative sequence such as diagnostic -> model example -> guided practice -> independent variant -> homework. Adapt the sequence to the student-specific ladder.

The question set must be rich enough for the requested class length. For a standard 90-minute formal lesson, include complete question groups or micro-question groups plus homework: diagnostic questions, model examples, guided practice, independent variants, consolidation checks, and post-class homework. If fewer questions are pedagogically appropriate, explicitly explain why and add richer variants, oral checks, or extension prompts instead of leaving the lesson thin.

For every used question:

- Verify the mathematics independently.
- Record teaching role, fit, recognition signals, solution plan, full solution, checks, alternative routes when useful, common wrong paths, and a hint ladder.
- For authentic exam, official exam, and mock/simulation questions, verify and record reliable source information. For local, adapted, or self-written questions, do not force a source label, but never present them as authentic exam questions unless that status is verified.
- Include detailed reasoning in `老师逐字稿.md`, not only a final answer.
- Expand each selected question into teachable content: setup, first observation, micro-step solution, teacher prompts, expected student responses, common wrong turns, correction wording, and a short transfer or variant.
- If the question came from a local PDF or document, keep its original mapping internally when useful, but the classroom PDF should display only the lesson sequence label `第X题`.

### 5. Design The Class

Use this 90-minute structure by default; scale proportionally:

- 0-5 min: confirm progress and target.
- 5-15 min: diagnostic warm-up or wrong-question recap.
- 15-35 min: teach prerequisites and core knowledge.
- 35-55 min: model method templates with standard and authentic exam examples.
- 55-70 min: guided practice with student writing or explanation.
- 70-82 min: independent practice or variant.
- 82-88 min: summarize the knowledge map, method, traps, and scoring language.
- 88-90 min: assign homework and connect the next lesson.

Keep at least one third of class time for student thinking, writing, or explaining.

### 6. Build The Tablet-Annotation PDF

Create a clean LaTeX Beamer PDF for live annotation. Use formulas, text, TikZ, and programmatic plots precisely. Keep problem pages spacious and separate prompts from reveal pages. Do not add decorative illustrations.

Use image generation only when a problem genuinely requires a complex situational or hard-to-redraw visual. Follow the image boundary and PDF QA rules in [references/math-lesson-core.md](references/math-lesson-core.md).

## Teacher Script

`老师逐字稿.md` must include:

- A no-step-skipping teaching standard: write the script so a teacher who has not learned the topic before can still teach it accurately by reading and following it.
- Micro-step explanations for every derivation, calculation, diagram observation, theorem use, and transition. Do not rely on "显然", "直接可得", "套公式", or unstated mental steps.
- Only in-scope knowledge from the student's current grade, textbook progress, and lesson topic. If a prerequisite is missing, teach it briefly before using it; do not introduce later-grade or unlearned shortcuts unless explicitly approved and marked.
- Class metadata, assumptions, objective, and preparation.
- The custom lesson ladder and why it fits the student.
- A minute-by-minute timeline.
- A PDF-script alignment map showing classroom PDF page numbers, visible `第X题` labels, and teaching roles.
- Natural spoken Chinese under labels such as `老师说`, `学生可能回答`, `追问`, and `板书或批注`.
- For every PDF question page: the visible `第X题` label, detailed thinking path, full answer, common wrong paths, correction wording, hints from light to explicit, checks for understanding, and exact classroom PDF page number.
- Closing summary, homework, and next-lesson connection.

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

`课后反馈.md` must be a separate user-facing deliverable. Follow any provided feedback template first. If no template is provided, use this structure:

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

Write it in parent-facing Chinese, concise and specific. Mention the actual lesson topic, core question types, observable strengths, current weak points, assigned homework, and next-step advice. Do not fabricate in-class behavior; when the actual lesson has not happened yet, phrase feedback as a post-class draft or mark uncertain behavior as `[课后填写]`.

Mirror the `课程总结（结束前2分钟）` structure in `课后反馈.md` when no stronger user template is provided: `学习内容`, `学生表现`, `待提升点`, and `后续建议`.

## Quality Gate

Before finishing:

- Confirm all four required deliverables exist, including `课后反馈.md`.
- Confirm the `_work/` internal files exist for substantial jobs: `题目索引.md`, `候选题池.md`, `答案核对表.md`, `课件页码映射.md`, and `内容丰富清单.md`.
- Confirm the two-stage workflow was followed: extraction, candidate pool, answer verification, and course skeleton before final PDF/script generation.
- If a local question PDF/document was provided, confirm the classroom PDF problem pages display only simple `第X题` labels and the teacher script aligns page-by-page to classroom page numbers and visible question labels.
- Confirm `老师逐字稿.md` includes `知识点对话（专业度+真题关联）` and `课程总结（结束前2分钟）`.
- Confirm the knowledge-point dialogue uses verified exam citations or explicitly marks unverifiable frequency as `[待检索确认]`.
- Confirm any question called `真题`, `官方考试题`, or `模拟题` has a reliable source; confirm local, adapted, or self-written questions are not mislabeled as authentic exam questions.
- Confirm the formal 90-minute lesson has enough complete question groups or micro-question groups, including diagnostic, model, guided practice, independent variant, consolidation, and homework work.
- Confirm the Markdown files contain no fenced code blocks and use `$...$` or `$$...$$` math delimiters.
- Confirm there are no bare LaTeX commands in prose and no formulas wrapped only by ordinary parentheses.
- Confirm `老师逐字稿.md` and `知识点详解.md` contain no skipped reasoning steps, no unexplained formulas or theorem jumps, and no unapproved out-of-scope knowledge.
- Confirm every selected question's final answer and key reasoning have been independently checked; flag unresolved or possibly wrong answers before finalization.
- Compile the classroom PDF with XeLaTeX and confirm it opens.
- Render representative PDF pages and inspect readability, answer reveal order, and writable space.
- Confirm every displayed diagram is mathematically accurate.
- Do not fabricate sources, scores, student reactions, or authentic-exam status.

## Feishu Finalization

Do not run `lark-cli` from inside this skill. The host web service owns Feishu finalization after the Codex job exits successfully.

After the four local deliverables pass the quality gate, finish with a concise local completion summary. The service will then use the current machine's logged-in `lark-cli --as user` identity to create the course folder under `LY9efBiWjlEAQWdqPrucuLl4nic`, import/upload the four files, create the calendar event when the lesson time is valid, and send the Feishu sync result message.
