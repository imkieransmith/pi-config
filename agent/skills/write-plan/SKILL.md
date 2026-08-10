---
name: write-plan
title: Write Plan
description: Creates an approval-gated TODO.md for substantial coding work. Use when the user explicitly requests a formal plan, or when a new body of work is large, risky, architecturally significant, spans multiple systems, or has materially uncertain scope. Do not restart planning for routine follow-ups, small additions, straightforward fixes, or work already covered by an approved plan unless its scope materially changes.
---

# Plan-First Workflow

Use this workflow to agree on the intent and boundaries of substantial work before implementation. The plan is a contract around outcomes and scope, not a script for every edit or command.

## When to Use

Use this skill when the user explicitly requests it, or when a new body of work is large, risky, long-running, spans multiple systems, involves consequential decisions, or has materially uncertain scope.

Normally skip it for routine follow-ups, tweaks, small additions, straightforward local fixes, and work already covered by an approved plan. Do not restart the workflow merely because the user sends another implementation request. Amend the existing plan when needed; create a new one only for distinct or materially expanded work.

## Core Contract

- Before approval, inspect read-only and create or revise `TODO.md`; do not change implementation, dependencies, generated artifacts, external services, or other project state.
- The approved plan defines intended scope and outcomes, not every edit required to achieve them.
- Make clearly necessary incidental changes without approval, including imports, types, fixtures, helpers, test setup, and closely related verification fixes.
- Stop for approval when discovered work would materially change scope, architecture, behaviour, dependencies, risk, data handling, deployment, or user-visible requirements.
- Ask whenever critical information cannot be safely inferred, including during implementation.
- Use judgment about execution order, keep `TODO.md` representative of meaningful progress, and complete targeted plus final verification.

## Context Preservation

Start a `ContextSnapshot` before substantial investigation. Finish an active capture first only when it represents different work; reuse it for the same body of work and minor follow-ups.

At completion, finish the capture with a durable summary containing:

- **Goal:** intended outcome.
- **Key facts:** discoveries, decisions, constraints, and errors.
- **Files:** relevant paths plus useful functions, symbols, or locations.
- **Outstanding:** questions, risks, blockers, and next steps.

Use `force: true` when changes were observed. Keep the capture active while approved work remains pending unless the user requested planning only or abandons the work.

## 1. Investigate

Inspect enough relevant code and project configuration to understand:

- Architecture, existing implementation, conventions, and established patterns.
- Dependencies, integration points, and likely affected systems.
- Available build, test, typecheck, lint, and other verification commands.
- Existing plans, task files, and constraints relevant to the request.

Prefer targeted inspection over mechanically reading unrelated files. Use read-only commands and report analysis only when it explains a decision, question, or risk.

## 2. Clarify When Needed

Ask only questions that could materially affect correctness or the plan and cannot be inferred from the repository or request. Batch related questions when practical, but impose no fixed count or one-round limit. Ask later if a consequential ambiguity emerges; otherwise proceed directly to planning.

## 3. Create and Approve the Plan

Create or update `TODO.md` in the project root. Preserve unrelated content; ask before replacing a file that clearly serves another workflow.

```markdown
# TODO

## Goal

<Concise intended outcome>

## Verification

- `<full-project verification command>`

## Tasks

### 1. <Meaningful phase or outcome>

<What this phase accomplishes>

Expected scope:

- `path/to/relevant-file`

Actions:

- [ ] <Concrete, measurable action>
- [ ] <Concrete, measurable action>

Verify:

- `<targeted verification command>`

## Notes

- <Constraint, decision, assumption, or known risk>
```

Plan requirements:

- Use checkboxes only for meaningful actions, not scope or verification labels.
- Make actions concrete and checkable; organise phases by real dependencies without requiring serial execution.
- Treat expected paths as guidance, not an allowlist.
- Include checks likely to catch each phase's failures. If no automated check applies, record a manual check or a brief reason.
- Record consequential decisions, assumptions, constraints, and risks.

Summarise the outcome, major phases, verification strategy, and consequential decisions, then ask for approval or amendments. Do not implement before clear approval.

Revise the same plan when requested. Ask follow-up questions only where needed and seek renewed approval when revisions materially change agreed intent or boundaries. A clear minor adjustment from the user does not require a new planning cycle.

## 4. Execute Adaptively

After approval:

- Respect real dependencies, but combine or reorder related actions when safer or more efficient; implementation and tests may proceed together.
- Mark meaningful actions complete and add material discoveries so `TODO.md` remains accurate.
- Incorporate clear incremental user follow-ups without restarting the workflow unless they materially expand or conflict with scope.
- Make incidental supporting edits without treating each as a discovered task.

Pause only when a discovery crosses the material-change boundary in the Core Contract. Explain what changed, why it matters, and how the plan should be amended.

Run targeted checks at useful points. Never silently weaken or skip a planned check, or present a substitute as equivalent. If tooling, infrastructure, credentials, or environment issues block it, run unaffected checks and report the limitation distinctly. After two genuine failed fix attempts for the same problem, call the advisor before a third approach.

## 5. Complete and Verify

1. Run the appropriate full-project checks recorded in the plan.
2. Fix ordinary regressions within the approved outcome; seek approval only for materially broader fixes.
3. Update `TODO.md` to reflect completed work and unresolved items.
4. Finish `ContextSnapshot` using the durable-summary requirements above.
5. Report the outcome, verification results, and remaining risks or blockers concisely.

Do not claim completion when required verification is failing or was not run. Distinguish code failures from infrastructure or environment limitations.
