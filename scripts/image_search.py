#!/usr/bin/env python3
"""Busca imagens no Bing sem chave e devolve JSON para o ViralizeAI.

Entrada: {"query": "Davi Miranda Filho", "limit": 12}
Saída:   {"ok": true, "items": [{"url", "thumbnail", "titulo", "link"}]}

É um complemento gratuito ao Brave Images. Não baixa nem republica imagens:
apenas retorna URLs para o editor escolher na tela.
"""

from __future__ import annotations

import html
import json
import re
import sys
import urllib.parse
import urllib.request


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def decode(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except (json.JSONDecodeError, TypeError):
        return html.unescape(str(value or "").replace("\\/", "/"))


def valid_url(value: str) -> bool:
    return value.startswith(("https://", "http://"))


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}
    query = re.sub(r"\s+", " ", str(payload.get("query") or "")).strip()[:160]
    limit = max(1, min(int(payload.get("limit") or 12), 30))
    if len(query) < 2:
        print(json.dumps({"ok": True, "items": []}, ensure_ascii=False))
        return

    url = "https://www.bing.com/images/search?" + urllib.parse.urlencode(
        {"q": query, "form": "HDRSC2", "first": "1", "tsc": "ImageBasicHover"}
    )
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            page = response.read(4_000_000).decode("utf-8", errors="replace")
    except Exception as exc:  # a busca principal continua funcionando
        print(json.dumps({"ok": False, "items": [], "error": str(exc)[:220]}, ensure_ascii=False))
        return

    # O Bing inclui metadados JSON em atributos m. murl é a imagem original;
    # turl é a miniatura segura para exibir no editor.
    items = []
    seen = set()
    for raw in re.findall(r'"murl"\s*:\s*"((?:\\.|[^"\\])*)"', page):
        image_url = decode(raw)
        if not valid_url(image_url) or image_url in seen:
            continue
        start = max(0, page.find(raw) - 1800)
        chunk = page[start : page.find(raw) + 2600]
        thumb_match = re.search(r'"turl"\s*:\s*"((?:\\.|[^"\\])*)"', chunk)
        title_match = re.search(r'"t"\s*:\s*"((?:\\.|[^"\\])*)"', chunk)
        page_match = re.search(r'"purl"\s*:\s*"((?:\\.|[^"\\])*)"', chunk)
        seen.add(image_url)
        items.append(
            {
                "url": image_url,
                "thumbnail": decode(thumb_match.group(1)) if thumb_match else image_url,
                "titulo": decode(title_match.group(1)) if title_match else query,
                "link": decode(page_match.group(1)) if page_match else None,
            }
        )
        if len(items) >= limit:
            break
    print(json.dumps({"ok": True, "items": items}, ensure_ascii=False))


if __name__ == "__main__":
    main()
