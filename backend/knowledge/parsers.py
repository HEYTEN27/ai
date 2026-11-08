"""
Извлечение текста из файлов: PDF, DOCX, TXT, MD (в том числе заметки Obsidian).

Каждый парсер возвращает ParsedDocument — заголовок и список блоков (абзацев).
У блока есть раздел («Глава 2 › Замыкания») и страница (для PDF) — это нужно,
чтобы потом в ответе сослаться: «Лекция 3.pdf, стр. 5».
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

SUPPORTED_TYPES = {".pdf": "pdf", ".docx": "docx", ".txt": "txt", ".md": "md", ".markdown": "md"}


class ParseError(Exception):
    """Файл не удалось прочитать (текст ошибки показывается пользователю)."""


@dataclass
class Block:
    text: str
    section: str | None = None  # путь заголовков: «Глава 2 › Замыкания»
    page: int | None = None  # номер страницы (только PDF)
    is_code: bool = False  # блок кода — при нарезке его лучше не разрывать


@dataclass
class ParsedDocument:
    title: str
    blocks: list[Block] = field(default_factory=list)
    page_count: int | None = None


def file_type(path: Path) -> str | None:
    return SUPPORTED_TYPES.get(path.suffix.lower())


def decode_text(raw: bytes) -> str:
    """Текст в неизвестной кодировке. В Windows старые русские файлы часто в cp1251."""
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _paragraphs(text: str) -> list[str]:
    """Абзацы — куски текста, разделённые пустой строкой."""
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def _section(stack: list[str]) -> str | None:
    return " › ".join(s for s in stack if s) or None


# ---------- TXT ----------


def parse_txt(path: Path) -> ParsedDocument:
    text = decode_text(path.read_bytes())
    return ParsedDocument(title=path.stem, blocks=[Block(p) for p in _paragraphs(text)])


# ---------- Markdown и Obsidian ----------


def clean_obsidian(text: str) -> str:
    """Убирает разметку Obsidian, которая мешает модели и поиску."""
    text = re.sub(r"%%.*?%%", "", text, flags=re.DOTALL)  # комментарии Obsidian
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)  # HTML-комментарии
    text = re.sub(r"!\[\[[^\]]*\]\]", "", text)  # встраивания ![[картинка.png]]
    text = re.sub(r"\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]+)\]\]", r"\2", text)  # [[Заметка|текст]] → текст
    text = re.sub(r"\[\[([^\]#|]+)(?:#([^\]|]+))?\]\]", lambda m: m.group(1) + (f" ({m.group(2)})" if m.group(2) else ""), text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)  # картинки markdown
    return text


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """YAML-шапка заметки (между строками ---). Разбираем только простые «ключ: значение»."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not match:
        return {}, text
    meta = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "-")):
            key, value = line.split(":", 1)
            meta[key.strip().lower()] = value.strip().strip("\"'")
    return meta, text[match.end():]


def parse_md(path: Path) -> ParsedDocument:
    meta, body = parse_frontmatter(decode_text(path.read_bytes()))
    body = clean_obsidian(body)
    title = meta.get("title") or path.stem

    blocks: list[Block] = []
    stack: list[str] = []  # текущие заголовки по уровням: ["Глава 2", "Замыкания"]
    buffer: list[str] = []
    in_code = False

    def flush():
        text = "\n".join(buffer).strip()
        buffer.clear()
        if text:
            blocks.extend(Block(p, _section(stack)) for p in _paragraphs(text))

    code: list[str] = []
    for line in body.splitlines():
        if line.lstrip().startswith("```"):
            if in_code:  # конец блока кода — сохраняем целиком
                code.append(line)
                blocks.append(Block("\n".join(code), _section(stack), is_code=True))
                code = []
                in_code = False
            else:
                flush()
                in_code = True
                code = [line]
            continue
        if in_code:
            code.append(line)
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)", line)
        if heading:
            flush()
            level = len(heading.group(1))
            stack = stack[: level - 1] + [heading.group(2).strip().strip("#").strip()]
            continue
        buffer.append(line)
    if code:  # незакрытый блок кода
        blocks.append(Block("\n".join(code), _section(stack), is_code=True))
    flush()

    tags = meta.get("tags")
    if tags:  # теги из шапки помогают поиску — добавляем их отдельным блоком
        blocks.insert(0, Block(f"Теги: {tags.strip('[]')}"))
    # Заголовок — из шапки или имя файла (в Obsidian имя файла и есть название заметки)
    return ParsedDocument(title=title, blocks=blocks)


