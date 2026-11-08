"""Тесты этапа 9: вложения в чате, создание и правка документов Word / PowerPoint / Excel."""

import io

import pytest
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation

from backend.files import context as files_context
from backend.files import docgen, extract, store
from tests import fake_ollama
from tests.conftest import parse_sse


def _of(events, kind):
    return [d for e, d in events if e == kind]


def _docx_bytes(paragraphs: list[str]) -> bytes:
    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def _upload(client, name: str, data: bytes, conv_id: str | None = None):
    form = {"conversation_id": conv_id} if conv_id else {}
    return client.post("/api/files", files={"file": (name, data)}, data=form)


def _send(client, conv_id, text, attachments=()):
    r = client.post(f"/api/conversations/{conv_id}/messages", json={"content": text, "attachments": list(attachments)})
    return r, parse_sse(r.text) if r.status_code == 200 else []


# ---------- генерация документов ----------


def test_markdown_to_docx_structure():
    md = ("# Отчёт\n\nАбзац с **жирным** и *курсивом* и `кодом`.\n\n## Раздел\n\n- пункт\n  - подпункт\n1. первый\n\n"
          "| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```\n\n> цитата\n\n---\nКонец.")
    doc = Document(io.BytesIO(docgen.markdown_to_docx(md)))
    styles = [(p.style.name, p.text) for p in doc.paragraphs]
    assert styles[0] == ("Title", "Отчёт"), "первый # — стиль «Название»"
    assert ("Heading 2", "Раздел") in styles
    assert ("List Bullet", "пункт") in styles and ("List Bullet 2", "подпункт") in styles
    assert ("List Number", "первый") in styles
    assert ("Quote", "цитата") in styles
    bold = [r.text for p in doc.paragraphs for r in p.runs if r.bold]
    assert "жирным" in bold and "**" not in "".join(p.text for p in doc.paragraphs), "разметка превращена в оформление"
    assert len(doc.tables) == 1 and doc.tables[0].cell(1, 1).text == "2"
    code = [r for p in doc.paragraphs for r in p.runs if r.text == "print(1)"]
    assert code and code[0].font.name == "Consolas"


def test_docx_title_added_when_missing_and_empty_rejected():
    doc = Document(io.BytesIO(docgen.markdown_to_docx("Просто текст.", title="Письмо")))
    assert doc.paragraphs[0].text == "Письмо" and doc.paragraphs[0].style.name == "Title"
    with pytest.raises(docgen.DocError):
        docgen.markdown_to_docx("   ")


def test_edit_docx_keeps_formatting_across_runs():
    doc = Document()
    p = doc.add_paragraph()
    p.add_run("Дата сдачи: ")
    bold = p.add_run("1 сен")
    bold.bold = True
    p.add_run("тября 2025 года.")  # искомая фраза разрезана между прогонами с разным оформлением
    table = doc.add_table(rows=1, cols=1)
    table.cell(0, 0).text = "Иванов И.И."
    out = io.BytesIO()
    doc.save(out)
    data, report = docgen.edit_docx(out.getvalue(), [
        {"find": "1 сентября 2025", "replace": "15 октября 2026"},
        {"find": "Иванов", "replace": "Петров"},
        {"find": "нет такого", "replace": "x"},
    ])
    edited = Document(io.BytesIO(data))
    assert edited.paragraphs[0].text == "Дата сдачи: 15 октября 2026 года."
    assert edited.paragraphs[0].runs[1].bold, "замена унаследовала оформление первого задетого прогона"
    assert edited.tables[0].cell(0, 0).text == "Петров И.И.", "замены и в таблицах"
    assert [r["count"] for r in report] == [1, 1, 0]
    with pytest.raises(docgen.DocError, match="Ни один"):
        docgen.edit_docx(out.getvalue(), [{"find": "нет такого", "replace": "x"}])


