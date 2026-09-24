# Pi config and extensions

This repo holds the Pi extensions, skills, and settings I use each day.

Some extensions began as other people's work; I link to their sources in the code. I keep most code here so I can review and change it myself. You may find parts useful for your own setup.

## Extensions

- **Advisor** (`advisor`): Get advice from the model set in `agent/settings.json`.
- **Ask User Question** (`ask-user-question`): Asks multiple-choice or free-text questions in the terminal.
- **Colour Messages** (`colour-messages`): Gives your messages, work, and final replies different backgrounds.
- **Confirm Destructive** (`confirm-destructive.ts`): Asks before Pi's write tool overwrites work git can't restore, or an edit removes a lot from an untracked file. Skips size-based prompts for edits to tracked files.
- **Context Snapshot** (`context/`): Saves comprehensive work notes, added to context after compaction.
- **Custom Footer** (`custom-footer`): Compact footer showing the path, context use, and model.
- **Evidence Store** (`evidence.ts`): Saves source snippets, finds repeats, and checks citations before final answers.
- **Herdr Agent State** (`herdr-agent-state.ts`): Reports agent state to herdr. Herdr writes this file; don't edit it by hand.
- **Landing Page** (`landing/`): Shows a light watercolour backdrop and a card with the commands, skills, and tools.
- **Meep** (`meep.ts`): Says meep when the model finishes.
- **Plan Command** (`plan.ts`): Starts the write-plan skill. Automatically used, or started with `/plan <request>`.
- **Redact Sensitive Data** (`redact.ts`): Masks known secrets in tool output.
- **Response Metrics** (`response-metrics.ts`): Shows time, tool calls, tokens, and the main model's output rate.
- **RTK Rewrite** (`rtk.ts`): Uses `rtk rewrite` to shorten some shell output.
- **Sandbox** (`shared/sandbox.ts`, used by `rtk.ts`): Runs the agent's bash commands in an OS sandbox through [sandbox-runtime](https://github.com/anthropics/sandbox-runtime). Home stays hidden except the project and tool folders, writes stay in the project and `/tmp`, and network access is limited to a short list of domains and localhost. The project's `.git` and `.env` are read-only, so agents can read history but not commit, reset, stash or push. Your own `!` commands run as normal. Linux needs `bubblewrap`, `socat`, and `ripgrep`.
- **Security Guard** (`security/`): Keeps Pi's own file tools (read, write, edit, grep, find, ls) away from secrets and private files. Bash is left to the sandbox.
- **Standalone Working** (`standalone-working.ts`): Shows working status above the input, not inside it.
- **Tool Pills** (`tool-pills`): Shows tool calls on one line; click to expand details/images. Optional: bash rows swap the command for a plain-English sentence if you set a `explain.model` in settings.
- **Web** (`web.ts`): Adds `web_search` and `web_fetch` through Jina. Search needs `JINA_API_KEY` in the environment or `~/.pi/.env`; fetch does not. Long pages go to `/tmp`.

## Skills

Skills live in `agent/skills/`. Agents load them when needed, for tasks such as saving evidence and writing plans.

## Install

If you use a checkout of this repo as your Pi config, run this from the repo root before starting Pi:

```bash
npm run setup
```

This adds missing keys from `agent/base-settings.json` to your local `agent/settings.json`. It keeps the values you already set.

You can also install the extensions directly:

```bash
pi install git:github.com/imkieransmith/pi-config
```

I recommend copying the parts you want into your own config and building on top of them instead. That's how this repo evolved in the first place, and it makes it much easier to fully understand, customise, and maintain your own setup long term.

## License

MIT. Source credits for code from other Pi users are in the relevant files.
