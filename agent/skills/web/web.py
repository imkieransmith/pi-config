#!/usr/bin/env python3
"""Search the web or fetch a page as markdown, using Jina (jina.ai)."""

import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

ENV_FILE = Path.home() / ".pi" / ".env"
TIMEOUT = 60
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
USAGE = 'Usage: web.py search "query"  |  web.py fetch <url>'


def jina_key() -> str | None:
    if os.environ.get("JINA_API_KEY"):
        return os.environ["JINA_API_KEY"]
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "JINA_API_KEY":
                return value.strip().strip("\"'")
    return None


def request(url: str, headers: dict[str, str] | None = None, method: str = "GET"):
    return urllib.request.urlopen(
        urllib.request.Request(url, method=method, headers={"User-Agent": "pi-web/1.0", **(headers or {})}),
        timeout=TIMEOUT,
    )


def jina_headers(**extra: str) -> dict[str, str]:
    key = jina_key()
    return {**extra, **({"Authorization": f"Bearer {key}"} if key else {})}


def search(query: str) -> None:
    if not jina_key():
        sys.exit(f"Error: search needs JINA_API_KEY in the environment or {ENV_FILE}")
    url = "https://s.jina.ai/?q=" + urllib.parse.quote(query)
    with request(url, jina_headers(Accept="application/json", **{"X-Respond-With": "no-content"})) as response:
        results = json.load(response).get("data") or []
    if not results:
        print("No results. Try a different query.")
    for n, result in enumerate(results, 1):
        print(f"{n}. {result.get('title', '').strip()}\n   {result.get('url', '')}")
        if result.get("description"):
            print(f"   {result['description'].strip()}")
        print()


def content_type(url: str) -> str:
    try:
        with request(url, method="HEAD") as response:
            return response.headers.get_content_type()
    except (HTTPError, URLError):
        return ""  # Some servers refuse HEAD; let Jina handle it.


def fetch(url: str) -> None:
    if not url.startswith(("http://", "https://")):
        sys.exit("Error: URL must start with http:// or https://")
    kind = content_type(url)
    if kind in IMAGE_TYPES:
        with request(url) as response:
            data = response.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            sys.exit("Error: image is over 5MB")
        fd, path = tempfile.mkstemp(prefix="web-image-", suffix=IMAGE_TYPES[kind])
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        print(f"Saved image to {path}. View it with the read tool.")
        return
    with request("https://r.jina.ai/" + url, jina_headers()) as response:
        print(response.read().decode("utf-8", errors="replace").strip())


def main() -> None:
    command, arg = (sys.argv[1], " ".join(sys.argv[2:])) if len(sys.argv) > 2 else (None, None)
    if command not in ("search", "fetch"):
        sys.exit(USAGE)
    try:
        search(arg) if command == "search" else fetch(arg)
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:300].strip()
        sys.exit(f"Error: HTTP {error.code} {error.reason}. {body}")
    except (URLError, TimeoutError) as error:
        sys.exit(f"Error: {getattr(error, 'reason', error)}")


if __name__ == "__main__":
    main()
