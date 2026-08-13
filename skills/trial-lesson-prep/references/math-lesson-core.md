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
3. `课件生成`: create the A4 portrait classroom handout PDF from the verified sequence; keep pages student-facing, spacious, and aligned with the teacher script.
4. `逐字稿和内容丰富`: expand the teacher script and content density after verification; add sufficient diagnostic, model, same-type validation, variant, authentic-style, and homework material; write page-by-page teaching language, prompts, likely student responses, correction wording, board notes, and `大招/爽感` moments.

The main agent must integrate the sub-agent outputs, resolve conflicts, and run final QA. Do not use unchecked extracted questions, unverified answers, thin question sets, or outline-only teacher scripts in final deliverables.

## Internal Working Files And Two-Stage Workflow

Create these intermediate files under `_work/` for substantial lesson-prep jobs. They are internal QA artifacts, not user-facing deliverables:

1. `_work/题目索引.md`: extracted local, library, screenshot, and web questions with internal IDs, topics, teaching roles, and missing information.
2. `_work/候选题池.md`: shortlisted and rejected candidates, fit rationale, and whether a question is verified authentic exam, official exam, simulation/mock, local, adapted, or self-written.
3. `_work/答案核对表.md`: independent solutions, final answers, condition checks, diagram checks, and unresolved doubts.
4. `_work/连续学习档案.md`: same-student history summary, previous unresolved points, current lesson bridge, old-knowledge retrieval plan, and next-lesson handoff.

Run preparation in two internal stages:

1. Stage 1: finish continuity review, question extraction, candidate pool, answer verification, and visible-gain course skeleton.
2. Stage 2: generate the classroom PDF, write and enrich the teacher script, complete the final four deliverables, and run QA.

Do not start Stage 2 until the selected question sequence has passed answer verification, topic-fit review, visible-gain review, and question-volume review for the class length.

## 1A. Continuous Lesson Standard

Same-student lessons must form a learning chain. If previous lessons or previous output directories are available, read the latest relevant `课后反馈.md`, `老师逐字稿.md`, and internal notes before selecting the new sequence.

Every substantial lesson should create `_work/连续学习档案.md` with:

- Last lesson topic and visible gain.
- What the student appeared to have mastered, using `[课后填写]` if real performance is unknown.
- Unresolved mistakes or habits to retrieve at the start of this lesson.
- A short old-knowledge retrieval item or oral check for this lesson.
- The bridge from previous knowledge to today's target.
- The handoff that the next preparation should inherit.

Final deliverables must show continuity:

- `老师逐字稿.md`: include `上节课承接与本节落点` when history exists, or `首课诊断起点` when no usable history exists.
- `知识点详解.md`: include `前后课程衔接`, explaining prerequisites from previous lessons and next-topic directions.
- `课堂课件.pdf`: when history exists, include a short student-facing retrieval question before the new core; do not include teacher-only historical notes.
- `课后反馈.md`: include `与上节课的衔接`, `本节课新增进展`, and `下节课建议` when relevant.

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

- Detail level is independent of the student's score. Always write `知识点详解.md` and `老师逐字稿.md` at maximum teacher-preparation density so the teacher can teach without getting stuck. Treat "60分学生能听懂" only as the minimum clarity threshold for wording and prerequisite铺垫, not as permission to simplify, omit, or shorten the teacher material.
- Distinguish `一般结论` and `二级结论`.
  - `一般结论` means textbook-level definitions, standard equations, naming conventions, basic formulas, and directly taught properties. These may be stated directly, but must still include conditions, symbol meanings, and common misuse boundaries.
  - `二级结论` means any commonly used but derived shortcut, exam routine, transformed formula, method template, or "大招", including but not limited to 焦半径、通径、焦点弦、弦长公式、中点弦/点差法结论、角相等转斜率、定点/定值整理、参数法少算一个根、韦达条件转换、面积/距离快速表达. These must not be only listed. For every二级结论, write `结论`, `适用条件`, `从哪里来`, `逐步推导`, `每一步为什么成立`, `什么时候不能用`, and `课堂讲法`.
