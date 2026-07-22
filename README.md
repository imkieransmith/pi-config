# Pi config and extensions
This repo is my personal Pi coding agent setup. It’s a collection of custom extensions, tools, skills, and configuration I use day to day.

A number of the extensions originally started from work shared by other Pi users. Where that’s the case, I’ve linked back to the original extension in the relevant source file comments. From there I’ve usually tweaked, combined, or rewritten parts to better fit my own workflow, preferences, and local setup.

Most packages/extensions are copied into this repo and built on directly rather than pulled in as dependencies. That keeps everything self-contained, means I only have to properly audit the code once, lets me customise things freely, and avoids worrying about upstream changes or security surprises later.

The code here is intended as a working personal config rather than a polished package, but it may still be useful to you as a reference if you’re building or adapting your own Pi extensions.

## What this repo contains
This repo is a personal Pi setup: agent-facing extensions, skills, and UI helpers that are loaded into Pi sessions.

### Extensions
- **Advisor** (`advisor`) — Code-configured, model-driven cross-family review with capability-aware usage: exceptional peer review for frontier models, gated senior review for strong models, and routine stronger review for standard models. `/advisor status` and `/advisor debug` expose diagnostics; there is no runtime picker.
- **Ask User Question** (`ask-user-question`) — Interactive multiple-choice clarification tool for agents.
- **Colour Messages** (`colour-messages`) — Background colours for user, working, and final assistant rows.
- **Confirm Destructive** (`confirm-destructive.ts`) — Confirm destructive tool calls and bash commands before they run.
- **Context Snapshot** (`context.ts`) — Append-only durable work captures with a bounded recent-summary appendix added after Pi compacts.
- **Custom Footer** (`custom-footer`) — Compact powerline-style footer with path, context, and model info.
- **Evidence Store** (`evidence.ts`) — Validated durable snippets with deduplication, paginated discovery, exact final-citation verification, and TUI-only proof.
- **Meep** (`meep.ts`) — Says meep when the model is done working.
- **Plan Command** (`plan.ts`) — Deterministic `/plan` handoff that manages ContextSnapshot captures.
- **Redact Sensitive Data** (`redact.ts`) — Redact secrets from tool output.
- **Resource Overview** (`resource-overview.ts`) — Richer startup overview for loaded skills and extensions.
- **Response Metrics** (`response-metrics.ts`) — Persistent TUI-only elapsed-time, tool-call, and input/output-token row beneath each completed response.
- **RTK Rewrite** (`rtk.ts`) — Best-effort shell command optimization via `rtk rewrite`.
- **Security Guard** (`security.ts`) — Confirms or blocks risky commands and sensitive file access.
- **Session Query** (`session-query.ts`) — Query previous sessions, including custom state and summaries.
- **Superset Hooks** (`superset-hooks.ts`) — Emit Superset lifecycle hooks so the host shows a working indicator.
- **Tool Pills** (`tool-pills`) — Compact colored tool call/result rendering and syntax-highlighted diffs.

### Skills
Skills live under `agent/skills/` and provide task-specific instructions that agents load on demand, such as evidence capture, web search/page reading, and structured planning.

## Install
```bash
pi install git:github.com/imkieransmith/pi-config
```

You can install it directly like this, but I'd recommend copying the parts you want into your own config and building on top of them instead. That’s how this repo evolved in the first place, and it makes it much easier to fully understand, customise, and maintain your own setup long term.

## License
MIT. Attribution for code that originally came from other Pi users is linked in the relevant source files where applicable.