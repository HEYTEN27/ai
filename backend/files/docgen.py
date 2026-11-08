"""
Создание документов Office.

Почему Word собирается из markdown. Маленькой модели (8B) трудно без ошибок
выдать сложную структуру JSON «абзац → стиль → шрифт». А markdown она пишет
каждый день: # заголовки, **жирный**, списки, таблицы. Поэтому модель пишет
текст в markdown, а этот модуль превращает его в настоящий .docx со стилями Word
(«Заголовок 1», «Маркированный список», таблица с сеткой) — такой документ
дальше удобно править в Word: оглавление, нумерация и стили работают.

Презентация — список слайдов «заголовок + пункты (+ заметки)»; дизайн рисуем сами,
чтобы слайды выглядели одинаково аккуратно без шаблона.
Таблица Excel — листы «колонки + строки»; числа становятся числами, формулы — формулами.
"""

import io
import re
from datetime import date

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

MAX_SLIDES = 40
MAX_POINTS = 12
MAX_SHEETS = 10
MAX_ROWS = 10_000
MAX_COLS = 100

ACCENT = RGBColor(0x0E, 0x7C, 0xB8)


class DocError(ValueError):
    """Неверные данные для документа — текст уходит модели, чтобы она исправилась."""


# =====================================================================
# Word: markdown → .docx
# =====================================================================

# **жирный**, __жирный__, *курсив*, _курсив_, `код`, ~~зачёркнутый~~, [текст](ссылка)
INLINE = re.compile(
    r"(\*\*(?P<b>.+?)\*\*|__(?P<b2>.+?)__|(?<![\w*])\*(?P<i>[^*\s][^*]*?)\*(?![\w*])|(?<!\w)_(?P<i2>[^_\s][^_]*?)_(?!\w)"
    r"|`(?P<code>[^`]+)`|~~(?P<s>.+?)~~|\[(?P<lt>[^\]]+)\]\((?P<lu>[^)\s]+)\))"
)
LIST_ITEM = re.compile(r"^(?P<indent>\s*)(?P<marker>[-*+•]|\d+[.)])\s+(?P<text>.*)$")
TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def _add_inline(paragraph, text: str, *, bold: bool = False, mono: bool = False) -> None:
    """Добавляет в абзац текст с inline-разметкой markdown."""
    pos = 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            _run(paragraph, text[pos:m.start()], bold=bold, mono=mono)
        g = m.groupdict()
        if g["b"] or g["b2"]:
            _add_inline(paragraph, g["b"] or g["b2"], bold=True, mono=mono)
        elif g["i"] or g["i2"]:
            _run(paragraph, g["i"] or g["i2"], bold=bold, italic=True, mono=mono)
        elif g["code"]:
            _run(paragraph, g["code"], bold=bold, mono=True)
        elif g["s"]:
            _run(paragraph, g["s"], bold=bold, strike=True)
        elif g["lt"]:
            # Ссылка: синий подчёркнутый текст, адрес — в скобках (кликабельные гиперссылки Word
            # требуют отношений в пакете; для учебных документов адрес в тексте даже нагляднее)
            run = _run(paragraph, g["lt"], bold=bold)
            run.font.color.rgb = ACCENT
            run.font.underline = True
            if g["lu"] != g["lt"] and g["lu"].startswith("http"):
                _run(paragraph, f" ({g['lu']})", bold=bold)
        pos = m.end()
    if pos < len(text):
        _run(paragraph, text[pos:], bold=bold, mono=mono)


def _run(paragraph, text, *, bold=False, italic=False, mono=False, strike=False):
    run = paragraph.add_run(text)
    run.bold = bold or None
    run.italic = italic or None
    run.font.strike = strike or None
    if mono:
        run.font.name = "Consolas"
        run.font.size = Pt(10)
    return run


def _shade(element, fill: str) -> None:
    """Заливка абзаца или ячейки цветом (через XML — в python-docx нет готового свойства)."""
    props = element.get_or_add_pPr() if hasattr(element, "get_or_add_pPr") else element.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    props.append(shd)


def _bottom_border(paragraph) -> None:
    """Горизонтальная линия (--- в markdown) — нижняя граница пустого абзаца."""
    pbdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for k, v in (("val", "single"), ("sz", "6"), ("space", "1"), ("color", "999999")):
        bottom.set(qn(f"w:{k}"), v)
    pbdr.append(bottom)
    paragraph._p.get_or_add_pPr().append(pbdr)


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", line)]


