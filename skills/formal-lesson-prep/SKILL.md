---
name: formal-lesson-prep
description: Prepare systematic one-on-one junior-high or high-school math formal lessons, including classroom materials and post-class homework, from student information, the latest same-student lesson, OCR/local materials, a recursive material library, and verified web exam-question research. Use when the user says 正式课, 常规课, 长期课, 正式学生, 备正式课, 初中数学, 高中数学, 课时设计, 同步课, 专题课, 错题复盘, 课后作业, 留作业, 真题搜索, 知识点详解, 老师逐字稿, LaTeX课件, Beamer课件, or asks for classroom/homework PDFs with writable space and detailed teacher solutions.
---

# Formal Lesson Prep

## Core Rule

Prepare a systematic formal math lesson for long-term score improvement. Use Chinese unless the user asks otherwise. If information is missing, still create a usable draft with `[待确认]` placeholders and a short `课前需确认` section.

Read [references/math-lesson-core.md](references/math-lesson-core.md) first. Its output, source-reliability, difficulty, solution, and PDF rules are mandatory. Read [references/formal-course-flow.md](references/formal-course-flow.md) when designing the long-term lesson sequence.

## Sub-Agent Delegation Rule

Large lesson-prep tasks must use sub-agent division of labor before final deliverables are assembled. For formal lessons, use these default workstreams:

1. `题目提取`: extract questions from user-provided local files, library candidates, screenshots, and web exam sources; build an internal question index and identify missing figures or unclear text.
2. `答案核对`: independently solve and verify every selected question, checking conditions, calculations, diagrams, and answer forms.
3. `课件生成`: build both A4 portrait PDFs from the same verified question sequence: the original answer-hidden student classroom handout and the teacher-facing all-in-one teaching PDF. Keep question labels, order, and figures consistent across both PDFs.
4. `逐字稿和内容丰富`: expand the lesson content and teacher script after the verified question sequence is set; add enough diagnostic, model, variant, consolidation, and homework questions; write page-by-page teaching language, follow-up prompts, likely student responses, correction wording, and board notes. Also select and verify the default four-question post-class set from the latest lesson content and OCR/local materials.

The main agent owns task decomposition, integration, conflict resolution, and the final quality gate. Do not skip `答案核对`, question-volume expansion, or teacher-script enrichment on substantial courses.

## Internal Working Files

Create intermediate working files in `_work/` for substantial lesson-prep jobs. These files are internal QA artifacts and are not user-facing deliverables:

1. `_work/连续学习档案.md`: same-student lesson history summary, previous unresolved points, this lesson's bridge, old-knowledge retrieval plan, and next-lesson handoff.
2. `_work/题目索引.md`: extracted local, library, screenshot, and web questions with internal IDs, topics, teaching roles, and missing information.
3. `_work/候选题池.md`: shortlisted and rejected candidates, fit rationale, and whether a question is verified authentic exam, official exam, simulation/mock, local, adapted, or self-written.
4. `_work/答案核对表.md`: independent solutions, final answers, condition checks, diagram checks, and unresolved doubts.
5. `_work/课件页码映射.md`: student classroom PDF page numbers mapped to visible `第X题` labels.
6. `_work/授课一体版页码映射.md`: all-in-one PDF modules mapped to visible `第X题` labels and their three content blocks.
7. `_work/内容丰富清单.md`: checks for sufficient diagnostic, model, guided practice, variants, consolidation, homework, prompts, and common-error coverage.

Do not require these working files to be uploaded or emphasized in the final user-facing materials unless the user asks.

## Two-Stage Internal Workflow

Run lesson preparation in two internal stages:

1. Stage 1: complete the continuity file, question extraction, `_work/题目索引.md`, `_work/候选题池.md`, `_work/答案核对表.md`, and the course skeleton before drafting final materials.
2. Stage 2: generate both A4 portrait PDFs, write the teacher script, enrich the content, complete the five final deliverables, and run the quality gate.

Do not enter Stage 2 until the selected question sequence has been checked for answer correctness, topic fit, and enough question volume for the requested class length.

## Local PDF Question Rule

