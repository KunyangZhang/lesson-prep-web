---
name: formal-lesson-prep
description: Prepare systematic one-on-one junior-high or high-school math formal lessons from student information, a recursive local material library, and verified web exam-question research. Use when the user says 正式课, 常规课, 长期课, 正式学生, 备正式课, 初中数学, 高中数学, 课时设计, 同步课, 专题课, 错题复盘, 真题搜索, 知识点详解, 老师逐字稿, LaTeX课件, Beamer课件, or asks for a classroom PDF with writable tablet space and detailed teacher solutions.
---

# Formal Lesson Prep

## Core Rule

Prepare a systematic formal math lesson for long-term score improvement. Use Chinese unless the user asks otherwise. If information is missing, still create a usable draft with `[待确认]` placeholders and a short `课前需确认` section.

Read [references/math-lesson-core.md](references/math-lesson-core.md) first. Its output, source, difficulty, solution, and PDF rules are mandatory. Read [references/formal-course-flow.md](references/formal-course-flow.md) when designing the long-term lesson sequence.

## Local PDF Question Rule

When the user provides a local PDF or document that contains class questions, treat those questions as the primary lesson skeleton. Extract and inspect the local file first, preserve its question order unless there is a clear teaching reason to reorder, and label every used question internally by its local source number. Local materials, library content, and web exam questions may supplement, scaffold, or extend the class, but they must not displace the provided PDF questions without stating why.

The classroom PDF and `老师逐字稿.md` must be paired:

- Every classroom PDF problem page must show the question number in the simple student-facing form `第X题`, not `本地PDF第X题`.
- `老师逐字稿.md` must follow the classroom PDF sequence and include the detailed solution, teaching wording, likely student responses, correction wording, hints, and checks at the corresponding PDF page/question location.
- Keep a trace map in the teacher script: `课堂PDF页码 -> 本地PDF题号 -> 教学环节`.
- Do not leave detailed solutions only in a separate appendix if the corresponding PDF page appears earlier in class; the teacher must be able to teach page-by-page from the script.

## Required Outputs

Create exactly these user-facing deliverables unless the user asks otherwise:

1. `老师逐字稿.md`
2. `知识点详解.md`
3. `课堂课件.pdf`
4. `课后反馈.md`

Do not create a student handout by default. Treat generated `.tex`, rendered page images, extracted material text, and generated question-image assets as working files rather than additional deliverables.

## Classroom PDF Answer Rule

Keep `课堂课件.pdf` student-facing. Do not put final answers, full solutions, or answer-key pages in the classroom PDF unless the user explicitly asks for answer reveals. Put answers, detailed solutions, correction wording, and source provenance in `老师逐字稿.md` and `知识点详解.md` instead.

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

Record selected materials and rejected candidates briefly so the final lesson is traceable.

### 3. Build The Detailed Knowledge Map

Cover prerequisites, definitions, notation, formulas, theorem conditions, derivations or proof ideas, question-type signals, method templates, common wrong paths, correction language, later-topic connections, and scoring points.

Write the full map to `知识点详解.md`. Keep it teacher-facing and detailed enough to support future lesson preparation.

### 4. Select And Verify Questions

Build a cumulative sequence such as diagnostic -> model example -> guided practice -> independent variant -> homework. Adapt the sequence to the student-specific ladder.

For every used question:

- Verify the mathematics independently.
- Record source, teaching role, fit, recognition signals, solution plan, full solution, checks, alternative routes when useful, common wrong paths, and a hint ladder.
- Include detailed reasoning in `老师逐字稿.md`, not only a final answer.
- If the question came from a local PDF, record its exact local question number and make the classroom PDF display that number.
- In the classroom PDF, display only `第X题`; keep full source/provenance such as `本地PDF第X题` in the teacher script and knowledge detail file.

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
- A PDF-script alignment map showing classroom PDF page numbers, local PDF question numbers, and teaching roles.
- Natural spoken Chinese under labels such as `老师说`, `学生可能回答`, `追问`, and `板书或批注`.
- For every PDF question page: the matching local PDF question number, detailed thinking path, full answer, common wrong paths, correction wording, hints from light to explicit, checks for understanding, and exact classroom PDF page number.
- Closing summary, homework, and next-lesson connection.

## Knowledge Detail File

`知识点详解.md` must include:

- A complete no-jump knowledge explanation that is detailed enough for a teacher who has not learned the topic before to understand and teach it.
- Clear scope boundaries: what this lesson may use, what is not allowed because it is beyond the student's current learning progress, and any `[超纲风险-需确认]` item.
- Topic overview and prerequisite map.
- Complete definitions, notation, formulas, properties, theorem conditions, derivations, and proof ideas.
- Question-type taxonomy and recognition signals.
- Method templates with `适用条件`, `思考路径`, `操作步骤`, `易错点`, `检查方式`, and `迁移方向`.
- Selected examples and authentic exam questions with detailed solutions and source labels.
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

## Quality Gate

Before finishing:

- Confirm all four required deliverables exist, including `课后反馈.md`.
- If a local question PDF/document was provided, confirm the classroom PDF problem pages display `第X题` labels and the teacher script has a page-by-page source alignment map.
- Confirm the Markdown files contain no fenced code blocks and use `$...$` or `$$...$$` math delimiters.
- Confirm there are no bare LaTeX commands in prose and no formulas wrapped only by ordinary parentheses.
- Confirm `老师逐字稿.md` and `知识点详解.md` contain no skipped reasoning steps, no unexplained formulas or theorem jumps, and no unapproved out-of-scope knowledge.
- Compile the classroom PDF with XeLaTeX and confirm it opens.
- Render representative PDF pages and inspect readability, answer reveal order, and writable space.
- Confirm every displayed diagram is mathematically accurate.
- Do not fabricate sources, scores, student reactions, or question provenance.

## Feishu Finalization

Do not run `lark-cli` from inside this skill. The host web service owns Feishu finalization after the Codex job exits successfully.

After the four local deliverables pass the quality gate, finish with a concise local completion summary. The service will then use the current machine's logged-in `lark-cli --as user` identity to create the course folder under `LY9efBiWjlEAQWdqPrucuLl4nic`, import/upload the four files, create the calendar event when the lesson time is valid, and send the Feishu sync result message.
