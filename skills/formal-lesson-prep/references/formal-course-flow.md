# Formal Course Flow Reference

This reference adapts the user's trial-lesson process into a formal-course preparation workflow.

Use `math-lesson-core.md` as the controlling specification. In particular, create a student-specific difficulty ladder and generate `知识点详解.md` rather than a student handout.

## Trial Lesson Vs Formal Lesson

| Dimension | Trial lesson | Formal lesson |
| --- | --- | --- |
| Main goal | 展示教学亮点、建立信任 | 系统提升成绩、持续补缺 |
| Content design | 刻意设计一个有记忆点的环节 | 按知识体系循序渐进 |
| Question choice | 1-2 道能产生反差的题 | 诊断题、例题、真题、变式、作业形成梯度 |
| Method use | 强调 "大招" 和获得感 | 方法必须回到完整知识体系和长期复习 |
| Output | 逐字稿、知识点详解、课堂课件 PDF、沟通话术、课后反馈 | 逐字稿、知识点详解、课堂课件 PDF、真题练习、作业闭环 |

Formal lessons can still borrow the trial-lesson strengths: diagnostic opener, visible progress, board recap, and encouraging language. The difference is that every technique must serve a complete learning path.

## Formal Lesson Preparation Flow

1. Confirm the student situation: grade, province, textbook, school progress, current score, weak topic, recent wrong questions, and class duration.
2. Define the lesson type: 同步巩固, 专题提升, 错题复盘, 培优拓展, 考前冲刺, or 作业答疑.
3. Build a complete knowledge map for the target topic.
4. Search localized or high-quality exam questions and verify the solutions.
5. Arrange the questions into a student-specific learning ladder: diagnostic -> model example -> guided practice -> independent variant -> homework.
6. Write the teacher script and detailed teacher-facing knowledge file as Markdown files.
7. Build a clean LaTeX Beamer classroom PDF with writable tablet space.
8. Check the files for no fenced code blocks and correct math delimiters.
9. Fixed final step: stop after the four local deliverables pass quality checks. The host service will sync them to Feishu with the current logged-in `lark-cli --as user` identity, create the calendar event when possible, and send the sync result message.

## Knowledge Completeness Checklist

Use this checklist before finalizing `知识点详解.md`:

- Does the lesson identify prerequisites?
- Are definitions and symbols clearly stated?
- Are formulas written with conditions of use?
- Is there at least one derivation, proof idea, or intuitive explanation when useful?
- Are all standard question types listed?
- Does each method template say when it works and when it fails?
- Are common traps and typical wrong paths included?
- Are real exam questions connected to the exact knowledge point?
- Is there a class summary and homework?
- Is the next lesson's connection named?

## Exam Question Search Playbook

Search variables:

- Province or paper region: 浙江, 江苏, 北京, 新高考 I 卷, 全国甲卷, etc.
- Grade and module: 高一函数, 高二导数, 高三圆锥曲线, etc.
- Knowledge point: 单调性, 零点, 椭圆离心率, 等差数列, 立体几何向量法, etc.
- Question type: 选择, 填空, 解答, 压轴, 小题技巧.
- Student level: 基础补缺, 中等提升, 培优冲刺.

Search query templates:

- `[省市/全国卷] 高考 数学 [知识点] 真题 解析`
- `[省市] 一模 二模 数学 [知识点] [题型]`
- `[年份] [试卷地区] 数学 [知识点] [题型]`
- `[教材版本] [年级] 数学 [章节] [知识点] 典型题`
- `[知识点] 高考 数学 常见陷阱`
- `[题型] [知识点] 一题多解 高考 数学`
- `B站 [知识点] 高考数学 方法`
- `微信公众号 [省市] 高中数学 [知识点]`
- `小红书 [知识点] 高考数学 易错题`

Selection rubric:

- Prefer official papers, teaching-research PDFs, school mock papers, and reputable education sites.
- Prefer recent 3-5 year exam questions when they match the topic.
- Choose questions that reveal a specific misconception or support a clear method template.
- Avoid unverified screenshots, unexplained answers, or flashy tricks with hidden conditions.
- Verify every solution independently before using it in class.

## Student-Level Adaptation Examples

Do not force these three examples onto every student. Build a custom ladder for the current student and borrow only the useful tactics.

### 基础补缺

- Start from definitions and prerequisite skills.
- Use simple diagnostic questions and short success loops.
- Turn formulas into checklists or memory hooks.
- Use real exam questions only after simplifying or scaffolding.

### 中等提升

- Use wrong-question diagnosis and common trap comparison.
- Teach a repeatable template for each question type.
- Include one authentic exam or mock-exam question as validation.
- Ask the student to explain the recognition signal and first step.

### 培优冲刺

- Start with a challenging real-question variant.
- Emphasize structure, hidden conditions, and multiple methods.
- Show why the shorter method works, not just that it is shorter.
- Assign extension homework and ask for solution reflection.

## Board Layout

Preserve board work for recap:

- 题目区
- 知识结构区
- 方法模板区
- 解答区
- 学生变式区
- 课末总结区

For formal lessons, add a "下节课衔接" note at the end of the board.

## Required Markdown File Quality

Every Markdown file should be directly usable:

- No fenced code blocks.
- Display formulas use `\[ ... \]`.
- Inline formulas use `\( ... \)`.
- Exam sources are labeled with year, region, paper, and URL when known.
- Missing information is marked as `[待确认]` or `[待检索]`, not guessed.
- Teacher script sounds like a teacher speaking, not like a lesson-plan outline.
- `知识点详解.md` is complete enough for the teacher to prepare and teach from independently.