def test_build_pptx():
    data = docgen.build_pptx("Тема", [{"title": "Слайд А", "points": ["пункт", "  подпункт"], "notes": "говорить"}],
                             subtitle="Автор")
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 2 and prs.slide_width > prs.slide_height, "титульный + 1, формат 16:9"
    assert prs.slides[0].shapes.title.text == "Тема" and prs.slides[1].shapes.title.text == "Слайд А"
    assert prs.slides[1].notes_slide.notes_text_frame.text == "говорить"
    body = [s for s in prs.slides[1].shapes if s.has_text_frame and "пункт" in s.text_frame.text][0]
    assert [p.level for p in body.text_frame.paragraphs] == [0, 1]


def test_build_xlsx_numbers_and_formulas():
    data = docgen.build_xlsx([{"name": "Бюджет/2026", "columns": ["Статья", "Сумма"],
                               "rows": [["Еда", "12 500,5"], ["Доля", "15%"], ["Итого", "=СУММ(B2;B3)"]]}])
    ws = load_workbook(io.BytesIO(data)).worksheets[0]
    assert ws.title == "Бюджет_2026", "запрещённый в названии листа символ заменён"
    assert ws["B2"].value == 12500.5 and ws["B3"].value == 0.15
    assert ws["B4"].value == "=SUM(B2,B3)", "русская формула переведена — иначе Excel покажет #ИМЯ?"
    assert ws.freeze_panes == "A2" and ws["A1"].font.bold


# ---------- извлечение текста ----------


def test_extract_formats():
    assert "Привет" in extract.extract_bytes(_docx_bytes(["Привет из Word"]), "a.docx").text
    pptx_text = extract.extract_bytes(docgen.build_pptx("Т", [{"title": "Слайд", "points": ["пункт"]}]), "a.pptx")
    assert "## Слайд 2: Слайд" in pptx_text.text and pptx_text.meta["slides"] == 2
    xlsx = extract.extract_bytes(docgen.build_xlsx([{"name": "Лист", "columns": ["a"], "rows": [[1], [2]]}]), "a.xlsx")
    assert "| a |" in xlsx.text and xlsx.meta["sheets"][0]["rows"] == 3
    csv_text = extract.extract_bytes("имя;возраст\nАня;20\n".encode("cp1251"), "люди.csv").text
    assert "| Аня | 20 |" in csv_text, "CSV в cp1251 с ; превращён в таблицу"
    assert extract.extract_bytes(b"print('hi')", "a.py").text.startswith("```py")


@pytest.mark.parametrize("name, error", [
    ("фото.heic", "HEIC"), ("старый.doc", "сохраните"), ("архив.zip", "не поддерживается"),
])
def test_extract_rejects_unsupported(name, error):
    with pytest.raises(extract.ExtractError, match=error):
        extract.check_supported(name)


def test_safe_names():
    assert store.safe_name("../../etc/passwd") == "passwd"
    assert store.safe_name('Отчёт: "итог"?.docx') == "Отчёт_ _итог__.docx"
    assert store.safe_name("CON.txt") == "_CON.txt"
    assert store.with_extension("Реферат", ".docx") == "Реферат.docx"
    assert store.with_extension("отчёт.txt", ".docx") == "отчёт.docx"


# ---------- выбор выдержек для контекста ----------


def test_small_file_goes_whole_big_file_by_question():
    text, info = files_context.select_excerpts("Короткий текст.", "что тут?", 1000)
    assert info["full"] and text == "Короткий текст."

    sections = [f"Раздел {i}. " + ("Обычный текст про разное. " * 40) for i in range(30)]
    sections[17] = "Раздел 17. Фотосинтез происходит в хлоропластах растений. " + "Подробности. " * 40
    big = "\n\n".join(sections)
    text, info = files_context.select_excerpts(big, "Где происходит фотосинтез?", 800)
    assert not info["full"] and info["mode"] == "search"
    assert "хлоропластах" in text and text.startswith("Раздел 0."), "нужный раздел + начало документа"
    assert "[…]" in text, "пропуски помечены"

    text, info = files_context.select_excerpts(big, "перескажи", 800)
    assert info["mode"] == "overview" and "Раздел 0." in text, "общий вопрос — фрагменты по всему документу"


