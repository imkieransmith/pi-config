---
name: evidence-add
title: Add Evidence
description: Use this skill any time you are about to state a non-trivial fact in a response — especially after web search, web page fetch, or any other retrieval. Triggers include results from web-search/visit-webpage, claims about real people/companies/events/products, dates, numbers, statistics, prices, versions, quotes, attributions, current state ("who is the CEO of…", "what does X cost"), and anything you just looked up in docs or files. Every such claim must be backed by a stored evidence entry before it appears in your final answer. Do NOT use for stable training-data knowledge with no recency dependence (e.g., "Python is a programming language"), the user's own statements, or hypotheticals.
---

## When this fires

If any of these appear in your draft, you MUST have evidence stored first:
- Anything from a `web-search` snippet or `visit-webpage` page.
- A name, date, number, version, price, or current status of a real entity.
- A claim starting with "according to", "as of", "currently", "recently".
- A quote or paraphrase of someone else's words.
- Anything you'd add a citation to in writing.

If unsure whether something counts, store it. Cheap to add, expensive to skip.

## Workflow

1. Retrieve fact (search / fetch / read file / run command).
2. **Immediately** call EvidenceAdd, before your next tool call, before composing prose.
3. Before sending your final answer, call EvidenceList. For every claim in your draft, confirm a covering entry exists. If a claim has no entry, either retrieve and store it now, or remove the claim.
4. Cite inline with the returned ID: *"introduced in 1936 (e3a1f2)"*.

## Rules

- **Verbatim.** Snippet copied exactly from source. No paraphrasing or summarising.
- **Smallest span.** Just the sentence(s) that support the claim.
- **One entry per claim.** Three useful facts = three entries.
- **Claim-shaped note.** Write the note as an assertion ("X does Y"), not a topic label ("About X").

## Source format

| Origin | Format |
|---|---|
| Web page | full URL |
| Local file | `file:<path>` |
| Bash output | `bash:<description>` |
| Tool result | `tool:<ToolName>:<query>` |

## Examples

**Good** — smallest verbatim span, one claim:
```json
{
  "source": "https://example.com/article",
  "note": "Turing introduced the machine model in 1936.",
  "snippet": "In 1936, Alan Turing described an abstract machine capable of computing any computable function."
}
```

**Bad** — snippet is a paraphrase and far too long:
```json
{
  "note": "Turing stuff",
  "snippet": "So basically what happened was that Turing came up with this idea in the 1930s about a theoretical machine that could..."
}
```