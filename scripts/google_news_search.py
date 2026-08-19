#!/usr/bin/env python3
"""Busca notícias no Google sem chave, devolvendo JSON para o backend Node.

Entrada (stdin): {"query": "Silas Malafaia", "days": 30, "limit": 20}
Saída (stdout):  {"ok": true, "items": [...]}

Usa apenas a biblioteca padrão. O RSS é a fonte principal; a busca HTML de
notícias complementa com URLs diretas quando o RSS entrega redirects do Google.
"""

from __future__ import annotations

import email.utils
import html
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, OSError):
    pass


def clean_text(value: str | None) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def timestamp_ms(value: str | None) -> int:
    if not value:
        return 0
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (TypeError, ValueError, OverflowError):
        return 0


def fetch(url: str, timeout: int = 18) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml,text/xml,text/html,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(2_500_000)


def google_article_id(url: str) -> str:
    match = re.search(r"/articles/([^?/#]+)", url or "")
    return match.group(1) if match else ""


def decode_google_news_url(url: str) -> str:
    """Resolve the Google News article token through its batchexecute endpoint."""
    article_id = google_article_id(url)
    if not article_id:
        return url

    article_html = fetch(url, timeout=10).decode("utf-8", errors="replace")
    signature = re.search(r'data-n-a-sg="([^"]+)"', article_html)
    timestamp = re.search(r'data-n-a-ts="([^"]+)"', article_html)
    if not signature or not timestamp:
        return url

    request_data = [
        "garturlreq",
        [
            [
                "X",
                "X",
                ["X", "X"],
                None,
                None,
                1,
                1,
                "US:en",
                None,
                1,
                None,
                None,
                None,
                None,
                None,
                0,
                1,
            ],
            "X",
            "X",
            1,
            [1, 1, 1],
            1,
            1,
            None,
            0,
            0,
            None,
            0,
        ],
        article_id,
        int(timestamp.group(1)),
        signature.group(1),
    ]
    rpc = [[[
        "Fbv4je",
        json.dumps(request_data, ensure_ascii=False, separators=(",", ":")),
        None,
        "generic",
    ]]]
    body = urllib.parse.urlencode(
        {"f.req": json.dumps(rpc, ensure_ascii=False, separators=(",", ":"))}
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je",
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response_text = response.read(1_000_000).decode("utf-8", errors="replace")

    for line in response_text.splitlines():
        line = line.strip()
        if not line.startswith("[["):
            continue
        outer = json.loads(line)
        for entry in outer:
            if not isinstance(entry, list) or len(entry) < 3 or entry[0] != "wrb.fr":
                continue
            if not isinstance(entry[2], str):
                continue
            decoded = json.loads(entry[2])
            final_url = decoded[1] if isinstance(decoded, list) and len(decoded) > 1 else ""
            if isinstance(final_url, str) and final_url.startswith(("http://", "https://")):
                return final_url
    return url


def resolve_rss_urls(items: list[dict]) -> list[dict]:
    if not items:
        return items

    def resolve(item: dict) -> dict:
        try:
            final_url = decode_google_news_url(item.get("link") or "")
            if final_url and "news.google.com" not in final_url:
                return {**item, "link": final_url, "origem": "google-news-python-direto"}
        except Exception:
            pass
        return item

    with ThreadPoolExecutor(max_workers=min(10, len(items))) as executor:
        return list(executor.map(resolve, items))


def parse_rss(xml_data: bytes, cutoff_ms: int, limit: int) -> list[dict]:
    root = ET.fromstring(xml_data)
    output: list[dict] = []
    for item in root.findall(".//item"):
        title = clean_text(item.findtext("title"))
        link = clean_text(item.findtext("link"))
        description = clean_text(item.findtext("description"))
        pub_date = clean_text(item.findtext("pubDate"))
        published_ms = timestamp_ms(pub_date)
        source_node = item.find("source")
        source = clean_text(source_node.text if source_node is not None else "")
        if not title or not link:
            continue
        if cutoff_ms and published_ms and published_ms < cutoff_ms:
            continue
        if source and title.lower().endswith((" - " + source).lower()):
            title = title[: -(len(source) + 3)].strip()
        output.append(
            {
                "titulo": title,
                "link": link,
                "resumo": description[:700],
                "data": pub_date or None,
                "dataTimestamp": published_ms,
                "veiculo": source or "Google News",
                "origem": "google-news-python-rss",
            }
        )
        if len(output) >= limit:
            break
    return output


def normalize_google_href(value: str) -> str:
    href = html.unescape(value or "").strip()
    if href.startswith("/url?"):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        href = (query.get("q") or query.get("url") or [""])[0]
    if href.startswith("//"):
        href = "https:" + href
    if not href.startswith(("http://", "https://")):
        return ""
    host = (urllib.parse.urlsplit(href).hostname or "").lower()
    if host.endswith("google.com") or host.endswith("google.com.br"):
        return ""
    return href


class GoogleNewsHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchor_href = ""
        self.in_h3 = False
        self.h3_parts: list[str] = []
        self.items: list[dict] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        if tag == "a":
            self.anchor_href = normalize_google_href(attr_map.get("href") or "")
        elif tag == "h3" and self.anchor_href:
            self.in_h3 = True
            self.h3_parts = []

    def handle_data(self, data: str) -> None:
        if self.in_h3:
            self.h3_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "h3" and self.in_h3:
            title = clean_text(" ".join(self.h3_parts))
            if title and self.anchor_href:
                host = urllib.parse.urlsplit(self.anchor_href).hostname or "Web"
                self.items.append(
                    {
                        "titulo": title,
                        "link": self.anchor_href,
                        "resumo": title,
                        "data": None,
                        "dataTimestamp": 0,
                        "veiculo": host.removeprefix("www."),
                        "origem": "google-news-python-html",
                    }
                )
            self.in_h3 = False
            self.h3_parts = []
        elif tag == "a":
            self.anchor_href = ""


def search(
    query: str,
    days: int,
    limit: int,
    fixture_xml: str = "",
    fixture_html: str = "",
    include_web: bool = False,
) -> list[dict]:
    now = datetime.now(timezone.utc)
    after = (now - timedelta(days=days)).date().isoformat()
    before = (now + timedelta(days=1)).date().isoformat()
    dated_query = f'{query} after:{after} before:{before}'
    cutoff_ms = int((now - timedelta(days=days + 1)).timestamp() * 1000)

    rss_url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": dated_query, "hl": "pt-BR", "gl": "BR", "ceid": "BR:pt-419"}
    )
    html_url = "https://www.google.com/search?" + urllib.parse.urlencode(
        {"q": dated_query, "tbm": "nws", "hl": "pt-BR", "gl": "br", "num": min(limit, 30), "filter": "0"}
    )
    web_url = "https://www.google.com/search?" + urllib.parse.urlencode(
        {"q": dated_query, "hl": "pt-BR", "gl": "br", "num": min(limit, 30), "filter": "0"}
    )

    rss_items: list[dict] = []
    html_items: list[dict] = []
    web_items: list[dict] = []
    errors: list[str] = []
    try:
        rss_data = fixture_xml.encode("utf-8") if fixture_xml else fetch(rss_url)
        rss_items = parse_rss(rss_data, cutoff_ms, limit)
        if not fixture_xml:
            rss_items = resolve_rss_urls(rss_items)
    except Exception as exc:  # rede/XML: o HTML ainda pode funcionar
        errors.append(f"rss: {exc}")

    try:
        html_data = fixture_html.encode("utf-8") if fixture_html else fetch(html_url, timeout=10)
        parser = GoogleNewsHtmlParser()
        parser.feed(html_data.decode("utf-8", errors="replace"))
        html_items = parser.items
    except Exception as exc:
        errors.append(f"html: {exc}")

    # Portais locais e de nicho nem sempre entram no vertical Google Notícias.
    # Na rodada de resgate, consulta também o índice web comum.
    if include_web and not fixture_html:
        try:
            web_data = fetch(web_url, timeout=10)
            web_parser = GoogleNewsHtmlParser()
            web_parser.feed(web_data.decode("utf-8", errors="replace"))
            web_items = [
                {**item, "origem": "google-web-python-html"}
                for item in web_parser.items
            ]
        except Exception as exc:
            errors.append(f"web: {exc}")

    # URLs diretas primeiro; depois RSS para ampliar a cobertura.
    output: list[dict] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for item in [*html_items, *web_items, *rss_items]:
        url_key = item["link"].split("#", 1)[0].rstrip("/").lower()
        title_key = re.sub(r"\W+", " ", item["titulo"].lower()).strip()
        if url_key in seen_urls or title_key in seen_titles:
            continue
        seen_urls.add(url_key)
        seen_titles.add(title_key)
        output.append(item)
        if len(output) >= limit:
            break
    return output, errors


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        query = clean_text(payload.get("query"))[:180]
        days = max(1, min(int(payload.get("days") or 30), 365))
        limit = max(1, min(int(payload.get("limit") or 20), 40))
        if len(query) < 2:
            raise ValueError("consulta vazia")
        items, errors = search(
            query,
            days,
            limit,
            str(payload.get("fixture_xml") or ""),
            str(payload.get("fixture_html") or ""),
            bool(payload.get("includeWeb")),
        )
        print(json.dumps({"ok": True, "items": items, "errors": errors}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "items": [], "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