- For二级结论推导, prefer in-scope prerequisites when they are enough. Out-of-scope or later-grade methods may be used when they genuinely improve the lesson, but they must be clearly marked as `[超纲]`, explain why they are worth using here, and provide either an in-scope alternative explanation or a note that this part is only for awareness.
- 二级结论的推导必须拆到最小可教学步骤。不要把多个代数动作合并在一句话里。展开、移项、因式分解、除以非零量、开方、代入定义、检查参数范围，都算不同小步，每一小步都要写出理由。
- Knowledge coverage must be broad enough for a teacher to answer predictable student questions. Do not only include knowledge used by the selected questions; include the surrounding foundation that the teacher may need to explain the topic smoothly.
- Write at an extremely detailed, no-step-skipping standard. Assume the teacher may not have learned this topic before and must still be able to teach the lesson by following the file line by line.
- Explain every prerequisite, transition, algebraic transformation, theorem condition, diagram reading step, and conclusion. Do not jump from "therefore" to an answer unless the intermediate reason is written.
- Prioritize the student's current grade, textbook progress, and stated lesson scope, but do not ban out-of-scope or later-grade knowledge. Any such content must be clearly marked as `[超纲]`, with a short explanation of why it is being used and how to teach or skip it safely.
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

- Detail level is not adjusted downward for high-scoring students. Before using any formula, theorem, substitution, parameter, slope relation, vector relation, or Vieta relation, state why it is allowed here and what object it applies to. Do not assume the student can fill in algebra, geometry, or notation gaps.
- The `完整解答` for each question must be more detailed than ordinary board notes. It is a teacher's anti-stuck teaching script, not a compressed answer key. Expand every algebraic transformation, including substitution, expansion, collecting terms, factoring, applying Vieta, converting vector/angle/length conditions, solving parameters, checking domains, and writing the final answer form.
- Every major step must include a `为什么这一步这样做` explanation. For example, if choosing to eliminate $x$ instead of $y$, explain which condition becomes simpler; if using a known root, explain why that parameter value corresponds to the known point; if using $k_1+k_2=0$, explain the symmetry or angle condition that makes it valid.
- Use a one-small-step-at-a-time standard, stricter than ordinary board notes. A "small step" means a single operation or inference only. Do not merge `代入并整理`, `通分化简`, `由韦达可得`, `两式相除得`, or `联立解得` into one jump. Write the actual intermediate line(s) and the reason for the operation.
- Avoid all hidden mental arithmetic in final teaching files. Simple arithmetic may be brief, but it still must show the equality chain, especially sign changes, common denominators, factorization, square roots, and parameter restrictions.
- When a solution uses a二级结论, either reproduce the necessary derivation in the question section or explicitly point to the corresponding derivation section in `知识点详解.md`, then show how the current question satisfies its conditions.
- The teacher script must be detailed enough that a teacher who has not previously studied the topic can still deliver it accurately.
- For each question, break the solution into observable micro-steps: what to look at first, what information to mark, which prior fact is being used, why the next operation is allowed, what to write on the board, and what the student should say or do.
- Do not use unintroduced formulas, theorems, tactics, or later-grade methods without warning. If an efficient shortcut is beyond the student's current scope, explicitly mark it as `[超纲]`, explain why it appears, and provide an in-scope method or say that this part is only for awareness.
- Every transition in spoken wording and every transformation in the solution must have a reason. Avoid vague jumps such as "显然", "容易得到", "直接可得", or "套公式" unless the missing reasoning is immediately written out.
- If the student has not learned a prerequisite, insert a short teachable prerequisite block before using it, with teacher wording and a one-step check question.

For questions that appear in the classroom PDF, place the full teacher script and detailed solution near the corresponding question section, not only in an end-of-file solution bank.

## 6. Classroom PDF Standard

Generate `课堂课件.pdf` as an A4 portrait classroom handout PDF for tablet annotation. Keep the filename `课堂课件.pdf` for system compatibility, but the content should be a clean math handout, not a PPT-style slide deck.

Start from `assets/tablet-beamer-template.tex`. Copy it into the lesson working directory, replace the sample pages, and keep the `\writingspace` macro for annotation pages.

### Student-facing answer boundary

Keep `课堂课件.pdf` for the visible knowledge-point display, problem statements, required diagrams, tables, coordinate systems, writable annotation space, and a final qualified template summary only. Do not include final answers, complete solution steps, answer-key pages, hint pages, reveal pages, visible-gain teacher wording, or teacher-only source notes unless the user explicitly requests an answer version. Store all answers, checks, hints, visible-gain design, and full explanations in `老师逐字稿.md` and `知识点详解.md`.

### Layout

