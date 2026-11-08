"""
Нарезка документа на фрагменты (чанки).

Зачем резать: модель не может прочитать весь учебник за раз (контекст 8K токенов),
поэтому документ делится на куски по ~400 токенов, и в ответ подставляются только
те куски, что подходят к вопросу.

Как режем, чтобы куски были осмысленными:
  * не смешиваем разные разделы — новый заголовок начинает новый фрагмент;
  * собираем фрагмент из целых абзацев, пока не наберётся нужный размер;
  * слишком длинный абзац режем по предложениям;
  * соседние фрагменты перекрываются (~200 символов), чтобы мысль на границе не терялась;
  * блок кода по возможности не разрываем.
"""

import re
from dataclasses import dataclass

from .parsers import Block


@dataclass
class Chunk:
    text: str
    section: str | None
    page_start: int | None
    page_end: int | None


def split_long(text: str, size: int) -> list[str]:
    """Режет слишком длинный текст по предложениям (а если предложение огромное — по словам)."""
    sentences = re.split(r"(?<=[.!?…])\s+|\n", text)
    parts, current = [], ""
    for sentence in sentences:
        while len(sentence) > size:  # предложение длиннее фрагмента — режем по пробелу
            cut = sentence.rfind(" ", 0, size)
            cut = cut if cut > size // 2 else size
            if current:
                parts.append(current)
                current = ""
            parts.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if current and len(current) + len(sentence) + 1 > size:
            parts.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip() if current else sentence
    if current:
        parts.append(current)
    return [p for p in parts if p]


def _tail(text: str, overlap: int) -> str:
    """Конец фрагмента для перекрытия — начинаем с границы слова."""
    if overlap <= 0 or len(text) <= overlap:
        return ""
    tail = text[-overlap:]
    space = tail.find(" ")
    return tail[space + 1:] if 0 <= space < len(tail) // 2 else tail


def chunk_blocks(blocks: list[Block], *, size: int = 1200, overlap: int = 200) -> list[Chunk]:
    chunks: list[Chunk] = []
    parts: list[str] = []
    section: str | None = None
    pages: list[int] = []

    def flush(keep_overlap: bool):
        nonlocal parts, pages
        if not parts:
            return
        text = "\n\n".join(parts).strip()
        chunks.append(Chunk(text, section, min(pages) if pages else None, max(pages) if pages else None))
        tail = _tail(text, overlap) if keep_overlap else ""
        parts = [tail] if tail else []
        pages = pages[-1:] if (tail and pages) else []

    for block in blocks:
        if block.section != section:  # новый раздел — новый фрагмент, без перекрытия
            flush(keep_overlap=False)
            section = block.section
        pieces = [block.text] if (len(block.text) <= size or block.is_code and len(block.text) <= size * 2) \
            else split_long(block.text, size)
        for piece in pieces:
            current = sum(len(p) + 2 for p in parts)
            if parts and current + len(piece) > size:
                flush(keep_overlap=True)
            parts.append(piece)
            if block.page is not None:
                pages.append(block.page)
    flush(keep_overlap=False)
    # Фрагментов «только из перекрытия» не бывает: перекрытие оставляется лишь тогда,
    # когда сразу за ним добавляется новый текст. Поэтому ничего не отфильтровываем —
    # короткий раздел заметки («Другая тема.») тоже должен находиться.
    return chunks


def chunk_header(title: str, chunk: Chunk) -> str:
    """Шапка, которая добавляется к тексту перед расчётом эмбеддинга.

    Фрагмент «Используйте let вместо var» без контекста непонятен, а с шапкой
    «Конспект по JS › Замыкания» поиск по смыслу находит его гораздо точнее.
    """
    return " › ".join(x for x in (title, chunk.section) if x)
