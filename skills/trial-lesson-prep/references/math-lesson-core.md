# Math Lesson Core Reference

Use this reference as the controlling shared specification for junior-high and high-school math lesson preparation.

## 1. Deliverables

Create these user-facing files:

1. `老师逐字稿.md`
2. `知识点详解.md`
3. `课堂课件.pdf`
4. `课后反馈.md`

Do not generate a student handout unless the user explicitly asks for one. Keep the classroom PDF concise; keep full reasoning in `老师逐字稿.md` and `知识点详解.md`.

## Sub-Agent Delegation For Large Tasks

For substantial lesson-prep tasks, the main agent must split work across sub-agents before assembling the final files. Use this default division:

1. `题目提取`: extract and index questions from local files, screenshots, library materials, and web exam sources; record internal question IDs, topics, teaching roles, missing figures, and unclear text.
2. `答案核对`: independently solve and verify selected questions; check every formula condition, calculation, diagram relation, and answer form.
3. `课件生成`: create the Beamer classroom PDF from the verified sequence; keep pages student-facing, spacious, and aligned with the teacher script.
4. `逐字稿和内容丰富`: expand the teacher script and content density after verification; add sufficient diagnostic, model, same-type validation, variant, authentic-style, and homework material; write page-by-page teaching language, prompts, likely student responses, correction wording, board notes, and `大招/爽感` moments.

The main agent must integrate the sub-agent outputs, resolve conflicts, and run final QA. Do not use unchecked extracted questions, unverified answers, thin question sets, or outline-only teacher scripts in final deliverables.

## Internal Working Files And Two-Stage Workflow

Create these intermediate files under `_work/` for substantial lesson-prep jobs. They are internal QA artifacts, not user-facing deliverables:

1. `_work/题目索引.md`: extracted local, library, screenshot, and web questions with internal IDs, topics, teaching roles, and missing information.
2. `_work/候选题池.md`: shortlisted and rejected candidates, fit rationale, and whether a question is verified authentic exam, official exam, simulation/mock, local, adapted, or self-written.
3. `_work/答案核对表.md`: independent solutions, final answers, condition checks, diagram checks, and unresolved doubts.
4. `_work/课件页码映射.md`: classroom PDF page numbers mapped to visible `第X题` labels and teacher-script sections.
5. `_work/内容丰富清单.md`: checks for sufficient diagnosis, model, same-type validation, variant/authentic-style, homework, prompts, and common-error coverage.

Run preparation in two internal stages:

1. Stage 1: finish question extraction, candidate pool, answer verification, and visible-gain course skeleton.
2. Stage 2: generate the classroom PDF, write and enrich the teacher script, complete the final four deliverables, and run QA.

Do not start Stage 2 until the selected question sequence has passed answer verification, topic-fit review, visible-gain review, and question-volume review for the class length.

## 2. Local Library And Web Research

Use local and web sources concurrently.

### Local library

Use the configured material library as the stable library root. Determine it from, in order: a user-provided path, `PREP_MATERIAL_ROOT`, `${PREP_WORKSPACE}/资料库`, or the web app workspace's `资料库` directory. The internal directory structure may be deep, mixed, or change over time. Never assume a fixed folder hierarchy.

Run:

    python3 scripts/find_materials.py --root "<资料库路径>" --stage "<初中数学或高中数学>" --grade "<年级>" --keywords "<知识点>,<题型>" --limit 80

On Windows, if Python is unavailable but PowerShell is available, use:

    powershell -ExecutionPolicy Bypass -File scripts/find_materials.ps1 -Root "<资料库路径>" -Stage "<初中数学或高中数学>" -Grade "<年级>" -Keywords "<知识点>,<题型>" -Limit 80

Use the ranked paths as a shortlist. Then extract or read only the promising candidates. Prefer filename and path screening before reading large files. Handle PDF, DOCX, Markdown, text, images, and other common teaching formats with the available document and PDF tooling. For scans or screenshots, use OCR or visual inspection only on shortlisted candidates.

If the root does not exist or contains no useful material, record that status and continue with web research. Do not invent local references.

### Web research

Search authentic exam sources in parallel with the local search. Include 中考 for junior-high lessons and 高考 for high-school lessons. Also search high-quality 一模, 二模, school mock exams, teaching-research PDFs, and textbook-aligned materials when appropriate.

Prioritize:

1. Official exam papers and education authority sources.
2. Teaching-research PDFs and school mock-exam PDFs.
3. Reputable education sites with complete, independently verifiable solutions.
4. Creator explanations only as teaching inspiration after independent verification.

For each selected authentic exam, official exam, or mock/simulation question, record reliable source information:

- Year, region, exam name, paper type, and URL when available.
- Knowledge point, question type, and teaching role.
- Why it fits the current student and custom lesson ladder.
- Whether the wording or figure was preserved, cropped, redrawn, or adapted.