# ---------- DOCX ----------


def parse_docx(path: Path) -> ParsedDocument:
    try:
        import docx  # python-docx
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as e:  # pragma: no cover
        raise ParseError("Не установлена библиотека python-docx (pip install -r requirements.txt)") from e
    try:
        document = docx.Document(str(path))
    except Exception as e:  # noqa: BLE001 — повреждённый файл или не DOCX
        raise ParseError(f"Не удалось открыть DOCX: {e}") from e

    blocks: list[Block] = []
    stack: list[str] = []
    # Идём по телу документа по порядку: абзацы и таблицы вперемешку
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            para = Paragraph(child, document)
            text = para.text.strip()
            if not text:
                continue
            style = (para.style.name or "") if para.style is not None else ""
            # «Heading 2» в английском Word, «Заголовок 2» в русском
            heading = re.match(r"(?:heading|заголовок)\s*(\d)", style, re.IGNORECASE)
            if heading or style.lower() in ("title", "название"):
                level = int(heading.group(1)) if heading else 1
                stack = stack[: level - 1] + [text]
                continue
            blocks.append(Block(text, _section(stack)))
        elif tag == "tbl":
            table = Table(child, document)
            rows = []
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells]
                # Объединённые ячейки python-docx отдаёт по нескольку раз — убираем повторы подряд
                dedup = [c for i, c in enumerate(cells) if i == 0 or c != cells[i - 1]]
                rows.append(" | ".join(dedup))
            if any(r.strip(" |") for r in rows):
                blocks.append(Block("\n".join(rows), _section(stack)))

    title = (document.core_properties.title or "").strip() or path.stem
    return ParsedDocument(title=title, blocks=blocks)


# ---------- PDF ----------


def parse_pdf(path: Path) -> ParsedDocument:
    try:
        from pypdf import PdfReader
    except ImportError as e:  # pragma: no cover
        raise ParseError("Не установлена библиотека pypdf (pip install -r requirements.txt)") from e
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            reader.decrypt("")  # PDF «с защитой от копирования» часто открывается пустым паролем
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as e:  # noqa: BLE001
        raise ParseError(f"Не удалось прочитать PDF: {e}") from e

    blocks: list[Block] = []
    for number, text in enumerate(pages, start=1):
        # В PDF строки абзаца часто разорваны переносами — склеиваем «слово-\nпродолжение»
        text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
        blocks.extend(Block(p, page=number) for p in _paragraphs(text))

    # Скан — это картинки страниц без текстового слоя: ни на одной странице нет текста.
    # (Короткий, но настоящий PDF сканом не считаем.)
    if not any(len(text.strip()) >= 10 for text in pages):
        raise ParseError(
            "В PDF почти нет текста — похоже, это скан (картинки страниц). "
            "Распознавание сканов (OCR) пока не поддерживается."
        )
    title = path.stem
    try:
        meta_title = (reader.metadata.title or "").strip() if reader.metadata else ""
        if meta_title and len(meta_title) > 3 and not meta_title.lower().startswith(("microsoft", "untitled")):
            title = meta_title
    except Exception:  # noqa: BLE001 — метаданные бывают битыми, это не повод падать
        pass
    return ParsedDocument(title=title, blocks=blocks, page_count=len(pages))


PARSERS = {"pdf": parse_pdf, "docx": parse_docx, "txt": parse_txt, "md": parse_md}


def parse_file(path: Path) -> ParsedDocument:
    kind = file_type(path)
    if kind is None:
        raise ParseError(f"Формат {path.suffix or 'без расширения'} не поддерживается (нужны PDF, DOCX, TXT, MD)")
    doc = PARSERS[kind](path)
    if not doc.blocks:
        raise ParseError("В файле не найдено текста")
    return doc