- Use an A4 portrait `ctexart` handout layout and Chinese-capable XeLaTeX compilation.
- Use a normal class handout title such as `[课程主题]课堂讲义`. Do not add a student/date subtitle line. Do not put style labels such as `学校试卷风`, `A4竖版`, or `题目与留白` on the actual classroom PDF.
- Use a plain school-paper style: black text, simple horizontal rules, and no decorative cards.
- Do not draw bordered writing boxes or horizontal ruled writing lines. Leave clean blank vertical space after questions for tablet handwriting.
- Start the PDF with one or more knowledge-point display pages before the questions. These pages must be content-rich and should not leave handwriting blanks. They should be textbook/workbook-style complete basic knowledge systems, not a brief preview and not local hints for the later exercises. Write the complete general foundation of the topic before the problem pages.
- Knowledge pages must contain only abstract, reusable knowledge: definitions, objects, symbols, conditions, formulas, properties, graph/diagram/table representations, judgment rules, common question-type signals, and error boundaries. Do not reference later question numbers, specific problem functions, specific numbers, local PDF question wording, any solution process, or teacher-only wording.
- Do not underwrite the knowledge pages. For each core object in the topic, cover at least: what it is, when it is allowed to use, how it is represented or drawn, what conclusions it gives, how to judge it in a question, and where it commonly fails. Add more knowledge pages rather than compressing away necessary basics.
- For function topics, cover function definition, domain, range, correspondence rule, equality of functions, analytic/graph/table/verbal representations, the meaning of graph points, monotonicity, parity or symmetry when relevant, extrema, zeros, endpoints, and parameter effects as applicable.
- For quadratic functions, cover standard/general form, vertex form, intercept form when relevant, opening direction, axis of symmetry, vertex, discriminant, roots, intersections with the x-axis, monotonic intervals, interval extrema, and graph sketches.
- For extrema and maximum/minimum topics, clearly distinguish global maximum/minimum from local extrema. State that interval extrema usually come from endpoint values, interior extrema, non-differentiable points, or boundary/critical cases. Include necessary conditions and sufficient conditions for extrema, plus boundary cases.
- For zero topics, include a graph-based explanation of intersections with the x-axis, and distinguish crossing, tangency, no intersection, and parameter-driven critical states.
- Use intelligent density: one major problem per page; small same-type questions may be grouped on one page when they still leave enough writing space.
- Leave substantial writable space after each problem or problem group. Aim for roughly 55-75% writable blank area on pages where the student or teacher should write.
- Label each problem page with the simple student-facing question number, such as `第X题`. If it comes from a local question PDF, still write only `第X题` near the prompt.
- End the PDF with a `常用套路模板总结` page only when the lesson's selected questions genuinely support reusable routines. The summary must not be a forced slogan: each item should state the applicable question type or recognition signal, conditions for use, operation sequence, and situations where the routine may fail. If no reliable reusable template exists, write a concise `本节课不硬总结模板，重点保留题目中的判断条件` style closing instead.
- Put detailed derivations, hints, answer checks, visible-gain wording, and teacher wording in the Markdown files, not in the classroom PDF.

### Accurate visuals

Use deterministic, coordinate-driven rendering first:

- Geometry diagrams: TikZ, Asymptote, or another precise TeX-compatible programmatic drawing method. For solid geometry, prefer Asymptote when available; otherwise use a TikZ fixed oblique projection from explicit 3D coordinates.
- Function plots and coordinate systems: TikZ, pgfplots, or a programmatic plot.
- Statistical charts and tables: LaTeX or programmatic drawing.
- Existing source figures: preserve or crop when legible and permitted.

If a problem is naturally diagram-based or graph-based, the classroom PDF must include the diagram. Do not omit drawable figures to save time. For geometry, function images, coordinate systems, vectors, complex-plane diagrams, probability/statistical charts, or tables, draw or typeset them in LaTeX next to the problem statement whenever the visual is relevant to solving the problem.

### Geometry Perspective Standard

For solid geometry, the diagram is part of the mathematics, not decoration. A diagram that has wrong perspective, inconsistent parallelism, unclear occlusion, cramped labels, or approximate point placement is not acceptable even if the text is correct.

Build every solid-geometry diagram from a defined coordinate or projection model:

- First assign 3D coordinates to the real points or define a consistent oblique projection basis, then project to the page. Do not place vertices by eye.
- All edges that are parallel in the solid must remain parallel in the drawing unless the diagram intentionally uses a clearly defined perspective projection. For ordinary classroom handouts, prefer stable oblique projection because it preserves parallelism and is easier for students to annotate.
- Points defined as midpoints, moving points on a segment, feet of perpendiculars, intersections, centers, or section vertices must be computed from the coordinates or stated ratio, not visually guessed.
- Perpendicular, equal-length, midpoint, parallel, coplanar, and incidence relations required by the problem must be visually compatible with the drawing and mathematically recorded in `_work/课件生成计划.md` or `_work/答案核对表.md`.

