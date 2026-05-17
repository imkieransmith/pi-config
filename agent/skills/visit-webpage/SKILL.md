---
name: visit-webpage
title: Visit Webpage
description: Visit a webpage and extract its content as markdown, or fetch images. Use for reading articles, documentation, or any web page content. Handles both HTML pages (via Jina Reader) and image URLs (downloads and saves locally).
---

# Visit Webpage

Fetch and extract readable content from web pages as markdown, or download images. Handles JavaScript-rendered content via Jina Reader service.

## Setup

Optionally set `JINA_API_KEY` in your shell environment for higher Jina Reader rate limits.

Without an API key, the service works with rate limits.

## Usage

```bash
python3 {baseDir}/visit.py <url>
```

When this skill is loaded, resolve `{baseDir}` to this skill directory:

```text
/Users/kieran/.pi/agent/skills/visit-webpage
```

## Examples

```bash
# Read an article (returns markdown)
python3 {baseDir}/visit.py https://example.com/article

# Fetch documentation
python3 {baseDir}/visit.py https://docs.python.org/3/library/asyncio.html

# Download an image (auto-detected by content-type)
python3 {baseDir}/visit.py https://example.com/image.png
# Then use read tool to view: read /tmp/visit-image-xxx.png
```

## Output

For **HTML pages**: Returns markdown content to stdout.

For **images**: Downloads the image to a temp file and prints the path. Use the `read` tool to view it. Supports PNG, JPEG, GIF, and WebP formats.

## Features

- Extracts main content from HTML pages
- Converts HTML to clean markdown
- Handles JavaScript-rendered pages via Jina Reader
- Auto-detects and downloads images to temp files
- Retries on rate limiting (HTTP 451)
- 5MB max image size limit

## Tips

- Do not pipe through `tee`/`sed` by default; Pi already truncates long command output and stores full output when needed.
- If you need to keep a copy of page markdown, redirect stdout to a `/tmp/*.md` file after confirming the command works.

## When to Use

- Reading articles, blog posts, or documentation
- Extracting content from search results
- Downloading images from URLs (then use `read` to view)
- Following links found during web search
