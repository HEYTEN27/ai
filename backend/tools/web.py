"""
Поиск в интернете и чтение веб-страниц — единственное, что выходит в сеть.

Поиск:
  * DuckDuckGo (по умолчанию) — без ключей и регистрации, через HTML-версию сайта;
  * SearXNG — если у вас запущен свой поисковый агрегатор (адрес в настройках).

Чтение страницы (open_url) защищено от SSRF: модель (или вредная страница, которую
она прочитала) могла бы попросить открыть http://127.0.0.1:11434/... — то есть
обратиться к Ollama или к самому ассистенту изнутри вашего компьютера. Поэтому
адреса localhost и домашней сети (192.168.*, 10.*, ...) запрещены.
"""

import asyncio
import ipaddress
import re
import socket
from html import unescape
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urlparse

import httpx

TIMEOUT = httpx.Timeout(15.0, connect=8.0)
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAssistant/1.0"}
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_PAGE_CHARS = 8_000


class WebError(Exception):
    pass


# ---------- поиск ----------


def _clean(html: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", html))).strip()


def parse_duckduckgo(html: str, limit: int) -> list[dict]:
    """Разбирает результаты из HTML-версии DuckDuckGo."""
    results = []
    blocks = re.split(r'<div[^>]+class="[^"]*\bresult\b[^"]*"', html)[1:]
    for block in blocks:
        link = re.search(r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block, re.DOTALL)
        if not link:
            continue
        href = unescape(link.group(1))
        # Ссылки ведут через редирект //duckduckgo.com/l/?uddg=<настоящий адрес>
        if "uddg=" in href:
            href = unquote(parse_qs(urlparse(href).query).get("uddg", [href])[0])
        if href.startswith("//"):
            href = "https:" + href
        if "duckduckgo.com/y.js" in href:  # рекламный блок
            continue
        snippet = re.search(r'class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|div|td)>', block, re.DOTALL)
        results.append({"title": _clean(link.group(2)), "url": href, "snippet": _clean(snippet.group(1)) if snippet else ""})
        if len(results) >= limit:
            break
    return results


async def search(query: str, *, provider: str = "duckduckgo", searxng_url: str = "", limit: int = 5,
                 transport=None) -> list[dict]:
    query = query.strip()
    if not query:
        raise WebError("Пустой поисковый запрос")
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS, transport=transport, follow_redirects=True) as client:
        try:
            if provider == "searxng":
                if not searxng_url:
                    raise WebError("Не указан адрес SearXNG (Настройки → Инструменты)")
                r = await client.get(f"{searxng_url.rstrip('/')}/search", params={"q": query, "format": "json"})
                r.raise_for_status()
                return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("content", "")}
                        for x in r.json().get("results", [])[:limit]]
            r = await client.post("https://html.duckduckgo.com/html/", data={"q": query, "kl": "ru-ru"})
            r.raise_for_status()
            return parse_duckduckgo(r.text, limit)
        except httpx.HTTPError as e:
            raise WebError(f"Поиск недоступен: {e.__class__.__name__}. Проверьте подключение к интернету.") from e


# ---------- чтение страницы ----------


class _TextExtractor(HTMLParser):
    """Достаёт из HTML заголовок и видимый текст (без скриптов, стилей, меню)."""

    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "pre"}

    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)

    def text(self) -> str:
        text = re.sub(r"[ \t]+", " ", "".join(self.parts))
        return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def _is_public_host(host: str) -> bool:
    """True, если ВСЕ адреса хоста — публичные (не localhost и не домашняя сеть)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


async def check_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise WebError("Можно открывать только адреса http:// и https://")
    if not await asyncio.to_thread(_is_public_host, parsed.hostname):
        raise WebError("Адреса этого компьютера и домашней сети открывать нельзя (защита от SSRF)")
    return parsed.geturl()


async def open_url(url: str, *, transport=None, skip_host_check: bool = False) -> dict:
    url = url.strip() if skip_host_check else await check_url(url)
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS, transport=transport, follow_redirects=False) as client:
        try:
            # Редиректы проходим вручную, проверяя каждый адрес: иначе публичный сайт
            # мог бы перенаправить на http://127.0.0.1/...
            for _ in range(5):
                async with client.stream("GET", url) as r:
                    if r.is_redirect:
                        url = str(r.url.join(r.headers.get("location", "")))
                        if not skip_host_check:
                            url = await check_url(url)
                        continue
                    r.raise_for_status()
                    ctype = r.headers.get("content-type", "")
                    if "html" not in ctype and "text" not in ctype:
                        raise WebError(f"Это не веб-страница ({ctype or 'неизвестный тип'})")
                    body = b""
                    async for chunk in r.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_PAGE_BYTES:
                            break
                    html = body.decode(r.encoding or "utf-8", errors="replace")
                    break
            else:
                raise WebError("Слишком много перенаправлений")
        except httpx.HTTPError as e:
            raise WebError(f"Не удалось открыть страницу: {e.__class__.__name__}") from e
    extractor = _TextExtractor()
    extractor.feed(html)
    text = extractor.text()
    return {"url": url, "title": re.sub(r"\s+", " ", extractor.title).strip(),
            "content": text[:MAX_PAGE_CHARS], "truncated": len(text) > MAX_PAGE_CHARS}
