# Memory Management & Multi-Turn State Control Plan

> Goal: strengthen the AI-prep product with AIPM-relevant memory management and multi-turn state control, while preserving the existing teacher cockpit.

## Product framing

- **Memory management**: turn long-term context into structured, searchable, controllable assets. Student profiles, teacher preferences, teaching insights, preparation requirements, and notes become typed memory entries that can be pinned, enabled/disabled, tagged, edited, and automatically injected into AI prompts.
- **Multi-turn state control**: persist conversation and task state server-side per student/course. Each turn keeps user instruction, AI reply, current step, draft log path, job/course id, and quality status; supports create/reset/complete/append and cross-device recovery.

## Implementation

### Backend
- `server/types.ts`: add `MemoryEntry` and `Conversation`/`ConversationTurn` types plus `Db.memories`/`Db.conversations`.
- `server/store.ts`: persist new arrays, add CRUD/cascade delete helpers.
- `server/memory.ts`: memory CRUD/filtering and prompt-section builder.
- `server/conversations.ts`: conversation state-machine helpers and turn recording.
- `server/index.ts`: authenticated `/api/memories*` and `/api/conversations*` routes; AI-draft endpoints now record turns and pass memory context into the draft prompt.
- `server/jobs.ts`: staged and un-staged lesson prompts include active memory entries.

### Frontend
- `src/features/memory/MemoryPanel.tsx`: memory management panel and multi-turn state panel.
- `src/App.tsx`: add both panels to the student workspace.
- `src/styles.css`: panel styles.

## Verification
- New unit tests for memory CRUD/prompt filtering and conversation state machine.
- Existing dashboard/insights/store fixtures updated for new Db arrays.
- Run `npm run check`, `npm test`, `npm run build`, then deploy and verify health.

## AIPM alignment
- State machine design, memory/context management, human-in-the-loop control, traceable sources, and data-driven improvement are core AIPM competencies demonstrated by this feature.
