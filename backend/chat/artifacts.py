"""
Артефакты: игры, интерактивные страницы, схемы и рисунки, которые модель пишет в чат
обычным блоком кода (```html, ```svg, ```mermaid), а интерфейс запускает в панели рядом.

Почему блок кода, а не инструмент. Модели на 8B проще и надёжнее написать 200 строк
HTML обычным блоком, чем упаковать их в JSON-аргумент инструмента (кавычки, переносы).
И так работает даже с моделями, которые не умеют вызывать инструменты.

Здесь две вещи:
  1. ARTIFACTS_HINT — короткая инструкция для модели (добавляется в системный промпт).
  2. compact_history — экономия контекста. Каждая правка игры — это новая полная версия
     кода в ответе. Если отдавать модели все старые версии, 8K контекста кончатся за
     пару правок. Поэтому полный код оставляем только у ПОСЛЕДНЕЙ версии каждого
     артефакта, а в старых ответах заменяем его короткой пометкой.
"""

import re

ARTIFACTS_HINT = """\
Артефакты. Когда просят игру, интерактивную страницу, анимацию, калькулятор, тренажёр или визуализацию — \
напиши ОДИН самодостаточный HTML-файл в блоке ```html: <!DOCTYPE html>, <title> с названием, стили в <style>, \
код в <script>. Без интернета: никаких CDN, внешних шрифтов и картинок (рисуй на canvas, SVG или CSS). \
Для 3D можно подключить <script src="three.js"></script> (глобальный THREE), для графиков — \
<script src="chart.js"></script> (глобальный Chart); других библиотек нет. Код запустится в панели рядом \
с чатом. В играх покажи на экране управление и счёт, сделай рестарт. Схемы и диаграммы — в блоке ```mermaid, \
векторные рисунки — в блоке ```svg. При любой правке присылай код целиком, а не кусками. До кода — одна \
фраза, после — коротко, что умеет и как управлять."""

# ```html … ``` (закрывающих кавычек может не быть — ответ оборвался)
FENCE = re.compile(r"```(html|svg|mermaid)[^\n]*\n(.*?)(?:\n```|\Z)", re.DOTALL | re.IGNORECASE)
HTML_DOCUMENT = re.compile(r"<!doctype|<html|<body|<canvas|<script", re.IGNORECASE)


def artifact_title(lang: str, code: str) -> str:
    """Название артефакта — так же, как его определяет интерфейс (frontend/js/artifacts.js)."""
    lang = lang.lower()
    if lang in ("html", "svg"):
        m = re.search(r"<title[^>]*>([^<]{1,120})</title>", code, re.IGNORECASE)
        if m and m.group(1).strip():
            return m.group(1).strip()
        return "Страница" if lang == "html" else "Рисунок"
    return "Схема"


def is_artifact(lang: str, code: str) -> bool:
    """Не каждый ```html — артефакт: короткий пример тега остаётся просто кодом."""
    lang = lang.lower()
    if lang == "html":
        return bool(HTML_DOCUMENT.search(code))
    if lang == "svg":
        return "<svg" in code.lower()
    return bool(code.strip())


def _key(lang: str, code: str) -> str:
    return f"{lang.lower()}:{artifact_title(lang, code).lower()}"


def compact_history(history: list[dict]) -> list[dict]:
    """Копия истории, где код артефактов оставлен только в последней версии каждого."""
    seen: set[str] = set()
    result = []
    # Идём с конца: первая встреченная версия артефакта — самая свежая
    for message in reversed(history):
        if message.get("role") != "assistant":
            result.append(message)
            continue
        changed = dict(message)
        # Модель видит исправленный пользователем ответ, если он есть (этап 6), — его и сжимаем
        for field in ("corrected",) if message.get("corrected") else ("content",):
            text = message.get(field)
            if not text or "```" not in text:
                continue
            blocks = [m for m in FENCE.finditer(text) if is_artifact(m.group(1), m.group(2))]
            # Внутри одного ответа тоже с конца: если версий две, полной остаётся последняя
            for m in reversed(blocks):
                key = _key(m.group(1), m.group(2))
                if key in seen:
                    lines = m.group(2).count("\n") + 1
                    stub = (f"```{m.group(1).lower()}\n<!-- код «{artifact_title(m.group(1), m.group(2))}» "
                            f"({lines} строк) опущен: ниже в диалоге есть более новая версия -->\n```")
                    text = text[: m.start()] + stub + text[m.end():]
                else:
                    seen.add(key)
            changed[field] = text
        result.append(changed)
    result.reverse()
    return result
