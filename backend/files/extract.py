"""
Извлечение текста из вложений: то, что модель «прочитает» из прикреплённого файла.

PDF, DOCX, TXT и MD разбираем теми же парсерами, что и базу знаний (этап 4).
Здесь добавлены Excel (.xlsx), PowerPoint (.pptx), CSV и файлы с кодом.

Результат — обычный текст с пометками «[Стр. 5]», «## Лист «Бюджет»», «## Слайд 3»:
так модель понимает, откуда фрагмент, а мы можем резать текст на части без
повторного разбора файла.
"""

import csv
import io
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from ..knowledge.parsers import ParseError, decode_text, parse_file

MAX_TEXT_CHARS = 1_500_000  # ≈ 500 страниц; дальше — обрезаем (в контекст всё равно влезут только выдержки)
MAX_SHEET_ROWS = 2_000  # строк с одного листа Excel
MAX_SHEET_COLS = 50

# Файлы, которые читаем как обычный текст (код, конфиги, логи)
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".ini", ".toml", ".log",
    ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css", ".scss", ".java", ".kt", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".swift", ".sql", ".sh", ".bat", ".ps1", ".vue", ".svelte",
}
DOCUMENT_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".pptx"}
# Картинки (этап 14) — их «читает» модель зрения, а не парсер текста
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
# 3D-модели (этап 15б): описание (размеры, объём) считает files/model3d.py
MODEL_EXTENSIONS = {".stl", ".obj", ".glb"}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS | MODEL_EXTENSIONS

OLD_OFFICE = {".doc": "docx", ".xls": "xlsx", ".ppt": "pptx"}

MIME_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".stl": "model/stl",
    ".obj": "model/obj",
    ".glb": "model/gltf-binary",
    ".json": "application/json",
    ".md": "text/markdown",
    ".html": "text/html",
}


class ExtractError(Exception):
    """Файл не прочитать — текст ошибки показывается пользователю."""


@dataclass
class Extracted:
    text: str
    meta: dict = field(default_factory=dict)  # pages / sheets / slides / chars / truncated


def mime_for(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in MIME_TYPES:
        return MIME_TYPES[ext]
    return "text/plain" if ext in TEXT_EXTENSIONS else "application/octet-stream"


def check_supported(name: str) -> None:
    """Проверка по расширению ДО загрузки — с понятным объяснением, что делать."""
    ext = Path(name).suffix.lower()
    if ext in SUPPORTED_EXTENSIONS:
        return
    if ext in (".heic", ".heif"):
        raise ExtractError("Формат HEIC (iPhone) не поддерживается — пришлите JPG или PNG. На iPhone: Настройки → "
                           "Камера → Форматы → «Наиболее совместимый».")
    if ext in OLD_OFFICE:
        raise ExtractError(f"Старый формат {ext} не поддерживается. Откройте файл в Office и сохраните "
                           f"как .{OLD_OFFICE[ext]} («Файл → Сохранить как»).")
    raise ExtractError(f"Формат {ext or 'без расширения'} не поддерживается. Подходят: PDF, DOCX, XLSX, PPTX, "
                       "TXT, MD, CSV, файлы с кодом, картинки PNG, JPG, WEBP, GIF и 3D-модели STL, OBJ, GLB.")


def _finish(text: str, meta: dict) -> Extracted:
    text = text.strip()
    if not text:
        raise ExtractError("В файле не найдено текста.")
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]
        meta["truncated"] = True
    meta["chars"] = len(text)
    return Extracted(text, meta)


# ---------- PDF, DOCX, TXT, MD — парсеры базы знаний ----------


def _from_knowledge_parser(path: Path) -> Extracted:
    try:
        doc = parse_file(path)
    except ParseError as e:
        raise ExtractError(str(e)) from e
    lines: list[str] = []
    page, section = None, None
    for block in doc.blocks:
        if block.page is not None and block.page != page:
            page = block.page
            lines.append(f"[Стр. {page}]")
        if block.section and block.section != section:
            section = block.section
            # Раздел хранится путём «Глава 2 › Замыкания» — в заголовок берём последнюю часть
            lines.append("## " + section.split(" › ")[-1])
        lines.append(block.text)
    meta = {"pages": doc.page_count} if doc.page_count else {}
    return _finish("\n\n".join(lines), meta)


# ---------- Excel ----------


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).replace("\n", " ").replace("|", "/").strip()


