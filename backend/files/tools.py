"""
Инструменты модели для документов: создать Word / презентацию / Excel, поправить Word.

Файл создаётся только внутри приложения (data/files) — в папки пользователя ничего
не пишется, поэтому подтверждение не спрашиваем: скачать файл или нет, решает сам
пользователь кнопкой «Скачать». Исходник документа (markdown, слайды, листы)
сохраняем рядом — по нему строится предпросмотр в чате, и модель видит документ
в следующих сообщениях («добавь раздел про…» → она пересоздаст его целиком).
"""

import asyncio
import json
import re
from pathlib import Path

from . import docgen, store
from .extract import MIME_TYPES, extract_bytes

PREVIEW_CHARS = 20_000
PREVIEW_ROWS = 30


def public(record: dict) -> dict:
    """Что из записи о файле отдать в интерфейс."""
    return {k: record[k] for k in ("id", "name", "size", "mime", "kind", "url", "meta")}


def _as_list(value, field: str) -> list:
    """Модель иногда присылает вложенный список строкой JSON — разворачиваем."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as e:
            raise docgen.DocError(f"{field} должен быть списком (JSON-массивом)") from e
    if not isinstance(value, list):
        raise docgen.DocError(f"{field} должен быть списком")
    return value


def _first_heading(markdown: str) -> str | None:
    m = re.search(r"^#{1,3}\s+(.+)$", markdown or "", re.MULTILINE)
    return m.group(1).strip("*_ ") if m else None


def _words(text: str) -> int:
    return len(re.findall(r"[\wёЁ]+", text or ""))


def _plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    return few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many


DONE_NOTE = ("Пользователь видит карточку файла с предпросмотром и кнопкой «Скачать». Не повторяй содержимое "
             "в ответе — коротко скажи, что подготовил, и предложи, что можно изменить.")


async def create_word(args: dict, settings: dict, ctx: dict):
    content = str(args.get("content") or "")
    title = str(args.get("title") or "").strip() or None
    name = store.with_extension(str(args.get("filename") or title or _first_heading(content) or "Документ"), ".docx")
    data = await asyncio.to_thread(docgen.markdown_to_docx, content, title)
    words = _words(content)
    record = store.create_file(
        kind="generated", name=name, data=data, mime=MIME_TYPES[".docx"], conversation_id=ctx.get("conversation_id"),
        text=(f"# {title}\n\n" if title and not content.lstrip().startswith("#") else "") + content,
        meta={"type": "docx", "words": words, "preview": {"title": title, "markdown": content[:PREVIEW_CHARS]}},
    )
    return (f"Документ Word «{name}» создан: {words} {_plural(words, 'слово', 'слова', 'слов')}. {DONE_NOTE}",
            {"file": public(record)})


def _slides_outline(title: str, subtitle: str | None, slides: list[dict]) -> str:
    lines = [f"# Презентация «{title}»" + (f" — {subtitle}" if subtitle else "")]
    for n, s in enumerate(slides, 1):
        lines.append(f"\n## Слайд {n}: {s['title']}")
        lines += [("  " * lvl) + f"- {text}" for lvl, text in s["points"]]
        if s.get("notes"):
            lines.append(f"Заметки: {s['notes']}")
    return "\n".join(lines)


async def create_presentation(args: dict, settings: dict, ctx: dict):
    title = str(args.get("title") or "Презентация").strip()
    subtitle = str(args.get("subtitle") or "").strip() or None
    raw = _as_list(args.get("slides"), "slides")
    if not raw:
        raise docgen.DocError("Нет слайдов: передай slides — список {title, points}")
    slides = []
    for item in raw[:docgen.MAX_SLIDES]:
        item = item if isinstance(item, dict) else {"title": str(item)}
        slides.append({
            "title": str(item.get("title") or "").strip() or f"Слайд {len(slides) + 1}",
            "points": docgen._points(item.get("points") or item.get("bullets") or item.get("content")),
            "notes": str(item.get("notes") or "").strip(),
        })
    name = store.with_extension(str(args.get("filename") or title), ".pptx")
    # В сборщик передаём пункты с отступом для подпунктов — так же, как их понимает _points
    deck = [{"title": s["title"], "points": [("  " if lvl else "") + t for lvl, t in s["points"]], "notes": s["notes"]}
            for s in slides]
    data = await asyncio.to_thread(docgen.build_pptx, title, deck, subtitle)
    record = store.create_file(
        kind="generated", name=name, data=data, mime=MIME_TYPES[".pptx"], conversation_id=ctx.get("conversation_id"),
        text=_slides_outline(title, subtitle, slides),
        meta={"type": "pptx", "slides": len(slides) + 1,
              "preview": {"title": title, "subtitle": subtitle, "slides": slides}},
    )
    n = len(slides) + 1
    return (f"Презентация «{name}» создана: {n} {_plural(n, 'слайд', 'слайда', 'слайдов')} (с титульным). {DONE_NOTE}",
            {"file": public(record)})


def _sheet_text(sheet: dict) -> str:
    rows = [sheet["columns"]] if sheet["columns"] else []
    rows += sheet["rows"]
    return f"## Лист «{sheet['name']}»\n" + "\n".join("| " + " | ".join(str(c) for c in r) + " |" for r in rows)


async def create_spreadsheet(args: dict, settings: dict, ctx: dict):
    raw = _as_list(args.get("sheets"), "sheets")
    sheets = []
    for item in raw[:docgen.MAX_SHEETS]:
        if not isinstance(item, dict):
            raise docgen.DocError("Каждый лист — объект {name, columns, rows}")
        rows = _as_list(item.get("rows") or [], "rows")
        sheets.append({"name": str(item.get("name") or f"Лист{len(sheets) + 1}"),
                       "columns": [str(c) for c in (item.get("columns") or [])],
                       "rows": [r if isinstance(r, list) else [r] for r in rows]})
    if not sheets:
        raise docgen.DocError("Нет листов: передай sheets — список {name, columns, rows}")
    name = store.with_extension(str(args.get("filename") or sheets[0]["name"] or "Таблица"), ".xlsx")
    data = await asyncio.to_thread(docgen.build_xlsx, sheets)
    total_rows = sum(len(s["rows"]) for s in sheets)
    record = store.create_file(
        kind="generated", name=name, data=data, mime=MIME_TYPES[".xlsx"], conversation_id=ctx.get("conversation_id"),
        text="\n\n".join(_sheet_text(s) for s in sheets),
        meta={"type": "xlsx", "sheets": [{"name": s["name"], "rows": len(s["rows"])} for s in sheets],
              "preview": {"sheets": [{**s, "rows": s["rows"][:PREVIEW_ROWS], "total": len(s["rows"])} for s in sheets]}},
    )
    return (f"Таблица Excel «{name}» создана: {len(sheets)} {_plural(len(sheets), 'лист', 'листа', 'листов')}, "
            f"{total_rows} {_plural(total_rows, 'строка', 'строки', 'строк')}. {DONE_NOTE}", {"file": public(record)})


async def edit_word(args: dict, settings: dict, ctx: dict):
    conv_id = ctx.get("conversation_id")
    source = store.find_in_conversation(conv_id, str(args.get("file") or ""), ".docx") if conv_id else None
    if source is None:
        raise docgen.DocError("В этом диалоге нет такого файла .docx. Попроси пользователя прикрепить документ "
                              "или создай новый через create_word_document.")
    replacements = _as_list(args.get("replacements"), "replacements")
    original = store.path_of(source).read_bytes()
    data, report = await asyncio.to_thread(docgen.edit_docx, original, [r for r in replacements if isinstance(r, dict)])
    stem = re.sub(r"\s*\(исправлено( \d+)?\)$", "", Path(source["name"]).stem)
    name = store.with_extension(f"{stem} (исправлено)", ".docx")
    extracted = await asyncio.to_thread(extract_bytes, data, name)
    done = [r for r in report if r["count"]]
    missed = [r for r in report if not r["count"]]
    record = store.create_file(
        kind="generated", name=name, data=data, mime=MIME_TYPES[".docx"], conversation_id=conv_id,
        text=extracted.text, meta={"type": "docx", "edited_from": source["name"], "changes": report},
    )
    text = (f"Исправленная копия «{name}» создана (оригинал «{source['name']}» не тронут), оформление сохранено. "
            f"Замен выполнено: {sum(r['count'] for r in done)}.")
    if missed:
        text += " Не найдены дословно: " + "; ".join(f"«{r['find'][:60]}»" for r in missed) + "."
    return text + " " + DONE_NOTE, {"file": public(record), "changes": report}
