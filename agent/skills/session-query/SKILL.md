---
name: session-query
title: Session Query
description: Query previous sessions to retrieve context, decisions, code changes, or other information. Use when you need to search for context about past conversations and work.
disable-model-invocation: true
---

# Session Query

Query Pi session files to retrieve context from past conversations.

This skill is automatically invoked in handed-off sessions when you need to look up details from the parent session.

## Usage

Use the `session_query` tool:

```
session_query(sessionPath, question)
```

- `sessionPath`: Full path to the session file (provided in the "Parent session:" line)
- `question`: Specific question about that session (e.g., "What files were modified?" or "What approach was chosen?")
- `detailed`: Optional. Set `true` when you need exact tool output, exact file contents, or raw/custom session entry details.

The tool can search regular conversation messages and session metadata, including Evidence entries, ContextSnapshot captures and durable summaries, compaction summaries, branch summaries, and custom messages. Ask directly for these when needed.

## Examples

```
session_query("/path/to/session.jsonl", "What files were modified?")
session_query("/path/to/session.jsonl", "What approach was chosen for authentication?")
session_query("/path/to/session.jsonl", "Summarize the key decisions made")
session_query("/path/to/session.jsonl", "What Evidence entries or ContextSnapshot durable summaries were recorded?")
session_query("/path/to/session.jsonl", "What exact tool output mentioned the failing test?", detailed=true)
```

The tool loads the session and uses an LLM to answer your question based on its contents. Ask specific questions for best results.