Use a clear visual hierarchy:

- Visible edges and the main problem lines use solid lines with the strongest weight.
- Hidden edges use dashed lines, and only when the hidden/visible distinction helps the student read the solid. Do not use dashed lines for every auxiliary relation.
- Auxiliary construction lines, coordinate axes, normals, projections, and section lines must be visually lighter or in a second small diagram.
- Key planes, sections, bases, and faces may use light gray fills or transparent hatching, but never heavy decorative color. Plane fills must be light enough that they do not hide main lines, moving points, labels, or target objects.
- Labels must not sit on lines, overlap other labels, or touch the page boundary. Move labels with anchors and offsets until they are readable.

Size and composition rules:

- A simple geometry diagram should normally occupy at least 45% of the text width. A complex solid-geometry diagram should normally occupy at least 55% of the text width or be split into two diagrams.
- If one diagram becomes crowded, split it into `原图` and `建系/向量示意图`, or `原图` and `截面/投影图`. Do not squeeze all vertices, planes, normals, and auxiliary lines into one small picture.
- Leave enough space around the diagram for tablet annotation; do not put the diagram so low or so small that writing must happen over labels.

QA for solid-geometry figures:

- Prefer TeX-side correctness: define coordinates deliberately, keep labels offset from lines, and split crowded diagrams before compiling.
- For visual QA, generate only low-resolution contact sheets or thumbnails. Do not inspect full-size single-page renders with image tools, and do not zoom into individual pages.
- If the thumbnail suggests obvious crowding, revise the TikZ coordinates or split the figure based on the TeX source and problem statement, then recompile. Do not spend time on repeated high-resolution visual inspection.

Use image generation only for a genuinely necessary complex situational image, spatial illustration, or hard-to-redraw problem visual. When it is needed, follow the installed `imagegen` skill and use the built-in image generation tool by default. Do not generate decorative images. Do not ask an image model to draw exact geometry, axes, measurements, formulas, or answer text. Validate every generated image before embedding it and mark it as a generated illustration in the teacher script.

### Build and QA

- Compile with XeLaTeX, usually twice.
- Confirm the PDF exists, is non-empty, and opens.
- Check page count with PDF tooling.
- If visual checking is useful, use only contact sheets or thumbnails; do not zoom into single pages.

## 6A. Final QA Priorities

Before finalization, prioritize these checks:

- No skipped teaching steps in `老师逐字稿.md` or `知识点详解.md`.
- A 40-60 minute trial lesson has at least diagnostic/trap, model, guided same-type, independent validation, variant or authentic-style, and homework/next-step practice components.
- Every selected question has independently checked final answers and key reasoning; unresolved or possibly wrong answers are flagged before delivery.
- Any question called `真题`, `官方考试题`, or `模拟题` has reliable source information. Local, adapted, or self-written questions are not mislabeled as authentic exam questions.
- Local PDF or screenshot questions can be the lesson spine, but final user-facing files do not need to emphasize local source/page/question-number mapping.

## 7. Post-Class Feedback Standard

Generate `课后反馈.md` as a separate deliverable for every trial lesson. If the user provides a Word/PDF/template file, extract its sections and follow that template. Default sections are:

- `【学生姓名】：` with the actual name
- `【上课日期】：` with the actual date in `YYYY-MM-DD`
- `【授课科目】：` with the actual subject
- `【本节课核心内容】` with a concise topic-specific summary
- `【学生课堂掌握情况】` with two numbered points covering mastery and classroom state
- `【课后作业】：` with the actual assignment, or `根据课堂内容上传题目图片。` when no more specific assignment is supplied

Use concise parent-facing Chinese and write a complete, ready-to-send document with substantive content in every block. Do not add a title, examples, extra sections, teacher instructions, `[课后填写]`, `[待确认]`, `待补充`, `请填写`, or another fill-in placeholder. For trial lessons, incorporate the diagnostic finding, visible learning gain, and remaining bottleneck inside the two content blocks. Unless contrary evidence is supplied, describe the student as participating actively and cooperating well. State conservatively that foundational content was followed while the actual lesson's key and difficult points still require targeted practice and consolidation. Do not invent exact accuracy, error counts, score changes, parent reactions, or other unsupported precise observations.

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