def _add_table(doc, rows: list[list[str]]) -> None:
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=len(rows), cols=cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for r, row in enumerate(rows):
        for c in range(cols):
            cell = table.cell(r, c)
            cell.paragraphs[0].text = ""
            _add_inline(cell.paragraphs[0], row[c].replace("\\|", "|") if c < len(row) else "", bold=(r == 0))
            if r == 0:
                _shade(cell._tc, "DCE9F5")
    doc.add_paragraph()


def _list_style(doc, numbered: bool, level: int) -> str:
    base = "List Number" if numbered else "List Bullet"
    name = base if level == 0 else f"{base} {min(level + 1, 3)}"
    return name if name in [s.name for s in doc.styles] else base


def _setup_document(doc) -> None:
    section = doc.sections[0]
    section.page_height, section.page_width = Cm(29.7), Cm(21.0)  # A4
    section.left_margin = section.right_margin = Cm(2.5)
    section.top_margin = section.bottom_margin = Cm(2)
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11.5)
    # Шрифт для кириллицы задаётся отдельным атрибутом — иначе Word может взять другой
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "Calibri")
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.15


def markdown_to_docx(markdown: str, title: str | None = None) -> bytes:
    """Markdown → байты .docx."""
    if not str(markdown or "").strip():
        raise DocError("Пустой текст документа: передай полный текст в content")
    doc = Document()
    _setup_document(doc)
    doc.core_properties.title = title or ""
    doc.core_properties.author = "Джарвис"

    lines = str(markdown).replace("\r\n", "\n").split("\n")
    if title and not (lines and HEADING.match(lines[0].strip() or "")):
        doc.add_heading(title, level=0)

    paragraph_buf: list[str] = []

    def flush_paragraph():
        if paragraph_buf:
            p = doc.add_paragraph()
            _add_inline(p, " ".join(s.strip() for s in paragraph_buf))
            paragraph_buf.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):  # блок кода
            flush_paragraph()
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(8)
            for n, code_line in enumerate(code):
                run = _run(p, code_line, mono=True)
                if n < len(code) - 1:
                    run.add_break()
            _shade(p._p, "F2F4F7")
            i += 1
            continue

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        if stripped in ("\\pagebreak", "<!-- pagebreak -->", "\\newpage"):
            flush_paragraph()
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            i += 1
            continue

        if re.fullmatch(r"(-\s*){3,}|(\*\s*){3,}|(_\s*){3,}", stripped):
            flush_paragraph()
            _bottom_border(doc.add_paragraph())
            i += 1
            continue

        if m := HEADING.match(stripped):
            flush_paragraph()
            level = len(m.group(1))
            # Первый «# Заголовок» документа — стиль «Название», остальные — «Заголовок 1..4»
            if level == 1 and not doc.paragraphs:
                h = doc.add_heading("", level=0)
            else:
                h = doc.add_heading("", level=min(level, 4))
            _add_inline(h, m.group(2))
            i += 1
            continue

        # Таблица: строка с | и следом строка-разделитель |---|
        if "|" in stripped and i + 1 < len(lines) and TABLE_SEP.match(lines[i + 1]):
            flush_paragraph()
            rows = [_split_row(stripped)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            _add_table(doc, rows)
            continue

        if m := LIST_ITEM.match(line):
            flush_paragraph()
            level = len(m.group("indent").replace("\t", "    ")) // 2
            numbered = m.group("marker")[0].isdigit()
            text = m.group("text")
            # Чекбоксы задач: - [ ] / - [x]
            text = re.sub(r"^\[ \]\s*", "☐ ", re.sub(r"^\[[xX]\]\s*", "☑ ", text))
            p = doc.add_paragraph(style=_list_style(doc, numbered, level))
            _add_inline(p, text)
            i += 1
            continue

        if stripped.startswith(">"):
            flush_paragraph()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip())
                i += 1
            p = doc.add_paragraph(style="Quote" if "Quote" in [s.name for s in doc.styles] else None)
            _add_inline(p, " ".join(quote))
            continue

        paragraph_buf.append(line)
        i += 1
    flush_paragraph()

    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# =====================================================================
# Word: точечная правка существующего .docx с сохранением оформления
# =====================================================================


def _all_paragraphs(doc):
    """Все абзацы документа: основной текст, таблицы (включая вложенные), колонтитулы."""
    def from_container(container):
        for p in container.paragraphs:
            yield p
        for table in getattr(container, "tables", []):
            for row in table.rows:
                for cell in row.cells:
                    yield from from_container(cell)
    yield from from_container(doc)
    for section in doc.sections:
        for part in (section.header, section.footer):
            yield from from_container(part)


