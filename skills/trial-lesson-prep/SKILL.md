---
name: trial-lesson-prep
description: Prepare structured one-on-one junior-high or high-school math trial lessons from student information, a recursive local material library, and verified web exam-question research. Use whenever the user mentions 试听课, 体验课, 试讲, 试听备课, 试听课流程, 试听课反馈, 转化, 家长沟通, 初中数学, 高中数学, 中考真题, 高考真题, 省市题, 搜题, 大招, 解题技巧, 知识点详解, 老师逐字稿, LaTeX课件, Beamer课件, or asks for a classroom PDF with writable tablet space and detailed teacher solutions.
---

# Trial Lesson Prep

## Core Rule

Prepare a trial math lesson that creates a visible and honest learning gain while remaining educationally useful. Use Chinese unless the user asks otherwise. If information is missing, still create a usable draft with `[待确认]` placeholders and a short `课前需确认` section.

Read [references/math-lesson-core.md](references/math-lesson-core.md) first. Its output, source, difficulty, solution, and PDF rules are mandatory. Read [references/class-questions-flow.md](references/class-questions-flow.md) for operational communication and follow-up details.

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

If a local PDF/question document is provided, use it as the primary lesson spine. Classroom PDF problem pages should show student-facing labels like `第7题`, while `老师逐字稿.md` keeps the local source mapping and detailed teaching script.

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
- Record source, teaching role, fit, recognition signals, solution plan, full solution, checks, alternative routes when useful, common wrong paths, and a hint ladder.
- Include detailed reasoning in `老师逐字稿.md`, not only a final answer.

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
- For every question: detailed thinking path, full answer, common wrong paths, correction wording, hints from light to explicit, checks for understanding, and where the question appears in the PDF.
- A before-and-after recap.
- Pre-class messages, a group introduction, parent-facing post-class feedback, homework, and follow-up wording.

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

## Tone And Safety

- Encourage without shaming or pressure.
- Keep the conversion goal subordinate to educational value.
- Do not promise score improvements that the lesson cannot establish.
- Do not fabricate sources, scores, conversion status, or parent reactions.

## Quality Gate

Before finishing:

- Confirm all four required deliverables exist, including `课后反馈.md`.
- Confirm the Markdown files contain no fenced code blocks and use `$...$` or `$$...$$` math delimiters.
- Confirm there are no bare LaTeX commands in prose and no formulas wrapped only by ordinary parentheses.
- Confirm `老师逐字稿.md` and `知识点详解.md` contain no skipped reasoning steps, no unexplained formulas or theorem jumps, and no unapproved out-of-scope knowledge.
- Compile the classroom PDF with XeLaTeX and confirm it opens.
- Render representative PDF pages and inspect readability, answer reveal order, and writable space.
- Confirm every displayed diagram is mathematically accurate.