For local, adapted, or self-written questions, do not force a source label, but never call them `真题`, `官方考试题`, or `模拟题` unless that status is verified. If a claimed exam source is uncertain, label it `[来源待核验]`. Never reconstruct a source label from memory.

## 3. Dynamic Difficulty

Do not apply a fixed global set of labels such as `基础 / 中档 / 压轴` or `基础巩固 / 综合提升`.

Create a lesson-specific ladder from:

- Student score and paper difficulty.
- School progress and prerequisite mastery.
- Wrong-answer patterns and recent work.
- Confidence, pace, and class duration.
- The requested lesson result.

For each layer, write:

- Layer name in natural Chinese.
- Why this student needs it.
- Included knowledge and questions.
- Expected observable performance.
- Advance, stop, or fallback condition.

For trial lessons, the ladder must support a visible gain. At least one layer should be framed as a named method or `大招`, with:

- the bottleneck it solves,
- the exact conditions where it applies,
- a before-and-after contrast,
- a same-type validation question,
- the "爽感" moment the student should experience.

## 4. Knowledge Detail Standard

`知识点详解.md` is a teacher-facing preparation file, not a condensed student handout. Include:

- Write at an extremely detailed, no-step-skipping standard. Assume the teacher may not have learned this topic before and must still be able to teach the lesson by following the file line by line.
- Explain every prerequisite, transition, algebraic transformation, theorem condition, diagram reading step, and conclusion. Do not jump from "therefore" to an answer unless the intermediate reason is written.
- Keep the content strictly within the student's current grade, textbook progress, and stated lesson scope. Do not use out-of-scope or later-grade knowledge unless the user explicitly approves it, and label any necessary extension as `[超纲风险-需确认]`.
- When a method depends on earlier knowledge, write the earlier knowledge first, then show exactly how it is used in the current problem.
- Prerequisites and links to earlier knowledge.
- Definitions, notation, formulas, properties, theorem conditions, and scope limits.
- Derivations, proof ideas, intuitive explanations, and multiple representations when useful.
- A question-type taxonomy with recognition signals.
- Method templates with conditions, thought process, steps, checks, and migration patterns.
- Common misconceptions, typical wrong paths, correction language, and later-topic links.
- Selected examples and authentic exam or mock/simulation questions with detailed solutions and reliable source labels when they are claimed as such. Local, adapted, or self-written questions do not need forced source labels, but must not be falsely labeled as authentic exam questions.
- A final `知识点完整性检查`.

## 4A. Content Richness Standard

The final lesson must contain enough mathematical work for the requested class length and visible-gain design. Do not stop at a few examples and a short outline.

- For a 40-60 minute trial lesson, include at minimum a diagnostic/trap question, one model question, one guided same-type question, one independent validation question, one variant or authentic exam-style question, and homework or next-step practice.
- If local user-provided questions are few, supplement with same-type variants, prerequisite bridge questions, authentic exam-style extensions, and homework while keeping the local questions as the main spine.
- Each question should have a clear teaching role and should either diagnose, expose the bottleneck, model the method, let the student prove the gain, extend, or assign post-class work.
- `老师逐字稿.md` must be page-by-page and question-by-question, not a compressed solution bank. Include teacher wording, exact prompts, expected student responses, common mistakes, correction wording, board or annotation notes, visible-gain transitions, and parent-facing summary cues.
- If the lesson intentionally uses fewer questions, state the pedagogical reason and compensate with richer micro-variants, oral checks, and deeper explanation.

## 5. Per-Question Teacher Standard

For every question used in class or homework, include enough detail for the teacher to teach from the file:

1. `题目与来源状态`
2. `本题教学用途`
3. `适配理由`
4. `前置知识`
5. `识别信号`
6. `第一反应与思考路径`
7. `完整解答`
8. `验算或合理性检查`
9. `可选解法与取舍`
10. `常见错误路径`
11. `分层提示`
12. `追问与变式`
13. `课件页码`

Verify every calculation, proof, condition, and diagram independently. Do not include a shortcut without stating when it works and when it fails.

Use a strict no-jump explanation standard in `老师逐字稿.md`:

- The teacher script must be detailed enough that a teacher who has not previously studied the topic can still deliver it accurately.
- For each question, break the solution into observable micro-steps: what to look at first, what information to mark, which prior fact is being used, why the next operation is allowed, what to write on the board, and what the student should say or do.
- Do not use unintroduced formulas, theorems, tactics, or later-grade methods. If an efficient shortcut is beyond the student's current scope, replace it with an in-scope method or explicitly mark it as not for this lesson.
- Every transition in spoken wording and every transformation in the solution must have a reason. Avoid vague jumps such as "显然", "容易得到", "直接可得", or "套公式" unless the missing reasoning is immediately written out.
- If the student has not learned a prerequisite, insert a short teachable prerequisite block before using it, with teacher wording and a one-step check question.

