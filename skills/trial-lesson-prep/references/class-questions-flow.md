# Class Questions Flow Reference

This reference condenses the user's `class-questions.pdf` into reusable trial lesson preparation notes.

Use `math-lesson-core.md` as the controlling specification. The student-type labels below are heuristics only. Build a custom lesson ladder from the actual student information instead of forcing a fixed classification.

## Operational Flow

### 接课

- Watch the trial-lesson assignment group for teaching information.
- Tell the academic/admin teacher about regular available time so scheduling is easier.
- The academic/admin teacher may privately ask whether the teacher wants a lesson when student needs match teacher style.

### 课前

- After scheduling, the teacher receives a text message with class time, advisor name, and advisor contact.
- Contact the advisor by phone or WeChat, or wait for the advisor's call.
- Confirm student grade, score, ranking, desired class content, wrong questions, and class time.
- If no text message arrives before class, contact the academic/admin teacher or check the teaching system schedule.
- After the advisor creates the communication group, send a self-introduction.
- Ask student/parent for the recent exam paper, answer sheet, weak knowledge points, and preferred class mode.

### 课后

Send feedback in the group after the class. Include:

- Problems revealed in the trial lesson.
- Skills mastered during the lesson.
- Suggestions for later study.
- Board screenshot.

### 备课生成完成后的固定收尾

- Stop after the four local deliverables pass quality checks.
- The host service will use the current logged-in `lark-cli --as user` identity to import/upload the four deliverables, create the Feishu calendar event when possible, and send the sync result message.

## Preparation Checklist

- Tablet/computer plus drawing tablet.
- Download classware and platform materials in advance.
- Confirm content and student background with advisor.
- Revise group self-introduction.
- Communicate in the group before class.
- Prepare lesson content from the student's requested topic and wrong questions.
- Prepare a problem set suitable for a 40-minute class.
- If the class needs authority or a strong hook, search for matching provincial/municipal 高考题 and strong explanations before preparing the final board.

## Web Search Workflow For 高考题 And 大招

Use this workflow when the user wants a试听课 based on a specific province/municipality, current topic, or high-impact method.

### 1. Lock Search Variables

Confirm or infer:

- 省市/试卷地区: e.g. 浙江, 江苏, 新高考全国I卷, 北京.
- 年级 and current module.
- 知识点: e.g. 导数, 圆锥曲线, 三角函数, 数列, 立体几何, 概率统计.
- 题型: 选择, 填空, 解答, 压轴, 小题技巧.
- Student type: 基础薄弱型, 中等提升型, 培优冲刺型.

If the province is unknown, use the student's current school province if provided; otherwise search national/new-gaokao examples and mark the province as待确认.

### 2. Search Query Templates

Run several focused searches rather than one broad search:

```text
[省市] 高考 数学 [知识点] 真题
[省市] 高考 [年份] 数学 [题型] [知识点]
[省市] 一模 二模 数学 [知识点] [题型]
[新高考/全国卷/省市] 数学 [知识点] 压轴题 解析
[知识点] 高考 数学 常见陷阱
[知识点] 高考 数学 秒杀 大招
[题型] 一题多解 高考 数学
[知识点] 高考 数学 模板 方法
```

For video or creator-style explanations, search:

```text
B站 [知识点] 高考数学 大招
小红书 [知识点] 高考数学 秒杀
微信公众号 [知识点] 高考数学 压轴题 解析
抖音 [知识点] 高考数学 易错题
```

Use search results as teaching inspiration, then verify the math independently. Do not copy an explanation blindly.

### 3. Source Selection Rubric

Prefer:

- Official exam papers, school/teaching-research PDFs, or reliable education sites.
- Questions with full answers and enough steps to verify.
- Recent 3-5 year 高考题 or high-quality 一模/二模 when the province has suitable examples.
- A problem that matches the student's level while still producing a visible "I learned something" moment.

Avoid:

- Unverified screenshots with no source or answer.
- Tricks that only work under hidden conditions.
- Overly difficult questions that cannot be explained inside 40 minutes.
- Methods that look flashy but do not help the student's current pain point.

### 4. Turn A Search Result Into A Trial-Lesson "大招"

Extract the result into this compact format:

```text
题目来源：
知识点：
适合学生类型：
学生常见错误：
大招名称：
适用条件：
三步讲法：
学生练习变式：
课末钩子：
```

Make the "大招名称" memorable but honest. Examples:

- 导数压轴: "先定形再求参"
- 圆锥曲线: "设而不算，先抓结构"
- 三角函数: "角先统一，再看范围"
- 数列: "看差看比，先猜模型"
- 立体几何: "先建系，再翻译成坐标"

### 5. Fit To The Student

Treat the following as optional tactic examples, not mandatory labels. Select and combine tactics according to the student's custom lesson ladder.

For 基础薄弱型:

- Use local 高考小题 or simplified改编题.
- Big move should be a口诀, checklist, or one-step判断法.
- Let the student quickly get one question right.

For 中等提升型:

- Use a real 高考/模考题 with 2-3 common traps.
- Big move should be a repeatable template.
- Show standard method vs optimized method.

For 培优冲刺型:

- Use a high-quality压轴 or strong变式.
- Big move should be a structural insight or lesser-known route.
- Give a short challenge first, then reveal the method.

### 6. Lesson Packaging

Use the searched material in the 40-minute lesson like this:

