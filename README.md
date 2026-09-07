# Pi config and extensions
This repo is my personal Pi coding agent setup. It’s a collection of custom extensions, tools, skills, and configuration I use day to day.

A number of the extensions originally started from work shared by other Pi users. Where that’s the case, I’ve linked back to the original extension in the relevant source file comments. From there I’ve usually tweaked, combined, or rewritten parts to better fit my own workflow, preferences, and local setup.

Most packages/extensions are copied into this repo and built on directly rather than pulled in as dependencies. That keeps everything self-contained, means I only have to properly audit the code once, lets me customise things freely, and avoids worrying about upstream changes or security surprises later.

The code here is intended as a working personal config rather than a polished package, but it may still be useful to you as a reference if you’re building or adapting your own Pi extensions.

## What this repo contains
This repo is a personal Pi setup: agent-facing extensions, skills, and UI helpers that are loaded into Pi sessions.

### Extensions
- **Advisor** (`advisor`) — One consultation tool with a required brief, a fixed GPT-6-Astra reviewer, and one usage policy. It receives a bounded snapshot of recent work; `/advisor status` and `/advisor debug` expose diagnostics.
- **Ask User Question** (`ask-user-question`) — TUI-only multiple-choice and free-text questions. Long headers are accepted and shortened for display.
- **Colour Messages** (`colour-messages`) — Background colours for user, working, and final assistant rows.
- **Confirm Destructive** (`confirm-destructive.ts`) — Confirm destructive tool calls and bash commands before they run.
- **Context Snapshot** (`context/`) — Append-only durable work captures with a bounded, freshly replaced recent-summary appendix after Pi compacts.
- **Custom Footer** (`custom-footer`) — One line with path, context and model info. Advisor status stays hidden unless unavailable; warnings appear inline.
- **Evidence Store** (`evidence.ts`) — Validated durable snippets with deduplication, paginated discovery, exact final-citation verification, and TUI-only proof.
- **Meep** (`meep.ts`) — Says meep when the model is done working.
- **Plan Command** (`plan.ts`) — `/plan <request>` expands the write-plan skill. The skill handles captures; the command never force-closes them.
- **Redact Sensitive Data** (`redact.ts`) — Redact secrets from tool output.
- **Resource Overview** (`resource-overview.ts`) — Startup overview of actual available commands, skills and active tools.
- **Response Metrics** (`response-metrics.ts`) — Persistent TUI-only elapsed time, tool count, input/output tokens and estimated main-model output tokens/sec. The rate includes request latency but excludes tools, user waits and advisor calls; it uses reported output tokens, not just visible text.
- **RTK Rewrite** (`rtk.ts`) — Best-effort shell command optimization via `rtk rewrite`.
- **Security Guard** (`security/`) — Confirms or blocks risky commands and sensitive file access.
- **Superset Hooks** (`superset-hooks.ts`) — Emit Superset lifecycle hooks so the host shows a working indicator.
- **Tool Pills** (`tool-pills`) — Compact tool rendering, native edit diffs and bounded write previews.

### Skills
Skills live under `agent/skills/` and provide task-specific instructions that agents load on demand, such as evidence capture, web search/page reading, and structured planning.

## Install
```bash
pi install git:github.com/imkieransmith/pi-config
```

You can install it directly like this, but I'd recommend copying the parts you want into your own config and building on top of them instead. That’s how this repo evolved in the first place, and it makes it much easier to fully understand, customise, and maintain your own setup long term.

## License
MIT. Attribution for code that originally came from other Pi users is linked in the relevant source files where applicable.