---
name: evidence-add
title: Add Evidence
description: Store evidence for retrieved or recalled factual claims about external reality before stating them. Triggers: snippets from web-search/visit-webpage, statements about real entities you did not observe in this session (people's roles, company facts, dates, prices, versions, statistics, current status), quotes or paraphrases of others' words, and recalled facts from documentation. Do NOT use for: descriptions of work you just performed (code changes, file edits, command output, anything visible in a diff or artifact), your own reasoning, recommendations, or design opinions; stable definitional knowledge ("Python is a language"); the user's own statements; or hypotheticals. The test: could the user verify this by reading something you just produced or did? If yes, no evidence needed. If they'd have to trust your word about the outside world, store evidence.
---

## When this fires

Evidence is required when the claim originates from outside the current session — retrieved from web search, a fetched page, a local file you read, or recalled from training. Specifically:

- Any snippet returned by `web-search` or `visit-webpage`.
- A name, date, number, version, price, or current status of a real entity.
- A claim starting with "according to", "as of", "currently", "recently".
- A quote or paraphrase of someone else's words.
- A recalled fact about a real library/API/standard that the user might rely on (e.g., "Vue 3.4 added X").

## When this does NOT fire

- **Descriptions of your own actions.** "I increased the shader brightness", "I extracted this into a helper", "the new flag defaults to true", "the function now returns a Promise". The user can read the diff or the file.
- **Reasoning, opinions, recommendations.** "I'd reach for a queue here" is your judgment, not a retrieved fact.
- **Stable definitional knowledge.** "Laravel is a PHP framework", "HTTPS encrypts traffic", "B-trees are balanced".
- **The user's own statements** repeated or built on.
- **Hypotheticals or examples** you invented to illustrate a point.

If a sentence describes something the user can verify by looking at the materials already in front of them, do not store evidence for it.

## Workflow

1. Retrieve fact (search / fetch / read file).
2. **Immediately** call EvidenceAdd, before your next tool call, before composing prose.
3. Before sending your final answer, call EvidenceList. For every claim in your draft that fires the trigger above, confirm a covering entry exists. If missing, retrieve and store, or remove the claim.
4. Cite inline with the returned ID: *"introduced in 1936 (e3a1f2)"*.

## Rules

- **Verbatim.** Snippet copied exactly from source. No paraphrasing or summarising.
- **Smallest span.** Just the sentence(s) that support the claim.
- **One entry per claim.** Three useful facts = three entries.
- **Claim-shaped note.** Write the note as an assertion ("X does Y"), not a topic label ("About X").

## Source format

| Origin       | Format                       |
| ------------ | ---------------------------- |
| Web page     | full URL                     |
| Local file   | `file:<path>`                |
| Bash output  | `bash:<description>`         |
| Tool result  | `tool:<ToolName>:<query>`    |

## Examples

**Good** — retrieved fact, smallest verbatim span:
```json
{
  "source": "https://example.com/article",
  "note": "Turing introduced the machine model in 1936.",
  "snippet": "In 1936, Alan Turing described an abstract machine capable of computing any computable function."
}
```

**Skip** — self-report of work done. The diff is the evidence:
> Claim: *"Speed-line shader visual defaults were increased for brighter, more visible lines."*
> Action: None. The user can read the change.

**Skip** — design recommendation, not a retrieved fact:
> Claim: *"Using a fixed timestep here will make the physics deterministic across machines."*
> Action: None. This is reasoning, not a citation-bearing claim.

**Bad** — paraphrased and far too long:
```json
{
  "note": "Turing stuff",
  "snippet": "So basically what happened was that Turing came up with this idea in the 1930s about a theoretical machine that could..."
}
```