def _replace_in_paragraph(paragraph, find: str, replace: str) -> int:
    """Заменяет текст внутри абзаца. Word дробит текст на «прогоны» (runs) с разным
    оформлением, и искомая фраза может быть разрезана между ними. Поэтому ищем в общем
    тексте абзаца, а замену кладём в первый задетый прогон — его оформление и сохранится."""
    count = 0
    start_search = 0
    while True:
        runs = paragraph.runs
        full = "".join(r.text for r in runs)
        idx = full.find(find, start_search)
        if idx < 0 or not runs:
            return count
        end = idx + len(find)
        pos = 0
        first = True
        for run in runs:
            r_start, r_end = pos, pos + len(run.text)
            pos = r_end
            if r_end <= idx or r_start >= end:
                continue
            before = run.text[: max(0, idx - r_start)]
            after = run.text[max(0, end - r_start):] if end < r_end else ""
            if first:
                run.text = before + replace + after
                first = False
            else:
                run.text = after
        count += 1
        start_search = idx + len(replace)


def edit_docx(data: bytes, replacements: list[dict]) -> tuple[bytes, list[dict]]:
    """Применяет замены «найти → заменить». Возвращает новые байты и отчёт по каждой замене."""
    if not replacements:
        raise DocError("Нет замен: передай replacements — список {find, replace}")
    doc = Document(io.BytesIO(data))
    report = []
    paragraphs = list(_all_paragraphs(doc))
    for item in replacements[:200]:
        find, replace = str(item.get("find", "")), str(item.get("replace", ""))
        if not find:
            continue
        n = sum(_replace_in_paragraph(p, find, replace) for p in paragraphs)
        report.append({"find": find, "replace": replace, "count": n})
    if not any(r["count"] for r in report):
        raise DocError("Ни один фрагмент не найден в документе. Фраза в find должна совпадать с текстом "
                       "документа дословно (с теми же буквами и знаками), в пределах одного абзаца.")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue(), report


# =====================================================================
# PowerPoint: слайды → .pptx
# =====================================================================


def _points(raw) -> list[tuple[int, str]]:
    """Пункты слайда → [(уровень, текст)]. Подпункт — строка, начинающаяся с «  - » или «- »."""
    if isinstance(raw, str):
        raw = [s for s in raw.split("\n") if s.strip()]
    result = []
    for item in (raw or [])[:MAX_POINTS]:
        text = str(item)
        level = 1 if re.match(r"^(\s{2,}|\t)\S", text) else 0  # отступ в начале — подпункт
        clean = re.sub(r"^\s*([-*•–]|\d+[.)])\s+", "", text).strip()
        clean = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: m.group(1) or m.group(2), clean)
        if clean:
            result.append((level, clean))
    return result


def _bullet(paragraph, level: int, color_hex: str) -> None:
    """Настоящий маркер PowerPoint (а не символ в тексте): отступы и цвет маркера через XML."""
    from pptx.oxml.ns import qn as pqn

    ppr = paragraph._p.get_or_add_pPr()
    ppr.set("marL", str(342900 + level * 457200))
    ppr.set("indent", "-342900")
    for tag in ("a:buClr", "a:buSzPct", "a:buFont", "a:buChar", "a:buNone"):
        for el in ppr.findall(pqn(tag)):
            ppr.remove(el)
    clr = ppr.makeelement(pqn("a:buClr"), {})
    srgb = clr.makeelement(pqn("a:srgbClr"), {"val": color_hex})
    clr.append(srgb)
    ppr.append(clr)
    ppr.append(ppr.makeelement(pqn("a:buSzPct"), {"val": "100000"}))
    ppr.append(ppr.makeelement(pqn("a:buFont"), {"typeface": "Arial"}))
    ppr.append(ppr.makeelement(pqn("a:buChar"), {"char": "▪" if level == 0 else "–"}))