def _xlsx(path: Path) -> Extracted:
    from openpyxl import load_workbook

    try:
        # read_only — не грузим весь файл в память; data_only — значения формул, а не сами формулы
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception as e:  # повреждённый или не тот формат
        raise ExtractError(f"Не удалось открыть таблицу: {e}") from e
    parts, sheets = [], []
    try:
        for ws in wb.worksheets:
            rows, truncated = [], False
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i >= MAX_SHEET_ROWS:
                    truncated = True
                    break
                cells = [_cell(v) for v in row[:MAX_SHEET_COLS]]
                while cells and not cells[-1]:
                    cells.pop()
                if any(cells):
                    rows.append("| " + " | ".join(cells) + " |")
            sheets.append({"name": ws.title, "rows": len(rows)})
            if rows:
                note = f"\n… показаны первые {MAX_SHEET_ROWS} строк" if truncated else ""
                parts.append(f"## Лист «{ws.title}»\n\n" + "\n".join(rows) + note)
    finally:
        wb.close()
    return _finish("\n\n".join(parts), {"sheets": sheets})


# ---------- PowerPoint ----------


def _shape_texts(shape) -> list[str]:
    """Текст из фигуры: надписи, таблицы, вложенные группы."""
    texts = []
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            line = "".join(r.text for r in p.runs).strip()
            if line:
                texts.append(("  " * p.level) + "• " + line if p.level or len(shape.text_frame.paragraphs) > 1 else line)
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            texts.append("| " + " | ".join(_cell(c.text) for c in row.cells) + " |")
    if shape.shape_type == 6:  # группа фигур
        for sub in shape.shapes:
            texts.extend(_shape_texts(sub))
    return texts


def _pptx(path: Path) -> Extracted:
    from pptx import Presentation

    try:
        prs = Presentation(str(path))
    except Exception as e:
        raise ExtractError(f"Не удалось открыть презентацию: {e}") from e
    parts = []
    for n, slide in enumerate(prs.slides, 1):
        title_shape = slide.shapes.title
        title = title_shape.text_frame.text.strip() if title_shape is not None and title_shape.has_text_frame else ""
        lines = []
        title_id = title_shape.shape_id if title_shape is not None else None
        for shape in slide.shapes:
            if shape.shape_id == title_id:  # заголовок уже взяли (сравниваем по id: объекты-обёртки каждый раз новые)
                continue
            lines.extend(_shape_texts(shape))
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                lines.append(f"Заметки докладчика: {notes}")
        parts.append(f"## Слайд {n}" + (f": {title}" if title else "") + ("\n\n" + "\n".join(lines) if lines else ""))
    return _finish("\n\n".join(parts), {"slides": len(prs.slides)})


# ---------- текст и код ----------


def _plain(path: Path) -> Extracted:
    raw = path.read_bytes()
    if b"\x00" in raw[:4096]:
        raise ExtractError("Похоже, это не текстовый файл")
    text = decode_text(raw)
    if path.suffix.lower() in (".csv", ".tsv"):
        # CSV превращаем в таблицу «| a | b |» — модели так понятнее, чем «a;b;c»
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
            rows = list(csv.reader(io.StringIO(text), dialect))
            text = "\n".join("| " + " | ".join(_cell(c) for c in r) + " |" for r in rows[:MAX_SHEET_ROWS] if any(r))
        except csv.Error:
            pass  # не получилось угадать разделитель — оставим как есть
    elif path.suffix.lower() not in (".txt", ".md", ".markdown"):
        # Код — в markdown-блок, чтобы модель видела границы и язык
        text = f"```{path.suffix.lstrip('.')}\n{text}\n```"
    return _finish(text, {})


def extract(path: Path, name: str | None = None) -> Extracted:
    """Текст из файла на диске. name — исходное имя (расширение берём из него)."""
    ext = Path(name or path.name).suffix.lower()
    check_supported(name or path.name)
    if ext == ".xlsx":
        return _xlsx(path)
    if ext == ".pptx":
        return _pptx(path)
    if ext in (".pdf", ".docx"):
        return _from_knowledge_parser(path)
    return _plain(path)


def extract_bytes(data: bytes, name: str) -> Extracted:
    """То же для байтов: сохраняем во временный файл с правильным расширением."""
    check_supported(name)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / ("file" + Path(name).suffix.lower())
        path.write_bytes(data)
        return extract(path, name)
