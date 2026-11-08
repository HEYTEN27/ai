"""Тесты этапа 4: база знаний (RAG) — разбор файлов, нарезка, индексация, поиск, ответы со ссылками."""

import os
import time
from pathlib import Path

import pytest

from backend.knowledge import parsers
from backend.knowledge.chunker import chunk_blocks
from backend.knowledge.parsers import Block, ParseError
from tests import fake_ollama
from tests.conftest import parse_sse

@pytest.fixture(autouse=True)
def _calibrated_threshold(request):
    """«Векторы» эмулятора — это просто подсчёт общих слов, их близость ниже, чем у настоящей
    bge-m3 (у неё для подходящих фрагментов 0.55–0.75). Поэтому в тестах порог понижаем."""
    if "client" in request.fixturenames:
        request.getfixturevalue("client").put("/api/settings", json={"rag_min_score": 0.15})


# ---------- генераторы тестовых файлов ----------

MD_NOTE = """---
title: Замыкания в JavaScript
tags: [js, функции]
---
# Основы

Замыкание — это функция, которая запоминает переменные из внешней области видимости,
даже после того как внешняя функция завершилась. Подробнее в [[Области видимости|статье про scope]].

![[схема.png]]

## Пример счётчика

```js
function counter() {
  let count = 0;
  return () => ++count;
}
```

%% мой личный комментарий %%
Каждый вызов counter() создаёт новое замыкание со своей переменной count.
"""