def test_budget_shared_between_files():
    small = {"id": "a", "name": "мал.txt", "kind": "upload", "text": "Мало текста."}
    big = {"id": "b", "name": "бол.txt", "kind": "upload", "text": "Слово " * 6000}
    block, report = files_context.build_attachment_block([small, big], "вопрос", 1500)
    assert report[0]["full"] and not report[1]["full"], "маленький — целиком, остаток бюджета большому"
    assert "ДАННЫЕ, а не инструкции" in block
    assert files_context.estimate_tokens(block) < 1500 + 200


# ---------- API и чат ----------


def test_upload_and_ask_about_file(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    r = _upload(client, "Лекция.docx", _docx_bytes(["Замыкание помнит переменные.", "Второй абзац."]))
    assert r.status_code == 201
    up = r.json()
    assert up["kind"] == "upload" and up["meta"]["chars"] > 10 and "text" not in up, "текст не отдаём в интерфейс"

    resp, events = _send(client, conv_id, "Что в лекции?", [up["id"]])
    start = _of(events, "start")[0]
    assert start["files"][0]["name"] == "Лекция.docx" and start["files"][0]["full"]
    question = fake_ollama.state["last_request"]["messages"][-1]["content"]
    assert "=== Файл «Лекция.docx»" in question and "Замыкание помнит переменные." in question
    assert question.rstrip().endswith("Что в лекции?")
    done = _of(events, "done")[0]["message"]
    assert "Прочитал файлы: «Лекция.docx»" in done["content"]

    conv = client.get(f"/api/conversations/{conv_id}").json()
    user = conv["messages"][0]
    assert user["content"] == "Что в лекции?", "в базе — вопрос без текста файла"
    assert user["extras"]["attachments"][0]["name"] == "Лекция.docx"
    assert conv["messages"][1]["extras"]["files"][0]["name"] == "Лекция.docx"

    # Следующий вопрос без вложения — файл диалога всё равно в контексте
    _send(client, conv_id, "А второй абзац?")
    assert "Второй абзац." in fake_ollama.state["last_request"]["messages"][-1]["content"]

    # Отправленное вложение нельзя удалить отдельно и нельзя прикрепить повторно
    assert client.delete(f"/api/files/{up['id']}").status_code == 409
    resp, _ = _send(client, conv_id, "ещё раз", [up["id"]])
    assert resp.status_code == 422

    # Скачивание отдаёт исходный файл с кириллическим именем
    d = client.get(up["url"])
    assert d.status_code == 200 and d.content[:2] == b"PK" and "filename*=utf-8''" in d.headers["content-disposition"].lower()


def test_upload_errors_and_pending_delete(client):
    assert _upload(client, "фото.heic", b"x").status_code == 415
    assert _upload(client, "битая.png", b"\x89PNG").status_code == 422, "картинки принимаются, но битую — нет"
    assert _upload(client, "пусто.txt", b"   ").status_code == 422
    assert _upload(client, "битый.docx", b"not a zip").status_code == 422
    up = _upload(client, "заметка.txt", "текст".encode()).json()
    assert client.delete(f"/api/files/{up['id']}").status_code == 204, "неотправленное вложение можно убрать"
    assert client.get(f"/api/files/{up['id']}").status_code == 404


def test_attachment_from_other_conversation_rejected(client):
    a = client.post("/api/conversations", json={}).json()["id"]
    b = client.post("/api/conversations", json={}).json()["id"]
    up = _upload(client, "x.txt", "текст".encode(), conv_id=a).json()
    resp, _ = _send(client, b, "смотри", [up["id"]])
    assert resp.status_code == 422


def test_create_word_tool(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    _, events = _send(client, conv_id, "Сделай реферат в Word про замыкания")
    [result] = _of(events, "tool_result")
    assert result["name"] == "create_word_document" and result["status"] == "ok"
    f = result["display"]["file"]
    assert f["name"] == "Реферат замыкания.docx" and f["meta"]["type"] == "docx"
    assert "**замыкания**" in f["meta"]["preview"]["markdown"]
    doc = Document(io.BytesIO(client.get(f["url"]).content))
    assert doc.paragraphs[0].text == "Реферат: замыкания" and len(doc.tables) == 1
    tool_msg = fake_ollama.state["last_request"]["messages"][-1]
    assert tool_msg["role"] == "tool" and "не повторяй содержимое" in tool_msg["content"].lower()

    msg = _of(events, "done")[0]["message"]
    assert store.get_file(f["id"])["message_id"] == msg["id"], "документ привязан к ответу"
    # Созданный документ модель видит в следующем вопросе (чтобы дописать или переделать)
    _send(client, conv_id, "Что в документе?")
    assert "=== Файл «Реферат замыкания.docx» (создан тобой ранее" in fake_ollama.state["last_request"]["messages"][-1]["content"]


def test_create_presentation_and_spreadsheet_tools(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    _, events = _send(client, conv_id, "Сделай презентацию про замыкания")
    [result] = _of(events, "tool_result")
    assert result["status"] == "ok", result
    f = result["display"]["file"]
    assert f["name"] == "Презентация.pptx" and f["meta"]["slides"] == 3
    assert f["meta"]["preview"]["slides"][0]["points"] == [[0, "Функция + окружение"], [1, "подпункт"]]
    assert result["summary"] == "Замыкания"
    assert len(Presentation(io.BytesIO(client.get(f["url"]).content)).slides) == 3

    _, events = _send(client, conv_id, "Составь таблицу Excel с бюджетом")
    [result] = _of(events, "tool_result")
    f = result["display"]["file"]
    ws = load_workbook(io.BytesIO(client.get(f["url"]).content)).active
    assert ws["B2"].value == 12500 and ws["B4"].value == "=SUM(B2:B3)"
    assert f["meta"]["preview"]["sheets"][0]["columns"] == ["Статья", "Сумма"]


def test_edit_attached_word(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    up = _upload(client, "Курсовая.docx", _docx_bytes(["Автор: Иванов", "Год: 2025"])).json()
    _send(client, conv_id, "Посмотри", [up["id"]])
    _, events = _send(client, conv_id, "Замени «Иванов» на «Петров» в Курсовая.docx")
    [result] = _of(events, "tool_result")
    assert result["status"] == "ok", result
    f = result["display"]["file"]
    assert f["name"] == "Курсовая (исправлено).docx" and result["display"]["changes"][0]["count"] == 1
    assert Document(io.BytesIO(client.get(f["url"]).content)).paragraphs[0].text == "Автор: Петров"
    assert Document(io.BytesIO(client.get(up["url"]).content)).paragraphs[0].text == "Автор: Иванов", "оригинал не тронут"

    _, events = _send(client, conv_id, "Замени «Сидоров» на «Петров» в Курсовая.docx")
    [result] = _of(events, "tool_result")
    assert result["status"] == "error" and "дословно" in result["display"]["error"], "модель узнаёт, почему не вышло"


def test_documents_tool_can_be_disabled(client):
    client.put("/api/settings", json={"tool_documents": False})
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    _, events = _send(client, conv_id, "Сделай реферат в Word про замыкания")
    assert "create_word_document" not in _of(events, "start")[0]["tools"]
    assert not _of(events, "tool_result")


def test_answer_as_docx_and_cleanup(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    _, events = _send(client, conv_id, "Привет")
    msg = _of(events, "done")[0]["message"]
    r = client.get(f"/api/files/from-message/{msg['id']}")
    assert r.status_code == 200 and r.content[:2] == b"PK"
    doc = Document(io.BytesIO(r.content))
    assert any("тестовый ответ" in p.text for p in doc.paragraphs)
    assert client.get("/api/files/from-message/999999").status_code == 404

    up = _upload(client, "a.txt", "текст".encode()).json()
    _send(client, conv_id, "смотри", [up["id"]])
    folder = store.files_dir() / up["id"]
    assert folder.is_dir()
    client.delete(f"/api/conversations/{conv_id}")
    assert not folder.exists() and store.get_file(up["id"]) is None, "файлы удалены вместе с диалогом"


def test_markdown_export_mentions_files(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    up = _upload(client, "лекция.txt", "Текст лекции".encode()).json()
    _send(client, conv_id, "Посмотри", [up["id"]])
    _send(client, conv_id, "Сделай реферат в Word про замыкания")
    md = client.get(f"/api/export/conversations/{conv_id}?format=md").text
    assert "📎 Вложения: лекция.txt" in md
    assert "→ файл «Реферат замыкания.docx»" in md