When the user provides a local PDF, screenshot set, DOCX, or other document that contains class questions, treat those questions as the primary lesson skeleton. Extract and inspect the local file first, preserve its question order unless there is a clear teaching reason to reorder, and keep any page/question-number mapping in `_work/题目索引.md` or `_work/课件页码映射.md` for internal use. Local materials, library content, and web exam questions may supplement, scaffold, or extend the class, but they must not displace the provided local questions without a teaching reason.

### User-Specified Scope And Quantity Are Hard Requirements

Explicit user instructions about question count, question-type coverage, source-document coverage, scope, and order are hard requirements. They take priority over class duration, default lesson pacing, student-history recommendations, pedagogical preferences, and AI-inferred sequencing.

- A PDF or question set does not have to fit into one class. It may be prepared as material for multiple lessons. Class duration may shape the suggested teaching timeline, but it must never be used to delete, defer, conditionally include, or silently omit user-requested questions or question types.
- If the user says `每个题型一道题`, first extract the complete question-type taxonomy from every specified document, then place at least one actual, fully stated, independently verified question from every identified type into the unified selected question sequence and both PDFs. Listing a type only in an index, candidate pool, future roadmap, optional extension, or conditional homework does not satisfy the request.
- If the user specifies an exact number, produce that number in the requested deliverable. Do not replace it with a smaller "pedagogically appropriate" set. Additional scaffolding or homework may be added when useful, but it must not replace the requested items.
- Do not rewrite an explicit quantity request into `按前测筛选`, `时间允许再进入`, `分课后再选`, or similar conditional coverage unless the user explicitly asks for prioritization or reduction. If the material exceeds one lesson, include all requested material and separately mark a suggested multi-lesson teaching split.
- If a requested source item is unreadable or mathematically incomplete, keep its slot visible as `[需人工确认]`, explain the exact issue, and use a clearly labeled same-type substitute when possible. Never silently reduce the count.

If PaddleOCR or the source extraction has already produced a legible original figure for a question, reuse that original figure directly (or crop it without changing the mathematical content). Do not redraw an existing usable source figure. Redraw only when the original figure is missing, illegible, mathematically inconsistent, or the user explicitly asks for a new drawing; record the reason in `_work/课件生成计划.md` or `_work/答案核对表.md`.

Both PDFs use the same verified question sequence. The original classroom PDF remains a student-facing answer-hidden handout. The all-in-one teaching PDF is the primary document the teacher opens during class. `老师逐字稿.md` and `知识点详解.md` remain required structured source files for search, continuity, editing, and post-class reuse, but the teacher must not need to switch to them while teaching.

- Every problem must show the simple label `第X题`, not `本地PDF第X题`.
- In the all-in-one teaching PDF, organize each question module in exactly three visible parts: `1. 知识点具体内容与完整推导 -> 2. 题目与必要图形 -> 3. 详细不跳步解答`.
- Put the relevant knowledge immediately before its corresponding question. Do not place all knowledge pages at the front and all questions/solutions later.
- Treat `知识点详解.md` as the content-complete source, not as an outline. The all-in-one PDF must preserve every mathematically relevant definition, condition, derived conclusion, derivation step, reason, failure boundary, intermediate equation, operation reason, and answer check needed for the selected questions. Reorganizing for page flow is allowed; summarizing away those details is not.
- Every question module must be self-contained at the point of use. Do not write `按前页推导`, `同理可得`, `由上知`, `代入即得`, or similar cross-page jumps in a complete solution when the omitted algebra or condition is needed to teach the question. Repeat the necessary intermediate lines and the reason for each operation inside that module.
- Keep only these three content blocks in the all-in-one PDF. Do not add `学生思考入口`, `老师逐字讲解`, `学生可能回答`, `分层提示`, `板书或批注`, `常见错误与纠正`, `迁移追问`, lesson timing, student diagnosis, or other teacher-script material. Keep that material in `老师逐字稿.md` instead.
- Allocate pages from the amount of teachable content. Do not use a fixed page quota, fixed one-page-per-question rule, or font/margin compression as a reason to omit details. A difficult question may occupy several pages; add pages rather than shrinking or abstracting the solution.
- Do not leave detailed mathematical derivations or answer steps only in an appendix or Markdown file. The teacher must be able to explain the mathematics and complete every solution by opening only the PDF.

## Required Outputs

Create exactly these user-facing deliverables unless the user asks otherwise:

