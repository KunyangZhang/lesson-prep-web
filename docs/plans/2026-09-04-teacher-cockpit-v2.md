# Teacher Cockpit V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Turn the single-teacher lesson-prep MVP into a coherent teacher cockpit with a redesigned frontend and a small set of backend capabilities that complete the preparation, review, and learning-feedback loop.

**Architecture:** Keep the existing React 19 + Express monolith and file/SQLite-backed domain services, but split the 4,000-line frontend into feature-oriented components and introduce a lightweight dashboard aggregation endpoint. Add only workflow features that strengthen the existing single-teacher product boundary: overview metrics, actionable queues, reusable lesson templates, output revisions, and learning/quality trends. Preserve every existing API and production data path while adding endpoints incrementally.

**Tech Stack:** React 19, TypeScript, Vite, Express 5, SQLite FTS, Node test runner, Lucide icons, React Markdown.

---

### Task 1: Dashboard contract and backend aggregation

**Files:**
- Create: `server/dashboard.test.ts`
- Create: `server/dashboard.ts`
- Modify: `server/index.ts`
- Modify: `server/types.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing aggregation tests**

Cover an empty store and a mixed dataset. Assert total students/courses, running work, courses awaiting post-class confirmation, recent courses, upcoming courses, material counts, quality average, and latest activity ordering.

**Step 2: Run the focused test and verify failure**

Run: `npx tsx --test server/dashboard.test.ts`

Expected: FAIL because the dashboard aggregator does not exist.

**Step 3: Implement the typed dashboard aggregator**

Add a pure `buildDashboardSnapshot` function that consumes store entities and material/job summaries without mutating them. Use deterministic ISO-date sorting and return zero-safe metrics.

**Step 4: Expose the authenticated endpoint**

Add `GET /api/dashboard`; reuse existing authentication and store helpers. Do not add new persistence in this task.

**Step 5: Verify**

Run: `npx tsx --test server/dashboard.test.ts && npm run check`

Expected: all dashboard tests pass and both TypeScript projects compile.

### Task 2: Frontend foundation and navigation shell

**Files:**
- Create: `src/components/AppShell.tsx`
- Create: `src/components/Feedback.tsx`
- Create: `src/components/StatusBadge.tsx`
- Create: `src/features/dashboard/DashboardView.tsx`
- Modify: `src/App.tsx`
- Replace: `src/styles.css`

**Step 1: Define the new information architecture**

Use four primary destinations: 今日、学生、课程、资料库. Keep account and system health in a utility section. Use a warm editorial workspace visual system: deep ink navigation, parchment canvas, amber action color, restrained green/blue semantic accents, and compact but legible cards.

**Step 2: Implement accessible shell primitives**

Add labeled navigation, visible focus styles, skip link, responsive drawer behavior, reusable loading/error/empty feedback, and 44px minimum touch targets.

**Step 3: Connect dashboard data**

Load `/api/dashboard` after authentication and render metric cards, upcoming lessons, work requiring attention, and recent activity. Each item must navigate to the relevant student/course.

**Step 4: Verify**

Run: `npm run check && npm run build`.

Expected: clean typecheck/build and all existing student/material flows remain reachable.

### Task 3: Student and course planning workspace

**Files:**
- Create: `src/features/students/StudentList.tsx`
- Create: `src/features/students/StudentOverview.tsx`
- Create: `src/features/courses/CourseQueue.tsx`
- Create: `src/features/courses/CourseComposer.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Step 1: Extract student roster and overview**

Preserve create/edit/delete behavior while improving search, hierarchy, empty states, and long-profile readability.

**Step 2: Reframe course creation as a guided flow**

Group inputs into 课程目标、学生依据、资料与生成设置. Preserve AI draft and manual creation paths, but give them one shared entry point and clear progress/state language.

**Step 3: Redesign the course queue**

Add today/upcoming/history groupings, status filters, and explicit next-action labels derived from existing course/job/post-class state.

**Step 4: Verify**

Run: `npm test && npm run check && npm run build`.

Expected: all existing operations compile and tests remain green.

### Task 4: Course execution, review, and delivery workspace

