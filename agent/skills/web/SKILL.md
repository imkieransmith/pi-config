---
name: web
description: Search the web and read web pages as markdown. Use to look up documentation, current facts, versions, or anything online, and to read a URL (including images).
---

# Web

`web.py` sits next to this SKILL.md. Call it by its full path:

```bash
python3 /path/to/skills/web/web.py search "laravel 12 queue batching"
python3 /path/to/skills/web/web.py fetch https://laravel.com/docs/12.x/queues
```

- `search` prints numbered results: title, URL, and a short description. Fetch the best URLs to read them in full; descriptions alone are not enough to quote.
- `fetch` prints the page as markdown. For an image URL it saves the file and prints the path; open it with the read tool.
- Errors print one `Error:` line. On a 401, tell the user the Jina key in `~/.pi/.env` is missing or expired. Do not look for or print the key.