1. `老师逐字稿.md`
2. `知识点详解.md`
3. `课堂课件.pdf`（原版学生课堂讲义，系统可按学生/时间/主题动态命名）
4. `授课一体版.pdf`（教师上课唯一需要打开的 PDF，系统可按学生/时间/主题动态命名）
5. `课后反馈.md`
6. `课后作业.pdf`（学生版，默认4题）
7. `课后作业参考答案.pdf`（教师版，与学生版逐题对应）

Treat generated `.tex`, rendered page images, extracted material text, and generated question-image assets as working files rather than additional deliverables.

## Post-Class Homework Rule

For every formal lesson, generate a separate student homework PDF and a separate teacher answer PDF. If the user does not specify a count, use exactly four questions. If the user specifies a different count, follow that count exactly.

- Base the set on the latest same-student lesson, the current lesson's verified question sequence, and the corresponding OCR/local source. Read those artifacts before selecting questions.
- Use variants or transfer questions that exercise the lesson's core methods, condition checks, endpoints, integer/domain constraints, or proof closure. Do not copy a classroom question unchanged merely to fill the set.
- Keep the workload coherent: cover several central lesson targets instead of four near-duplicate calculations. Scale difficulty to the student's course level while preserving at least one meaningful synthesis or proof item when the lesson supports it.
- Record every homework question, answer, key condition, boundary check, and verification in `_work/答案核对表.md` before typesetting.
- Make `课后作业.pdf` student-facing: show complete statements, necessary figures, clean writing space, and optional time/self-assessment fields; do not expose answers, solution steps, or teacher hints.
- Make `课后作业参考答案.pdf` teacher-facing: preserve the same numbering and statements, then provide complete no-step-skipping solutions, condition checks, endpoint/existence verification, and final conclusions.
- Compile both as A4 portrait PDFs, run `pdfinfo`, scan logs for overflow/errors, and inspect low-resolution contact sheets. Save the final PDFs at the course-directory root with the exact names above; keep TeX, work PDFs, and render images under `_work/`.
- Update the `课后作业` section in `课后反馈.md` so its entries match the separate homework PDF rather than listing a different assignment.

## Student Classroom PDF Rule

The original `课堂课件.pdf` remains the student-facing classroom handout. It contains systematic knowledge summaries, visible questions, necessary figures/tables/coordinate systems, and clean writable space. It must not expose final answers, full solutions, teacher wording, hint-reveal pages, or internal source notes.

## All-In-One Teaching PDF Rule

For formal lessons, additionally create `授课一体版.pdf` as the teacher-facing all-in-one mathematics document. It contains only the knowledge content and complete derivations needed for each selected question, the full question with necessary figures, and a detailed no-step-skipping solution. Keep each question visually distinct and place its relevant knowledge immediately before it. Do not include classroom dialogue, student-thinking prompts, expected responses, hint ladders, board notes, correction scripts, or transfer prompts. Those belong in `老师逐字稿.md`. This PDF supplements the original student classroom PDF; it never replaces it.

The all-in-one PDF is a typeset, question-aligned rendering of the mathematical content in `知识点详解.md`, not a compressed digest of it and not a rendering of `老师逐字稿.md`. Draft the detailed knowledge file first, then transfer its relevant mathematical content into the PDF question by question. The PDF's complete answer for a question must reach the same no-step-skipping standard as that question's answer in `知识点详解.md`; do not replace a detailed Markdown derivation with a shorter answer-key version.

## Inputs To Collect Or Infer

Identify:

- Student name, junior-high or high-school stage, grade, province or paper region, textbook version, school progress, and class length.
- Same-student previous lessons when available: last lesson topic, mastered methods, unresolved mistakes, homework status, and the next-step suggestion left by the previous lesson.
- Lesson type: 同步巩固, 专题提升, 错题复盘, 培优拓展, 考前冲刺, or 作业答疑.
- Exact knowledge point and scope.
- Recent score, school difficulty, current mistakes, recent paper, answer sheet, homework, or screenshots.
- The observable result the student should achieve by the end of class.

If only a topic is provided, assume a 90-minute one-on-one formal lesson and mark missing details as `[待确认]`.

## Workflow

### 1. Define A Student-Specific Target

Set one main objective and a custom lesson ladder. Do not force the student into a fixed three-level or four-level taxonomy. If same-student history is available, first write what this lesson must retrieve from the previous lesson, what it should extend, and what it should leave for the next lesson. Name each layer for this student, explain why it exists, connect it to selected questions, and state the condition for advancing or stopping.

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