def build_pptx(title: str, slides: list[dict], subtitle: str | None = None) -> bytes:
    from pptx import Presentation
    from pptx.dml.color import RGBColor as PRGB
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import MSO_ANCHOR
    from pptx.util import Emu, Inches, Pt as PPt

    if not slides:
        raise DocError("Нет слайдов: передай slides — список {title, points}")
    navy, cyan, ink, muted = PRGB(0x0B, 0x1E, 0x33), PRGB(0x1F, 0xB6, 0xE8), PRGB(0x1C, 0x24, 0x33), PRGB(0x5B, 0x67, 0x7A)
    white = PRGB(0xFF, 0xFF, 0xFF)

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)  # 16:9
    W, H = prs.slide_width, prs.slide_height

    def style_text(tf, size, color, bold=False):
        for p in tf.paragraphs:
            for r in p.runs:
                r.font.size, r.font.bold, r.font.color.rgb, r.font.name = PPt(size), bold, color, "Segoe UI"

    def place(shape, x, y, w, h):
        shape.left, shape.top, shape.width, shape.height = x, y, w, h

    decor: dict[int, int] = {}  # сколько фоновых фигур уже на слайде

    def rect(slide, x, y, w, h, color):
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
        shape.fill.solid()
        shape.fill.fore_color.rgb = color
        shape.line.fill.background()
        # Декоративные фигуры — на задний план, под текст, но в порядке добавления (фон, потом черта)
        tree = slide.shapes._spTree
        tree.remove(shape._element)
        layer = decor.setdefault(slide.slide_id, 0)
        tree.insert(2 + layer, shape._element)
        decor[slide.slide_id] = layer + 1
        return shape

    # --- титульный слайд: макет «Титульный» с настоящими заголовком и подзаголовком ---
    s = prs.slides.add_slide(prs.slide_layouts[0])
    rect(s, 0, 0, W, H, navy)
    rect(s, Inches(0.9), Inches(3.55), Inches(1.6), Emu(54000), cyan)
    s.shapes.title.text = str(title or "Презентация")
    place(s.shapes.title, Inches(0.9), Inches(1.4), Inches(11.5), Inches(2.0))
    s.shapes.title.text_frame.vertical_anchor = MSO_ANCHOR.BOTTOM
    s.shapes.title.text_frame.paragraphs[0].alignment = 1  # по левому краю
    style_text(s.shapes.title.text_frame, 44, white, bold=True)
    sub = s.placeholders[1]
    sub.text = str(subtitle or date.today().strftime("%d.%m.%Y"))
    place(sub, Inches(0.9), Inches(3.8), Inches(11.5), Inches(1.2))
    sub.text_frame.paragraphs[0].alignment = 1
    style_text(sub.text_frame, 20, PRGB(0xA9, 0xC4, 0xDA))

    # --- слайды с пунктами: макет «Только заголовок» + свой блок текста ---
    total = min(len(slides), MAX_SLIDES)
    for n, item in enumerate(slides[:MAX_SLIDES], 1):
        if not isinstance(item, dict):
            item = {"title": str(item), "points": []}
        s = prs.slides.add_slide(prs.slide_layouts[5])
        rect(s, 0, 0, Inches(0.18), H, cyan)
        s.shapes.title.text = str(item.get("title") or f"Слайд {n}")
        place(s.shapes.title, Inches(0.7), Inches(0.4), Inches(11.9), Inches(1.05))
        s.shapes.title.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        s.shapes.title.text_frame.word_wrap = True
        s.shapes.title.text_frame.paragraphs[0].alignment = 1
        slide_title = s.shapes.title.text
        style_text(s.shapes.title.text_frame, 32 if len(slide_title) <= 42 else 26 if len(slide_title) <= 70 else 22,
                   navy, bold=True)
        rect(s, Inches(0.7), Inches(1.5), Inches(1.2), Emu(36000), cyan)

        points = _points(item.get("points") or item.get("bullets") or item.get("content"))
        if points:
            chars = sum(len(t) for _, t in points)
            # Чем больше текста, тем мельче шрифт — чтобы всё влезло на слайд
            size = 24 if len(points) <= 5 and chars < 350 else 20 if len(points) <= 8 and chars < 650 else 16
            tb = s.shapes.add_textbox(Inches(0.8), Inches(1.85), Inches(11.8), Inches(4.9))
            tf = tb.text_frame
            tf.word_wrap = True
            for k, (level, text) in enumerate(points):
                p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
                p.level = level
                _bullet(p, level, "1FB6E8")
                p.space_after = PPt(10 if level == 0 else 4)
                run = p.add_run()
                run.text = text
                run.font.size = PPt(size if level == 0 else size - 3)
                run.font.color.rgb = ink if level == 0 else muted
                run.font.name = "Segoe UI"
        num = s.shapes.add_textbox(Inches(11.8), Inches(6.85), Inches(1.2), Inches(0.4))
        num.text_frame.text = f"{n} / {total}"
        style_text(num.text_frame, 11, muted)
        notes = str(item.get("notes") or "").strip()
        if notes:
            s.notes_slide.notes_text_frame.text = notes

    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