- Opener: let the student try the selected真题 or a simplified version.
- Contrast: show where most students get stuck.
- Big move: teach the named method in three steps.
- Validation: give a same-type变式题.
- Board screenshot: preserve the original attempt, method, and variant answer.
- Next lesson hook: "今天只讲了这个题型最关键的一步，下次可以把这一类题完整整理成模板。"

## Mandatory Spoken Modules

Every trial lesson script must contain:

- `知识点对话（专业度+真题关联）` near the beginning. Connect today's knowledge point to verified 高考/地方卷/模考 appearances and explain why it matters for scoring. Use exact year, paper region, and question number when verified; mark frequency as `[待检索确认]` if not verified.
- `课程总结（结束前2分钟）` at the end. Use the structure `学习内容`, `学生表现`, `待提升点`, `后续建议`. Before the actual class, keep performance details as `[课后填写]`; after class, make them specific and parent-facing.

## Student Tactic Examples

Do not classify solely by score. Use these examples only when they match the student's evidence.

### 基础薄弱型

Features:

- Low confidence; easily feels "I cannot learn this".
- Low subject interest and motivation.
- Many knowledge gaps.

Design:

- Give fast wins.
- Use daily-life examples to explain concepts.
- Start from core basics and simple exercises.
- Convert knowledge into formulas, memory hooks, or easy routines.

### 中等提升型

Features:

- Has some foundation but lacks system.
- Thinks they are "okay" but does not know how to break through.
- Repeats similar mistakes.
- Needs clear direction and methods.

Design:

- Point out the shortest path and the common traps.
- Use logical examples to build a knowledge system.
- Use question-led teaching: let the student try first, then guide.
- End with variant exercises, preferably real exam questions.
- Give emotional value: show that the method makes a real exam problem easier.

### 培优冲刺型

Features:

- Solid foundation; wants extension.
- May ask for advanced or beyond-syllabus questions.
- Gets bored by normal teaching.
- Needs challenge and stronger methods.

Design:

- Start with one difficult problem that the student likely cannot solve quickly.
- Give a short amount of thinking time.
- Use a simple, powerful method to solve it.
- Offer "secret weapon" level methods that show room for growth.

## Making The Student Feel Gain

### Trap Question Flow

1. Select one or two questions that look simple but hide a common trap.
2. Let the student try first.
3. Show a typical wrong answer or wrong path.
4. Build contrast and trust by teaching a named method or step pattern.

Suggested wording:

```text
咱们先来个热身题。这道题很多同学都以为很简单，但实际考试时很容易掉坑。给你1分钟试试看？
```

```text
看，这就是很多同学的典型思路。你的想法已经接近了，但这里有一个关键条件没有被用上。
```

```text
跟着老师把这类题拆成几个固定步骤，以后再遇到就能更快看出陷阱。
```

### Method Contrast

- Show the standard solution and the teacher's optimized method side by side.
- Ask the student which method saves time.
- Use one similar problem for immediate validation.
- Emphasize the concrete benefit, such as saving time or reducing repeated mistakes.

### Visual Board Progress

Show:

- Student initial answer.
- Corrected answer.
- Teacher optimized version.
- Thinking upgrade circled in red.

Ask:

```text
刚才这个方法帮你解决了哪个问题？
```

```text
你希望下次课优先破解哪个题型？
```

## Board Layout

Use stable sections:

- 题目区
- 思路讲解区
- 解答区
- 学生变式解答区
- 总结区

Keep the board visible until the end and use it for the screenshot.

## Student And Parent Interaction

### Student

- Praise immediately when the student answers correctly.
- Compare with the student's earlier attempt to make progress visible.
- Use timed answering to gradually increase speed.
- When the student makes a mistake, frame it as useful evidence:

```text
这个错误很有价值，它正好说明我们需要强化...
```

- Near the end, ask what the student wants to learn next.

### Parent Feedback

Use this sequence:

1. Praise.
2. Point out the current problem.
3. Give the solution and next-step course plan.
4. Show responsibility and care.

Example skeleton:

```text
今天xx上课整体状态不错，能够跟着老师思路回答问题，尤其是[具体表现]。
这节课也暴露出[具体问题]，这会影响到[具体题型/考试表现]。
本节课我们重点训练了[方法/题型]，孩子已经能做到[可观察结果]。
后续建议继续围绕[方向]系统练习，我会根据今天的问题把下节课内容设计成[计划]。
```

## Avoid

- Avoid full teacher monologue; make sure the student thinks and writes for more than 15 minutes.
- Avoid negative phrasing like "you are wrong"; use "we can try a more efficient method".
- Follow up with parents within 24 hours; the best conversion window is within 2 hours after class.

## Common Questions

### 如何确定具体上课内容？

Use the class group QR code or advisor contact from the scheduling information. Ask the student/parent for recent papers, wrong questions, and the target knowledge point. If there is no group QR code, the advisor should contact the teacher before class.

### 联系不上学生怎么办？

Check the advisor contact in the scheduling information and actively confirm student details with the advisor.

### 如何确定是否转化？

Watch for conversion SMS notification. If it does not arrive, ask the advisor.

### 学生到时间没来怎么办？

Let the advisor contact the student. If the student confirms no-show within one hour after the class time, ask the academic/admin teacher about the no-show subsidy process.

### 转化成功后补贴怎么申请？

The system automatically adds it to monthly pay, paid on the fifteenth of the next month.

### 转化成功后是否继续带学生？

Normally yes. After conversion, the trial student becomes the teacher's formal student unless there is a special situation.