If same-student history is available, place a short retrieval item before the new lesson core. The retrieval item should test the previous lesson's key method or unresolved mistake, then bridge naturally into today's new target. Do not spend the whole class re-teaching old content unless the retrieval result would make today's lesson unsafe.

The question set must be rich enough for the requested class length. For a standard 90-minute formal lesson, include complete question groups or micro-question groups plus homework: diagnostic questions, model examples, guided practice, independent variants, consolidation checks, and post-class homework. If fewer questions are pedagogically appropriate, explicitly explain why and add richer variants, oral checks, or extension prompts instead of leaving the lesson thin.

This class-length minimum is only a lower bound. It never overrides an explicit user-specified count or coverage requirement, and it never imposes a maximum number of prepared questions. When the requested material is longer than one class, prepare all requested questions and add a multi-lesson pacing recommendation without removing any item.

For every used question:

- Verify the mathematics independently.
- Record teaching role, fit, recognition signals, solution plan, full solution, checks, alternative routes when useful, common wrong paths, and a hint ladder.
- For authentic exam, official exam, and mock/simulation questions, verify and record reliable source information. For local, adapted, or self-written questions, do not force a source label, but never present them as authentic exam questions unless that status is verified.
- Include detailed reasoning in `老师逐字稿.md`, `知识点详解.md`, and the corresponding all-in-one PDF solution, not only a final answer. Keep the PDF mathematical; keep dialogue and teaching interaction in the script.
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

### 6. Build Both Classroom PDFs

Create two clean A4 portrait LaTeX PDFs from the same verified question sequence. The original student classroom PDF keeps the existing answer-hidden handout format with knowledge summaries, questions, source figures, and writable space. For every selected question or coherent micro-question group, the teacher all-in-one PDF places only `知识点具体内容与完整推导`, `题目与必要图形`, and `详细不跳步解答` together as one continuous module. The teacher must be able to explain all mathematics and complete every question from the PDF without opening `知识点详解.md`. Do not add decorative illustrations or teacher-script sections.

Build the all-in-one PDF only after the corresponding `知识点详解.md` section is content-complete. For each question, copy or faithfully restate the full mathematical reasoning chain. Do not optimize for a target page count. Preserve intermediate equations, theorem-use reasons, sign and domain checks, necessity/sufficiency checks, endpoint decisions, and final answer form even when this makes the PDF substantially longer.

Use image generation only when a problem genuinely requires a complex situational or hard-to-redraw visual. Follow the image boundary and PDF QA rules in [references/math-lesson-core.md](references/math-lesson-core.md).

## Teacher Script

`老师逐字稿.md` must include:

- A no-step-skipping teaching standard: write the script so a teacher who has not learned the topic before can still teach it accurately by reading and following it.
- Micro-step explanations for every derivation, calculation, diagram observation, theorem use, and transition. Do not rely on "显然", "直接可得", "套公式", or unstated mental steps.
- Only in-scope knowledge from the student's current grade, textbook progress, and lesson topic. If a prerequisite is missing, teach it briefly before using it; do not introduce later-grade or unlearned shortcuts unless explicitly approved and marked.
- Class metadata, assumptions, objective, and preparation.
- `上节课承接与本节落点` when history exists, or `首课诊断起点` when no usable history exists. This section must state what to retrieve from the previous lesson, what evidence shows the student is ready to move on, and how today's topic connects to the next lesson.
- The custom lesson ladder and why it fits the student.
- A minute-by-minute timeline.
- A PDF-script alignment map showing classroom PDF page numbers, visible `第X题` labels, and teaching roles.
- Natural spoken Chinese under labels such as `老师说`, `学生可能回答`, `追问`, and `板书或批注`.
- For every PDF question page: the visible `第X题` label, detailed thinking path, full answer, common wrong paths, correction wording, hints from light to explicit, checks for understanding, and exact classroom PDF page number.
- Closing summary, homework, and next-lesson connection.
- A handoff note for the next preparation: what this lesson should update in the student's long-term weak-point list, common-mistake list, and next lesson suggestion. Use `[课后填写]` for real performance that has not happened yet.

## Mandatory Conversation Modules

Every `老师逐字稿.md` must include these two spoken modules unless the user explicitly removes them:

- `知识点对话（专业度+真题关联）`: place it near the opening after confirming today's target. State today's exact knowledge point, its appearance in recent or representative 高考/地方卷/模考 questions, and why it matters for scoring. Prefer concrete citations such as `2017年全国I卷第21题` or `2022年新高考I卷第22题`; verify sources during research. If exact frequency cannot be verified, write `近年多次出现（具体频次待检索确认）` rather than inventing a count. Use natural spoken wording in this structure: `今天我们要讲的是[知识点]。它在[试卷范围]中经常以[题型/位置]出现，比如[年份+试卷+题号]。这个知识点重要，是因为[大题核心/小题陷阱/后续模块基础]。掌握好它，你可以在[板块]稳定拿分，并为[后续内容]打基础。`
- `课程总结（结束前2分钟）`: place it in the last two minutes. Make the student see the learning path and preview the next lesson. Include four parts: `学习内容`（具体知识点/题型 and 1-2个核心方法）, `学生表现`（专注度、回答、练习正确率、主要错误、潜力；未上课时用 `[课后填写]`）, `待提升点`（概念理解、步骤规范、速度/熟练度等具体点）, and `后续建议`（正式学习从哪个模块开始, 预计几次课见到明显改善用 `[待确认]` or a conservative range, and personalized plan wording). Do not fabricate real classroom performance before class happens.

## Knowledge Detail File

`知识点详解.md` must include:

- A complete no-jump knowledge explanation that is detailed enough for a teacher who has not learned the topic before to understand and teach it.
- A `前后课程衔接` section: previous prerequisites to retrieve, this lesson's new conceptual step, next lesson directions, and which old mistakes should be watched during today's questions.
- Clear scope boundaries: what this lesson may use, what is not allowed because it is beyond the student's current learning progress, and any `[超纲风险-需确认]` item.
- Topic overview and prerequisite map.
- Complete definitions, notation, formulas, properties, theorem conditions, derivations, and proof ideas.
- Question-type taxonomy and recognition signals.
- Method templates with `适用条件`, `思考路径`, `操作步骤`, `易错点`, `检查方式`, and `迁移方向`.
- Selected examples and authentic exam or mock/simulation questions with detailed solutions and reliable source labels when they are claimed as such. Local, adapted, or self-written questions do not need forced source labels, but must not be falsely labeled as authentic exam questions.
- A `知识点完整性检查` section.

## Post-Class Feedback File

`课后反馈.md` must be a separate user-facing deliverable. Follow any provided feedback template first. If no template is provided, use this structure:

- `【学生姓名】：` followed by the student's actual name.
- `【上课日期】：` followed by the actual date in `YYYY-MM-DD` format.
- `【授课科目】：` followed by the actual subject.
- `【本节课核心内容】` followed by a concise summary of the actual topics, methods, and classroom requirements.
- `【学生课堂掌握情况】` followed by two numbered, concrete points: topic-specific mastery and overall classroom state.
- `【课后作业】：` followed by the actual assignment. When no more specific assignment is supplied, write `根据课堂内容上传题目图片。`

Write it in parent-facing Chinese, concise and specific. Mention the actual lesson topic, core question types, strengths, current weak points, assigned homework, and next-step advice. Always produce a complete, ready-to-send feedback document: do not leave blank sections or use placeholders such as `[课后填写]`, `[待确认]`, `待补充`, or `请填写`. Unless the user provides contrary evidence, assume the student participated actively and cooperated well in class. Describe mastery conservatively and concretely: state that the foundational content was followed while the lesson's key and difficult points still need targeted post-class practice and consolidation. Adapt those statements to the actual topic instead of repeating generic boilerplate. Do not invent an exact accuracy rate, exact wrong-question count, score change, parent reaction, or other precise observation that was not provided.

Keep the feedback in exactly these six labeled blocks. Do not add a title, examples, instructions to the teacher, extra sections, or continuity headings. Incorporate useful continuity briefly inside the core-content or mastery text when needed.

## Quality Gate

Before finishing:

- Confirm all five required deliverables exist, including both PDFs and `课后反馈.md`.
- Confirm `课后反馈.md` is fully written and ready to send: every section has substantive content, classroom participation is phrased positively by default, key and difficult points are paired with specific consolidation practice, and no fill-in placeholder remains.
- Confirm the original classroom PDF is answer-hidden and writable. Confirm every all-in-one PDF module follows exactly `知识点具体内容与完整推导 -> 题目与必要图形 -> 详细不跳步解答`.
- Run a question-by-question mathematical content-parity audit between `知识点详解.md` and the all-in-one TeX/PDF. For every question, confirm that all relevant derivations, intermediate equations, operation reasons, conditions, boundaries, and answer checks present in the knowledge file also appear near that question in the PDF. Do not accept a shorter summary merely because the final answer is correct.
- Confirm the all-in-one PDF contains none of `学生思考入口`, `老师逐字讲解`, `学生可能回答`, `分层提示`, `板书或批注`, `常见错误与纠正`, `迁移追问`, lesson timing, or student-diagnosis blocks.
- Search the all-in-one TeX/PDF for compression phrases such as `按前页推导`, `同理可得`, `由上知`, `代入即得`, `显然`, `容易得到`, and `直接可得`. Remove each occurrence or immediately expand the omitted reasoning unless it truly refers only to an already fully repeated, adjacent statement that needs no teaching step.
- Confirm difficult questions were allowed to span as many pages as needed. Reject layouts that preserve a fixed page budget by shrinking text, tightening margins, combining required blocks, or deleting intermediate reasoning.
- Confirm both PDFs use the same visible question labels, order, statements, and associated figures.
- Confirm the `_work/` internal files exist for substantial jobs: `连续学习档案.md`, `题目索引.md`, `候选题池.md`, `答案核对表.md`, `课件页码映射.md`, `授课一体版页码映射.md`, and `内容丰富清单.md`.
- Confirm the two-stage workflow was followed: continuity review, extraction, candidate pool, answer verification, and course skeleton before final PDF/script generation.
- Confirm same-student history was used when available, and that `老师逐字稿.md`, `知识点详解.md`, and `课后反馈.md` include concrete previous-current-next continuity rather than generic statements.
- If a local question PDF/document was provided, confirm the classroom PDF problem pages display only simple `第X题` labels and the teacher script aligns page-by-page to classroom page numbers and visible question labels.
- Confirm `老师逐字稿.md` includes `知识点对话（专业度+真题关联）` and `课程总结（结束前2分钟）`.
- Confirm the knowledge-point dialogue uses verified exam citations or explicitly marks unverifiable frequency as `[待检索确认]`.
- Confirm any question called `真题`, `官方考试题`, or `模拟题` has a reliable source; confirm local, adapted, or self-written questions are not mislabeled as authentic exam questions.
- Confirm the formal 90-minute lesson has enough complete question groups or micro-question groups, including diagnostic, model, guided practice, independent variant, consolidation, and homework work.
- If the user specified a count, source coverage, or one-question-per-type rule, recount the actual fully stated questions in the unified sequence and both PDFs. Confirm every requested item is present as required content, not merely listed in an index, future roadmap, optional extension, or conditional homework. Class duration must not be cited as a reason for reducing the requested count.
- Confirm the Markdown files contain no fenced code blocks and use `$...$` or `$$...$$` math delimiters.
- Confirm there are no bare LaTeX commands in prose and no formulas wrapped only by ordinary parentheses.
- Confirm `老师逐字稿.md` and `知识点详解.md` contain no skipped reasoning steps, no unexplained formulas or theorem jumps, and no unapproved out-of-scope knowledge.
- Confirm every selected question's final answer and key reasoning have been independently checked; flag unresolved or possibly wrong answers before finalization.
- Compile the classroom PDF with XeLaTeX and confirm it opens.
- If rendering is needed, inspect only contact sheets or thumbnails for coarse readability, absence of obvious answer/method leakage, diagram crowding, and writable space. Do not zoom into single pages.
- Confirm every displayed diagram is mathematically accurate.
- Do not fabricate sources, scores, student reactions, or authentic-exam status.

## Feishu Finalization

Do not run `lark-cli` from inside this skill. The host web service owns Feishu finalization after the Codex job exits successfully.

After the five local deliverables pass the quality gate, finish with a concise local completion summary. The service will then use the current machine's logged-in `lark-cli --as user` identity to create the course folder under `LY9efBiWjlEAQWdqPrucuLl4nic`, import/upload the five files, create the calendar event when the lesson time is valid, and send the Feishu sync result message.