# =====================================================================
# Excel: листы → .xlsx
# =====================================================================

NUMBER = re.compile(r"^-?\d{1,3}([  ]\d{3})+([.,]\d+)?$|^-?\d+([.,]\d+)?$")


# В файле .xlsx функции хранятся по-английски; русские названия Excel показывает сам.
# Если модель написала «=СУММ(A1;A3)» — переводим, иначе в ячейке будет #ИМЯ?
RU_FUNCTIONS = {
    "СУММ": "SUM", "СРЗНАЧ": "AVERAGE", "МАКС": "MAX", "МИН": "MIN", "СЧЁТ": "COUNT", "СЧЕТ": "COUNT",
    "СЧЁТЗ": "COUNTA", "СЧЕТЗ": "COUNTA", "ЕСЛИ": "IF", "ОКРУГЛ": "ROUND", "СУММЕСЛИ": "SUMIF",
    "СЧЁТЕСЛИ": "COUNTIF", "СЧЕТЕСЛИ": "COUNTIF", "СЕГОДНЯ": "TODAY", "ВПР": "VLOOKUP", "И": "AND", "ИЛИ": "OR",
    "ABS": "ABS", "КОРЕНЬ": "SQRT", "СЦЕП": "CONCAT", "ПРОИЗВЕД": "PRODUCT",
}


def _formula(s: str) -> str:
    def repl(m):
        return RU_FUNCTIONS.get(m.group(1).upper(), m.group(1)) + "("
    s = re.sub(r"([А-Яа-яЁё]+)\(", repl, s)
    return s.replace(";", ",")  # разделитель аргументов в файле — запятая


def _value(v):
    """«1 234,5» → 1234.5; «=СУММ(A1;A3)» → =SUM(A1,A3); остальное — как есть."""
    if isinstance(v, (int, float)) or v is None:
        return v
    s = str(v).strip()
    if s.startswith("="):
        return _formula(s)
    if NUMBER.match(s):
        s = s.replace(" ", "").replace(" ", "").replace(",", ".")
        try:
            num = float(s)
            return int(num) if num.is_integer() and "." not in s else num
        except ValueError:
            return v
    if re.fullmatch(r"-?\d+([.,]\d+)?\s?%", s):
        return float(s.rstrip("% ").replace(",", ".")) / 100
    return s


def _sheet_name(name: str, used: set[str]) -> str:
    name = re.sub(r"[\[\]:*?/\\]", "_", str(name or "Лист")).strip("'") or "Лист"
    name = name[:31]
    base, n = name, 2
    while name.lower() in used:
        suffix = f" ({n})"
        name = base[: 31 - len(suffix)] + suffix
        n += 1
    used.add(name.lower())
    return name


def build_xlsx(sheets: list[dict]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    if not sheets:
        raise DocError("Нет листов: передай sheets — список {name, columns, rows}")
    wb = Workbook()
    wb.remove(wb.active)
    used: set[str] = set()
    header_fill, header_font = PatternFill("solid", fgColor="0B1E33"), Font(bold=True, color="FFFFFF")
    for sheet in sheets[:MAX_SHEETS]:
        if not isinstance(sheet, dict):
            raise DocError("Каждый лист — объект {name, columns, rows}")
        ws = wb.create_sheet(_sheet_name(sheet.get("name"), used))
        columns = [str(c) for c in (sheet.get("columns") or [])][:MAX_COLS]
        rows = sheet.get("rows") or []
        if not isinstance(rows, list):
            raise DocError("rows должен быть списком строк, каждая строка — список значений")
        start = 1
        if columns:
            ws.append(columns)
            for cell in ws[1]:
                cell.fill, cell.font = header_fill, header_font
                cell.alignment = Alignment(vertical="center")
            ws.freeze_panes = "A2"  # шапка не уезжает при прокрутке
            start = 2
        for row in rows[:MAX_ROWS]:
            values = row if isinstance(row, list) else list(row.values()) if isinstance(row, dict) else [row]
            ws.append([_value(v) for v in values[:MAX_COLS]])
        # Ширина колонок — по самому длинному значению (но не шире 60 символов)
        for col_idx, col in enumerate(ws.iter_cols(min_row=1, max_row=min(ws.max_row, 500)), 1):
            width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
            ws.column_dimensions[get_column_letter(col_idx)].width = min(60, max(8, width + 2))
        if columns and ws.max_row >= start:
            ws.auto_filter.ref = ws.dimensions  # фильтры в шапке
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
