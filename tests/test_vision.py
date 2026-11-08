"""Тесты этапа 14: зрение — картинки во вложениях, сканы PDF, подключение модели зрения, скачивание моделей."""

import io
import time

from PIL import Image

from tests import fake_ollama
from tests.conftest import parse_sse


def _of(events, kind):
    return [d for e, d in events if e == kind]


def _png(size=(3000, 2000), mode="RGBA") -> bytes:
    img = Image.new(mode, size, (200, 30, 30, 128) if mode == "RGBA" else (200, 30, 30))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def _scan_pdf() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (1240, 1754), (250, 250, 250)).save(out, format="PDF")  # страница-картинка без текста
    return out.getvalue()


def _upload(client, name, data):
    return client.post("/api/files", files={"file": (name, data)})


def _pull(client, name="qwen3-vl:8b"):
    fake_ollama.state["pull_delay"] = 0
    r = client.post("/api/models/pull", json={"name": name})
    assert r.status_code == 202
    for _ in range(100):
        st = client.get("/api/models/pull").json()
        if st.get("finished"):
            return st
        time.sleep(0.02)
    raise AssertionError("скачивание не закончилось")


def _ask(client, conv_id, text, attachments=(), **extra):
    r = client.post(f"/api/conversations/{conv_id}/messages", json={"content": text, "attachments": list(attachments), **extra})
    return parse_sse(r.text)


def test_image_upload_makes_small_copy(client):
    r = _upload(client, "скрин.png", _png())
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["meta"]["type"] == "image" and f["meta"]["width"] == 3000 and f["meta"]["vision_size"] == [1280, 853]
    assert f["mime"] == "image/png"
    preview = client.get(f"/api/files/{f['id']}/preview")
    assert preview.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(preview.content)).size == (1280, 853), "модели уходит уменьшенная копия"
    assert client.get(f["url"]).content[:4] == b"\x89PNG", "оригинал хранится для скачивания"
    assert _upload(client, "фото.heic", b"x").status_code == 415
    assert _upload(client, "битая.png", b"not an image").status_code == 422


def test_no_vision_model_gives_clear_hint(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    img = _upload(client, "a.png", _png((400, 300))).json()
    events = _ask(client, conv_id, "Что на картинке?", [img["id"]])
    [error] = _of(events, "error")
    assert "модель зрения" in error["message"] and "qwen3-vl:8b" in error["message"]


def test_pull_and_vision_catalog(client):
    cat = client.get("/api/models/vision").json()
    assert cat["selected"] == "qwen3-vl:8b" and not any(m["installed"] for m in cat["models"])
    st = _pull(client)
    assert st["error"] is None and st["completed"] == st["total"] > 0 and st["status"] == "success"
    cat = client.get("/api/models/vision").json()
    assert {m["name"]: m["installed"] for m in cat["models"]}["qwen3-vl:8b"]
    bad = _pull(client, "no-such-model:1b")
    assert "does not exist" in bad["error"]
    assert client.post("/api/models/pull", json={"name": "bad name!"}).status_code == 422


def test_vision_swap_and_follow_up(client):
    _pull(client)
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    img = _upload(client, "ошибка.png", _png()).json()
    events = _ask(client, conv_id, "Что за ошибка на скрине?", [img["id"]])
    start = _of(events, "start")[0]
    assert start["model"] == "qwen3-vl:8b" and start["vision"] == {"model": "qwen3-vl:8b", "images": 1, "instead_of": "qwen3:8b"}
    req = fake_ollama.state["last_request"]
    assert req["model"] == "qwen3-vl:8b" and len(req["messages"][-1]["images"]) == 1
    assert "приложены изображения: «ошибка.png»" in req["messages"][-1]["content"]
    msg = _of(events, "done")[0]["message"]
    assert msg["content"].startswith("Вижу изображений: 1 (1280x853)") and msg["model"] == "qwen3-vl:8b"
    assert msg["extras"]["vision"]["instead_of"] == "qwen3:8b"

    # Уточняющий вопрос без вложения — картинка всё ещё перед глазами
    _ask(client, conv_id, "А что в правом углу?")
    assert len(fake_ollama.state["last_request"]["messages"][-1]["images"]) == 1
    # Через три сообщения картинка уходит из контекста — снова основная модель
    for q in ("Спасибо", "Другой вопрос", "И ещё один"):
        _ask(client, conv_id, q)
    req = fake_ollama.state["last_request"]
    assert req["model"] == "qwen3:8b" and "images" not in req["messages"][-1]


def test_vision_capable_chat_model_is_not_swapped(client):
    _pull(client, "gemma3:4b")
    conv_id = client.post("/api/conversations", json={"model": "gemma3:4b"}).json()["id"]
    img = _upload(client, "a.jpg", _png((640, 480), "RGB")).json()
    events = _ask(client, conv_id, "Опиши", [img["id"]], model="gemma3:4b")
    assert _of(events, "start")[0]["vision"] == {"model": "gemma3:4b", "images": 1, "instead_of": None}


def test_scanned_pdf_goes_as_images(client):
    _pull(client)
    r = _upload(client, "скан.pdf", _scan_pdf())
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["meta"] == {"type": "scan", "pages": 1, "scan_pages": 1}
    assert client.get(f"/api/files/{f['id']}/preview").status_code == 200
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    events = _ask(client, conv_id, "Распознай текст", [f["id"]])
    req = fake_ollama.state["last_request"]
    assert len(req["messages"][-1]["images"]) == 1 and "скан PDF: страницы 1–1 из 1" in req["messages"][-1]["content"]
    assert _of(events, "done")[0]["message"]["content"].startswith("Вижу изображений: 1")