For questions that appear in the classroom PDF, place the full teacher script and detailed solution at the corresponding PDF page/question section, not only in an end-of-file solution bank. Add an alignment map near the start of `老师逐字稿.md` in the form `课堂PDF页码 -> 第X题 -> 教学环节`.

## 6. Classroom PDF Standard

Generate `课堂课件.pdf` from LaTeX Beamer for tablet annotation.

Start from `assets/tablet-beamer-template.tex`. Copy it into the lesson working directory, replace the sample frames, and keep the `\writingspace` macro for annotation pages.

### Layout

- Use a clean 16:9 Beamer layout and Chinese-capable XeLaTeX compilation.
- Prefer large readable text, restrained color, and plain mathematical structure.
- Leave substantial writable space on problem, discussion, and guided-practice pages.
- Aim for roughly 40-60% writable blank area on pages where the student or teacher should write.
- Keep one main teaching action per page.
- Put detailed derivations in the Markdown files, not on the initial problem page.
- For local PDF questions, use student-facing labels such as `第X题` on the classroom PDF. Keep local page/question-number mappings in `_work/题目索引.md` or `_work/课件页码映射.md` when useful; do not force local source details into final user-facing files.

### Reveal rhythm

Use separate PDF pages for stable annotation:

1. Knowledge prompt or question page with writable space.
2. Optional light-hint page.
3. Method or key-step reveal page.
4. Concise answer recap page when needed.

Do not reveal the answer on the same page as the first attempt. Duplicate a frame when necessary rather than relying on fragile interactive behavior.

### Accurate visuals

Use deterministic rendering first:

- Geometry diagrams: TikZ or another precise programmatic drawing method.
- Function plots and coordinate systems: TikZ, pgfplots, or a programmatic plot.
- Statistical charts and tables: LaTeX or programmatic drawing.
- Existing source figures: preserve or crop when legible and permitted.

Use image generation only for a genuinely necessary complex situational image, spatial illustration, or hard-to-redraw problem visual. When it is needed, follow the installed `imagegen` skill and use the built-in image generation tool by default. Do not generate decorative images. Do not ask an image model to draw exact geometry, axes, measurements, formulas, or answer text. Validate every generated image before embedding it and mark it as a generated illustration in the teacher script.

### Build and QA

- Compile with XeLaTeX, usually twice.
- Confirm the PDF exists, is non-empty, and opens.
- Check page count with PDF tooling.
- Render representative pages to images and inspect them.
- Verify font readability, blank writing areas, reveal order, clipping, and diagram accuracy.
- Confirm the `第X题` labels in `课堂课件.pdf` match the page/question alignment map in `老师逐字稿.md`.

## 6A. Final QA Priorities

Before finalization, prioritize these checks:

- No skipped teaching steps in `老师逐字稿.md` or `知识点详解.md`.
- A 40-60 minute trial lesson has at least diagnostic/trap, model, guided same-type, independent validation, variant or authentic-style, and homework/next-step practice components.
- Every selected question has independently checked final answers and key reasoning; unresolved or possibly wrong answers are flagged before delivery.
- Any question called `真题`, `官方考试题`, or `模拟题` has reliable source information. Local, adapted, or self-written questions are not mislabeled as authentic exam questions.
- Local PDF or screenshot questions can be the lesson spine, but final user-facing files only need classroom page and visible `第X题` alignment, not local source/page/question-number mapping.

## 7. Post-Class Feedback Standard

Generate `课后反馈.md` as a separate deliverable for every trial lesson. If the user provides a Word/PDF/template file, extract its sections and follow that template. Default sections are:

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

Use concise parent-facing Chinese. For trial lessons, emphasize the diagnostic finding, visible before-and-after learning gain, student strengths, remaining bottleneck, homework, and recommended next-step learning plan. Do not invent actual classroom performance before class; use `[课后填写]` or draft wording when behavior is unknown.

## 8. Markdown Standard

For generated Markdown deliverables:

- Do not use fenced code blocks.
- Use `$...$` for inline formulas and `$$...$$` for display formulas so the web viewer can render them reliably.
- Convert any sourced `\( ... \)` or `\[ ... \]` formulas to `$...$` or `$$...$$` before writing final Markdown.
- Do not write LaTeX formulas inside ordinary parentheses, such as `(\vec{a}=(2,-1))`.
- Do not leave bare LaTeX commands in prose, such as `求 \vec{a}\cdot\vec{b}`; write `求 $\vec{a}\cdot\vec{b}$`.
- Prefer braced vector notation, such as `\vec{a}` and `\vec{b}`.
- Prefer source links for questions claimed as authentic exam, official exam, or mock/simulation questions.
- Mark missing information as `[待确认]`, `[待检索]`, or `[来源待核验]`.