def make_pdf(path: Path, pages: list[str]) -> None:
    """Минимальный PDF с текстовым слоем (латиница, шрифт Helvetica) — без сторонних библиотек."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in pages:
        lines = " ".join(f"({line}) Tj T*" for line in text.split("\n"))
        stream = f"BT /F1 12 Tf 14 TL 72 720 Td {lines} ET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        content_id = len(objects)
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                       f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>")
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    path.write_bytes(out)


def make_docx(path: Path) -> None:
    import docx

    d = docx.Document()
    d.add_heading("Алгоритмы сортировки", level=1)
    d.add_heading("Быстрая сортировка", level=2)
    d.add_paragraph("Быстрая сортировка выбирает опорный элемент и делит массив на две части.")
    table = d.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "Алгоритм", "Сложность"
    table.cell(1, 0).text, table.cell(1, 1).text = "Quicksort", "O(n log n)"
    d.save(str(path))


def _wait_indexed(client, timeout=10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get("/api/knowledge").json()
        if data["stats"]["in_progress"] == 0:
            return data
        time.sleep(0.05)
    raise AssertionError("индексация не закончилась")


def _upload(client, files: dict[str, bytes], collection_id=None):
    payload = [("files", (name, content)) for name, content in files.items()]
    data = {"collection_id": str(collection_id)} if collection_id else {}
    r = client.post("/api/knowledge/upload", files=payload, data=data)
    assert r.status_code == 201, r.text
    _wait_indexed(client)
    return r.json()


def _docs(client) -> dict[str, dict]:
    return {d["rel_path"]: d for c in client.get("/api/knowledge").json()["collections"] for d in c["documents"]}


def _ask(client, text, **conv):
    conv_id = client.post("/api/conversations", json=conv).json()["id"]
    events = parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": text}).text)
    return conv_id, events


# ---------- разбор файлов ----------


def test_parse_txt_cp1251(tmp_path):
    p = tmp_path / "старый.txt"
    p.write_bytes("Конспект лекции.\n\nВторой абзац.".encode("cp1251"))
    doc = parsers.parse_file(p)
    assert [b.text for b in doc.blocks] == ["Конспект лекции.", "Второй абзац."]


def test_parse_obsidian_markdown(tmp_path):
    p = tmp_path / "closures.md"
    p.write_text(MD_NOTE, encoding="utf-8")
    doc = parsers.parse_file(p)
    assert doc.title == "Замыкания в JavaScript"
    text = "\n".join(b.text for b in doc.blocks)
    assert "статье про scope" in text and "[[" not in text, "вики-ссылка превращена в текст"
    assert "схема.png" not in text and "личный комментарий" not in text
    assert doc.blocks[0].text.startswith("Теги: js, функции")
    code = [b for b in doc.blocks if b.is_code]
    assert len(code) == 1 and "return () => ++count;" in code[0].text, "блок кода целиком"
    assert code[0].section == "Основы › Пример счётчика"


def test_parse_docx(tmp_path):
    p = tmp_path / "algo.docx"
    make_docx(p)
    doc = parsers.parse_file(p)
    assert doc.blocks[0].section == "Алгоритмы сортировки › Быстрая сортировка"
    assert "Quicksort | O(n log n)" in doc.blocks[1].text


def test_parse_pdf_pages(tmp_path):
    p = tmp_path / "lecture.pdf"
    make_pdf(p, ["Lecture one about closures in JavaScript programming", "Second page explains event loop details"])
    doc = parsers.parse_file(p)
    assert doc.page_count == 2
    assert {b.page for b in doc.blocks} == {1, 2}
    assert "event loop" in " ".join(b.text for b in doc.blocks if b.page == 2)


def test_scanned_pdf_is_reported(tmp_path):
    p = tmp_path / "scan.pdf"
    make_pdf(p, ["", ""])
    with pytest.raises(ParseError, match="скан"):
        parsers.parse_file(p)


def test_unsupported_format(tmp_path):
    p = tmp_path / "virus.exe"
    p.write_bytes(b"MZ")
    with pytest.raises(ParseError, match="не поддерживается"):
        parsers.parse_file(p)


# ---------- нарезка ----------


def test_chunker_size_overlap_sections():
    para = "Предложение номер {} про асинхронность и промисы в JavaScript."
    blocks = [Block(para.format(i), section="Глава 1") for i in range(40)] + [Block("Другая тема.", section="Глава 2")]
    chunks = chunk_blocks(blocks, size=600, overlap=100)
    assert all(len(c.text) <= 750 for c in chunks), "фрагменты примерно нужного размера"
    first, second = chunks[0], chunks[1]
    assert first.text[-40:] in second.text, "соседние фрагменты перекрываются"
    assert chunks[-1].text == "Другая тема." and chunks[-1].section == "Глава 2", "разделы не смешиваются"


def test_chunker_long_paragraph_and_pages():
    long = " ".join(f"Слово{i}." for i in range(400))
    chunks = chunk_blocks([Block(long, page=3), Block("Конец.", page=4)], size=500, overlap=50)
    assert len(chunks) > 3
    assert chunks[0].page_start == 3 and chunks[-1].page_end == 4


# ---------- индексация и поиск ----------


def test_upload_index_and_search(client, tmp_path):
    pdf = tmp_path / "lecture.pdf"
    make_pdf(pdf, ["Closures remember variables from outer scope", "The event loop processes the task queue"])
    data = _upload(client, {"closures.md": MD_NOTE.encode(), "lecture.pdf": pdf.read_bytes(),
                            "notes.txt": "Список покупок: хлеб, молоко.".encode()})
    assert data["collection"]["name"] == "Мои файлы" and data["errors"] == []

    docs = _docs(client)
    assert all(d["status"] == "ready" and d["error"] is None for d in docs.values())
    assert docs["lecture.pdf"]["page_count"] == 2
    stats = client.get("/api/knowledge").json()["stats"]
    assert stats["chunks"] == stats["chunks_with_vectors"] > 0, "у всех фрагментов есть векторы"
    assert fake_ollama.state["last_embed"]["options"] == {"num_gpu": 0}, "эмбеддинги на CPU"

    r = client.get("/api/knowledge/search", params={"q": "что такое замыкание функции"}).json()
    assert r["method"] == "hybrid"
    assert r["results"][0]["title"] == "Замыкания в JavaScript"

    r = client.get("/api/knowledge/search", params={"q": "event loop task queue"}).json()
    hit = r["results"][0]
    assert hit["title"] == "lecture" and hit["page_start"] <= 2 <= hit["page_end"], "страницы PDF известны"


def test_chat_answer_with_sources(client):
    _upload(client, {"closures.md": MD_NOTE.encode()})
    conv_id, events = _ask(client, "Объясни, что такое замыкание и как работает счётчик")
    knowledge = events[0][1]["knowledge"]
    assert knowledge["method"] == "hybrid" and knowledge["sources"]
    src = knowledge["sources"][0]
    assert src["n"] == 1 and src["label"].startswith("Замыкания в JavaScript")

    last = fake_ollama.state["last_request"]["messages"][-1]["content"]
    assert last.startswith("Фрагменты из базы знаний") and "[1] Замыкания в JavaScript" in last
    assert last.endswith("Вопрос пользователя: Объясни, что такое замыкание и как работает счётчик")
    system = fake_ollama.state["last_request"]["messages"][0]["content"]
    assert "Фрагменты" not in system, "фрагменты не в системном промпте — кэш Ollama не сбрасывается"

    msgs = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    assert msgs[0]["content"] == "Объясни, что такое замыкание и как работает счётчик", "в базе — исходный вопрос"
    assert msgs[1]["extras"]["sources"][0]["chunk_id"] == src["chunk_id"]
    assert "[1]" in msgs[1]["content"]


def test_irrelevant_question_gets_no_sources(client):
    _upload(client, {"closures.md": MD_NOTE.encode()})
    _, events = _ask(client, "Спасибо большое, до завтра!")
    assert events[0][1]["knowledge"] == {"method": "none", "sources": []}
    assert "Фрагменты" not in fake_ollama.state["last_request"]["messages"][-1]["content"]


def test_scope_off_and_collection_filter(client, tmp_path):
    first = _upload(client, {"closures.md": MD_NOTE.encode()})["collection"]
    other = client.post("/api/knowledge/collections", json={"name": "Алгоритмы"}).json()
    docx_path = tmp_path / "algo.docx"
    make_docx(docx_path)
    _upload(client, {"algo.docx": docx_path.read_bytes()}, collection_id=other["id"])

    _, events = _ask(client, "Объясни замыкание и счётчик", kb_scope="off")
    assert events[0][1]["knowledge"]["method"] == "off"

    _, events = _ask(client, "Объясни замыкание и счётчик", kb_scope=str(other["id"]))
    titles = {s["title"] for s in events[0][1]["knowledge"]["sources"]}
    assert "Замыкания в JavaScript" not in titles, "искали только в «Алгоритмах»"

    _, events = _ask(client, "Объясни замыкание и счётчик", kb_scope=str(first["id"]))
    assert events[0][1]["knowledge"]["sources"]

    r = client.post("/api/conversations", json={"kb_scope": "999"})
    assert r.status_code == 422


def test_words_only_without_embedding_model_then_reembed(client):
    fake_ollama.state["embed_available"] = False
    _upload(client, {"closures.md": MD_NOTE.encode()})
    doc = _docs(client)["closures.md"]
    assert doc["status"] == "ready" and "ollama pull bge-m3" in doc["error"], "предупреждение, но документ готов"

    r = client.get("/api/knowledge/search", params={"q": "замыкание переменные функции"}).json()
    assert r["method"] == "words" and r["results"], "поиск по словам работает и без векторов"
    _, events = _ask(client, "Как замыкание запоминает переменные функции?")
    assert events[0][1]["knowledge"]["sources"]

    fake_ollama.state["embed_available"] = True
    assert client.post("/api/knowledge/reembed").json()["queued"] == 1
    _wait_indexed(client)
    data = client.get("/api/knowledge").json()
    assert data["stats"]["chunks"] == data["stats"]["chunks_with_vectors"]
    assert _docs(client)["closures.md"]["error"] is None


def test_obsidian_folder_sync(client, tmp_path):
    vault = tmp_path / "Vault"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / ".obsidian" / "workspace.md").write_text("служебное", encoding="utf-8")
    (vault / "Учёба").mkdir()
    (vault / "Учёба" / "Замыкания.md").write_text(MD_NOTE, encoding="utf-8")
    (vault / "Идеи.md").write_text("# Идеи\n\nСделать бота для расписания.", encoding="utf-8")
    (vault / "Удалю.md").write_text("Временная заметка про погоду.", encoding="utf-8")

    r = client.post("/api/knowledge/folders", json={"path": str(vault)})
    assert r.status_code == 201
    collection = r.json()["collection"]
    assert collection["name"] == "Vault" and r.json()["sync"]["added"] == 3, ".obsidian пропущена"
    _wait_indexed(client)
    assert set(_docs(client)) == {"Учёба/Замыкания.md", "Идеи.md", "Удалю.md"}

    # Правка, новая заметка, удаление — и синхронизация
    idea = vault / "Идеи.md"
    idea.write_text("# Идеи\n\nСделать бота для расписания и трекер привычек.", encoding="utf-8")
    os.utime(idea, (time.time() + 5, time.time() + 5))
    (vault / "Новая.md").write_text("Новая заметка о TypeScript дженериках.", encoding="utf-8")
    (vault / "Удалю.md").unlink()
    r = client.post(f"/api/knowledge/collections/{collection['id']}/sync").json()
    assert r == {"added": 1, "updated": 1, "removed": 1, "unchanged": 1}
    _wait_indexed(client)
    hits = client.get("/api/knowledge/search", params={"q": "трекер привычек"}).json()["results"]
    assert hits and hits[0]["title"] == "Идеи"

    assert client.post("/api/knowledge/folders", json={"path": str(vault)}).status_code == 409
    assert client.post("/api/knowledge/folders", json={"path": str(tmp_path / "нет")}).status_code == 422
    # Удаление коллекции-папки НЕ трогает файлы на диске
    client.delete(f"/api/knowledge/collections/{collection['id']}")
    assert (vault / "Новая.md").exists() and _docs(client) == {}


def test_delete_document_cleans_index(client):
    _upload(client, {"closures.md": MD_NOTE.encode()})
    doc = _docs(client)["closures.md"]
    assert client.get("/api/knowledge/search", params={"q": "замыкание функции"}).json()["results"]
    assert client.delete(f"/api/knowledge/documents/{doc['id']}").status_code == 204
    assert client.get("/api/knowledge/search", params={"q": "замыкание функции"}).json()["results"] == []
    assert not Path(doc["file_path"]).exists(), "копия загруженного файла удалена"


def test_file_and_chunk_endpoints(client, tmp_path):
    pdf = tmp_path / "l.pdf"
    make_pdf(pdf, ["Closures remember variables", "Event loop"])
    _upload(client, {"l.pdf": pdf.read_bytes()})
    doc = _docs(client)["l.pdf"]
    r = client.get(f"/api/knowledge/documents/{doc['id']}/file")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline")

    hit = client.get("/api/knowledge/search", params={"q": "closures remember variables"}).json()["results"][0]
    chunk = client.get(f"/api/knowledge/chunks/{hit['id']}").json()
    assert chunk["title"] == "l" and chunk["page_start"] == 1 and chunk["page_end"] == 2
    assert client.get("/api/knowledge/chunks/99999").status_code == 404


def test_upload_errors(client, tmp_path):
    scan = tmp_path / "scan.pdf"
    make_pdf(scan, ["", ""])
    data = _upload(client, {"virus.exe": b"MZ", "scan.pdf": scan.read_bytes()})
    assert len(data["errors"]) == 1 and "не поддерживается" in data["errors"][0]
    doc = _docs(client)["scan.pdf"]
    assert doc["status"] == "error" and "скан" in doc["error"]
    # Документ с ошибкой не ломает чат
    _, events = _ask(client, "Объясни замыкания в JavaScript подробно")
    assert events[-1][0] in ("done", "memory")


def test_delete_upload_collection_removes_files(client):
    data = _upload(client, {"closures.md": MD_NOTE.encode()})
    path = Path(_docs(client)["closures.md"]["file_path"])
    assert path.exists()
    client.delete(f"/api/knowledge/collections/{data['collection']['id']}")
    assert not path.exists() and client.get("/api/knowledge").json()["collections"] == []