**Files:**
- Create: `src/features/courses/CourseWorkspace.tsx`
- Create: `src/features/courses/PreparationTimeline.tsx`
- Create: `src/features/courses/OutputReview.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Step 1: Extract course execution state**

Present queued/running/completed/failed states as a readable preparation timeline. Keep cancel, retry, continue, attachment, refinement, quality, and Feishu actions.

**Step 2: Build review-first output navigation**

Separate student deliverables, teacher notes, homework, and process files. Keep Markdown/PDF/image preview, new-window access, and quality findings linked to the relevant file.

**Step 3: Make the next action unambiguous**

Use a single primary action per state: start generation, continue failed run, review quality, send to Feishu, or confirm post-class summary.

**Step 4: Verify**

Run: `npm test && npm run check && npm run build && npm run smoke`.

Expected: isolated end-to-end smoke flow passes without writing production data.

### Task 5: Materials workspace redesign

**Files:**
- Create: `src/features/materials/MaterialsLibrary.tsx`
- Create: `src/features/materials/SearchResults.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Step 1: Extract library browser and search results**

Preserve upload, folder upload, reindex, conversion notice, preview, open, and delete. Add type/status filters and clearer indexed-question/snippet counts.

**Step 2: Improve retrieval explainability**

Display source type, difficulty, answer quality, matched tags, and score explanation without exposing raw internal scoring noise.

**Step 3: Verify**

Run: `npm run check && npm run build`.

Expected: material operations remain functional on desktop and mobile layouts.

### Task 6: Reusable lesson templates

**Files:**
- Create: `server/templates.test.ts`
- Create: `server/templates.ts`
- Modify: `server/store.ts`
- Modify: `server/index.ts`
- Modify: `server/types.ts`
- Modify: `src/types.ts`
- Create: `src/features/templates/TemplateManager.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing CRUD tests**

Cover create, update, list, delete, validation, and applying a template to a course draft.

**Step 2: Add backward-compatible persistence**

Store templates in application data using the repository's existing atomic JSON/store conventions. Templates contain course type, duration, textbook, lesson kind, reusable requirements, and prompt guidance; they never contain student private data.

**Step 3: Add authenticated CRUD endpoints and UI**

Expose `/api/templates` CRUD and allow applying a template from the course composer.

**Step 4: Verify**

Run: `npx tsx --test server/templates.test.ts && npm run check && npm run build`.

Expected: CRUD tests pass and templates can populate a new lesson without overwriting student-specific fields.

### Task 7: Output revisions and learning trends

**Files:**
- Create: `server/insights.test.ts`
- Create: `server/insights.ts`
- Modify: `server/index.ts`
- Modify: `server/types.ts`
- Modify: `src/types.ts`
- Create: `src/features/insights/InsightsPanel.tsx`
- Modify: `src/App.tsx`

**Step 1: Add failing trend tests**

Assert weekly lesson counts, completion rate, quality average, refine/retry rate, recurring weak points, and post-class confirmation rate.

**Step 2: Implement read-only insights aggregation**

Derive trends from existing courses, jobs, quality results, and confirmed post-class summaries. Avoid speculative AI scoring.

**Step 3: Add revision visibility**

Use existing job history and file timestamps to expose an output revision timeline; do not duplicate generated files in application data.

**Step 4: Verify**

Run: `npx tsx --test server/insights.test.ts && npm test && npm run check && npm run build`.

Expected: deterministic aggregation tests pass and revisions are reviewable from a course.

### Task 8: Responsive, accessibility, and production verification

**Files:**
- Modify: `src/styles.css`
- Modify: affected frontend components
- Modify: `README.md`

**Step 1: Verify keyboard and responsive behavior**

Check 1440px, 1024px, 768px, and 390px widths. Confirm no horizontal overflow, every icon-only control has an accessible name, focus is visible, dialogs/drawers restore focus, and reduced-motion preferences are respected.

**Step 2: Run full verification**

Run: `npm test && npm run check && npm run build && npm run deploy:check && npm run smoke`.

Expected: all checks pass.

**Step 3: Deploy safely**

Compare remote `main` status again, transfer only the reviewed commit, build on the remote host, restart `lesson-prep-web.service`, and verify `/api/health` plus browser flows through port 4178.

**Step 4: Visual sign-off**

Capture and inspect login, dashboard, student, course, materials, and mobile views. Fix visible defects before handoff.

