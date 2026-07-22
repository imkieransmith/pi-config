---
name: write-plan
title: Write Plan
description: Structured planning workflow for substantive coding work. Use at the start of every new major feature, non-trivial bug fix, refactor, or implementation request. Do not use this skill for trivial work, tweaks, or quick-win changes.
---

# Plan-First Workflow

## Rules

- NEVER write code, create files, or run mutating commands before a TODO.md is approved.
- Read-only inspection commands are allowed before approval when they are needed to understand the project.
- NEVER assume critical missing implementation information. Ask instead.
- NEVER skip steps. Follow phases in order.
- NEVER go off-plan. If new work is discovered, add it to TODO.md and ask for approval before doing it.
- Skip this workflow for trivial changes where the plan overhead would exceed the work, such as single-character fixes, comment typos, or one-line formatting.

---

### Phase 0 - Context preservation with ContextSnapshot
At the start of each new piece of work, preserve context with ContextSnapshot:
  1. Check `ContextSnapshot` status.
  2. If a capture is active, call `ContextSnapshot finish` first with a structured durable summary of the completed/previous work. A good finish summary should cover: (1) the goal or question being investigated, (2) key facts discovered and decisions made, (3) files touched or inspected and why, and (4) outstanding questions, risks, or next steps. Pass `force: true` if changes were observed, and make sure the summary accounts for those mutations.
  3. Then call `ContextSnapshot start` with a specific descriptive label for the new work before Phase 1. Use labels like `auth-token-refresh-race`, not generic labels like `bug-fix` or `investigation`.
- At the end of completed work, call `ContextSnapshot finish` with a final durable summary and `force: true` before declaring completion. Phase 5 almost always causes the capture to observe changes.

Durable finish summaries must include:
- Goal: what the previous work was trying to accomplish.
- Key facts: important discoveries, decisions, constraints, and errors.
- Files: paths plus specific line numbers, function names, or symbols that future work may need to revisit. The Files section is a map back to the code, not just a list of what was opened.
- Outstanding: open questions, risks, blockers, and next steps.

Example durable finish summary:

```
Goal: Fix race in token refresh on cache miss.
Key facts: Two concurrent API calls missing cache fire two refresh requests; needs mutex around TokenStore.refresh().
Files:
  - src/auth/TokenStore.ts:147 - refresh() needs locking
  - src/auth/middleware.ts:34 - call site that surfaces the race
  - tests/auth/TokenStore.test.ts:89 - added concurrency test
Outstanding: Integration tests use a mock that doesn't reproduce the race; verify behaviour against the real client before closing.
```

---

## Phase 1 - Analyze the Project

Read the project silently before asking anything. Use read-only commands and file reads only. Check:

1. Directory structure (top 2 levels)
2. `package.json`, `pubspec.yaml`, `go.mod`, `requirements.txt`, `Cargo.toml`, `pom.xml`, or equivalent
3. Existing dependencies and their versions
4. Build system and scripts (`Makefile`, `scripts/`, CI config)
5. `README.md` or `README.*`
6. Any existing `TODO.md`, `TASKS.md`, `.todo`, or open issue files
7. The project's verification commands - production build, test suites, typecheck, lint, etc.

Do not output analysis results unless directly relevant to your questions.

---

## Phase 2 - Ask Clarifying Questions (One Round Only)

After analysis, identify gaps that would block correct implementation.

- Ask **at most 5 questions** in a single message.
- Only ask what is **critical and cannot be inferred** from the codebase.
- Number the questions.
- Do not ask about things already answerable from the project files.
- Do not split into multiple rounds - this is your only chance to ask.

Example format:

```
Before I create the plan, I need a few things clarified:

1. Should the new endpoint require authentication?
2. Is there a preferred database (the project has both SQLite and Postgres configs)?
3. Should existing tests be updated, or only new ones added?
```

Wait for the user's response before proceeding.

---

## Phase 3 - Create TODO.md

Using the analysis and the user's answers, write a `TODO.md` file in the project root.

### TODO.md Structure

```markdown
# TODO

## Goal
One sentence describing what will be built or fixed.

## Verification Commands
The project's verification checks, discovered in analysis.

## Tasks

### 1. <Phase Name>
- [ ] <Concrete, measurable action>
- [ ] <Concrete, measurable action>

- [ ] <Paths and files likely to be touched during this phase (expected scope, not a hard limit)>
- [ ] <Verification checks that should be ran to prove the completeness of this phase>

### 2. <Phase Name>
- [ ] <Concrete, measurable action>
- [ ] <Concrete, measurable action>

- [ ] <Paths and files likely to be touched during this phase (expected scope, not a hard limit)>
- [ ] <Verification checks that should be ran to prove the completeness of this phase>

## Notes
Any constraints, decisions, or known risks recorded here.
```

### Requirements

- Tasks must be **small and independently verifiable** (one logical change each).
- Order tasks by **dependency** (prerequisites first).
- Each task must be checkable as done/not done.
- No vague items like "fix things" or "improve code".
- Every phase should have verification commands that would actually catch a task's failure.
- Docs-only or config-only tasks may state no verification checks, with a one-line justification.

After writing the file, give the user a summary describing the plan, the thinking, and the intent behind it, and ask for confirmation to start or for any plan amends.

---

## Phase 4 - Revision Loop (if needed)

If the user requests changes:

1. Ask targeted follow-up questions to resolve the disagreement.
2. Rewrite `TODO.md`.
3. Summarise the updated plan again and ask for approval again.

Repeat until the user approves.

---

## Phase 5 - Execute the Plan

Once approved:

1. Work through tasks **in order**, one at a time.
2. After completing each task, mark it done in `TODO.md`:
   - Change `- [ ]` to `- [x]`
3. State which task you are starting before you begin it.
4. Do not start the next task until the current one is complete.
5. Do not perform any work not listed in `TODO.md`.
6. Any work required to make the verification checks of a phase pass is considered in-scope, a part of that phase.
7. Never weaken, skip, or substitute a verification command. If a verification command cannot run for infrastructure reasons (missing tooling, broken runner, environment problem), stop and report it to the user.
8. If the same phase verification commands fail after two fix attempts, call the advisor before attempting a third.

If you discover that an unlisted task is required:
- Stop.
- Add it to `TODO.md` under a `## Discovered Tasks` section.
- Tell the user what was found and why it is needed.
- Ask for approval before continuing.

## Phase 6 - Completion
When all tasks are marked `[x]`:

1. Run the full project verification checks. Per-task checks can all pass while a later task breaks what an earlier one verified; this final gate catches drift.
2. If any command fails, treat the failure as a Discovered Task.
3. Call `ContextSnapshot finish` with a durable summary covering Goal, Key facts, Files with line numbers/functions/symbols, and Outstanding. A good finish summary should cover: (1) the goal or question being investigated, (2) key facts discovered and decisions made, (3) files touched or inspected and why, and (4) outstanding questions, risks, or next steps.
4. Pass `force: true` because execution will have caused the capture to observe changes.
5. Then tell the user: `All tasks in TODO.md are complete.`

---

Do not skip Phase 0. The capture's durable summary is what survives compaction; without it, the previous work is preserved only in raw chat history that may be collapsed later.

Do not skip Phase 6. Finishing the capture with a durable summary is what preserves the context of the current completed work for future reference.