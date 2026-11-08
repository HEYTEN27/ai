"""
Экспорт диалогов в Markdown (читать, хранить в Obsidian) и JSON (полная копия данных).

В Markdown попадает всё, что видно в чате: ответы (исправленные — с пометкой), «размышления»
в сворачиваемом блоке, вызванные инструменты, источники из базы знаний.
"""

import json
import re
from datetime import datetime, timezone
from urllib.parse import quote

from ..settings import personas as personas_repo
from ..settings import store as settings_store


def _local(iso: str) -> datetime:
    return datetime.fromisoformat(iso).astimezone()  # время из базы в UTC → время компьютера


def _when(iso: str) -> str:
    months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
              "октября", "ноября", "декабря"]
    d = _local(iso)
    return f"{d.day} {months[d.month - 1]} {d.year}, {d:%H:%M}"


def safe_filename(title: str, created_at: str) -> str:
    """«Как работает async/await?» → «2026-11-07 Как работает async-await»."""
    name = re.sub(r'[\\/:*?"<>|]+', "-", title).strip(" .-")[:60] or "диалог"
    return f"{_local(created_at):%Y-%m-%d} {name}"


def content_disposition(filename: str) -> str:
    """Заголовок для скачивания с русским именем файла (RFC 5987: filename* в UTF-8)."""
    ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _tool_line(t: dict) -> str:
    status = {"ok": "", "error": " — ошибка", "declined": " — отклонено вами"}.get(t.get("status"), "")
    result = ""
    if t.get("name") == "calculator" and t.get("status") == "ok":
        result = f" = {t['display']['result']}"
    return f"- {t.get('icon', '🛠')} {t.get('title', t.get('name'))}: `{t.get('summary', '')}`{result}{status}"


def to_markdown(conv: dict, messages: list[dict]) -> str:
    name = settings_store.get("assistant_name")
    persona = personas_repo.get_persona(conv.get("persona_id"))
    meta = [f"Модель: {conv.get('model') or '—'}"]
    if persona:
        meta.append(f"Персона: {persona['icon']} {persona['name']}")
    meta.append(_when(conv["created_at"]))
    lines = [f"# {conv['title']}", "", f"> {' · '.join(meta)}  ", f"> Экспортировано из ассистента «{name}»", ""]

    for m in messages:
        if m["role"] == "user":
            lines += ["---", "", f"### 🧑 Вы · {_local(m['created_at']):%H:%M}", "", m["content"], ""]
            continue
        if m["role"] != "assistant":
            continue
        head = f"### 🤖 {name}" + (f" · {m['model']}" if m.get("model") else "") + f" · {_local(m['created_at']):%H:%M}"
        lines += [head, ""]
        extras = m.get("extras") or {}
        if m.get("thinking"):
            lines += ["<details><summary>Размышления</summary>", "", m["thinking"].strip(), "", "</details>", ""]
        if extras.get("tools"):
            lines += ["**Инструменты:**", *[_tool_line(t) for t in extras["tools"]], ""]
        if m.get("corrected"):
            lines += [m["corrected"], "", "> ✏️ Ответ исправлен вами.", "",
                      "<details><summary>Исходный ответ модели</summary>", "", m["content"], "", "</details>", ""]
        else:
            lines += [m["content"], ""]
        if m.get("stopped"):
            lines += ["*(ответ остановлен)*", ""]
        if extras.get("sources"):
            lines += ["**Источники:**", *[f"{s['n']}. {s['label']}" for s in extras["sources"]], ""]
    return "\n".join(lines).rstrip() + "\n"


def to_json(conv: dict, messages: list[dict]) -> dict:
    return {
        "app": "local-assistant",
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "conversation": {k: conv.get(k) for k in ("id", "title", "model", "persona_id", "kb_scope", "created_at", "updated_at")},
        "messages": [
            {k: m.get(k) for k in ("role", "content", "thinking", "model", "created_at", "stopped", "rating",
                                   "corrected", "stats", "extras")}
            for m in messages if m["role"] in ("user", "assistant")
        ],
    }


def to_json_text(conv: dict, messages: list[dict]) -> str:
    return json.dumps(to_json(conv, messages), ensure_ascii=False, indent=2)
