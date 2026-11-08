"""Тесты этапа 13: рисование картинок (на движке-заглушке), выгрузка модели из видеопамяти, галерея."""

import io
import shutil

from PIL import Image

from backend.images import engine
from backend.images.installer import installer
from tests import fake_ollama
from tests.conftest import parse_sse


def _of(events, kind):
    return [d for e, d in events if e == kind]


def _download(client, model="dreamshaper"):
    shutil.rmtree(engine.model_dir(model), ignore_errors=True)
    r = client.post("/api/images/download", json={"model": model})
    assert r.status_code == 202
    engine.downloader.wait()
    assert engine.is_downloaded(model)


def test_status_install_and_download(client):
    shutil.rmtree(engine.models_dir(), ignore_errors=True)
    st = client.get("/api/images/status").json()
    assert st["installed"] and st["model"] == "dreamshaper"
    assert {m["id"] for m in st["models"]} == {"dreamshaper", "sdxl-turbo"}
    assert not any(m["downloaded"] for m in st["models"])
    # Без скачанной модели инструмент рисования модели не предлагается
    tools = {t["name"]: t for t in client.get("/api/tools").json()}
    assert tools["generate_image"]["reason"] == "модель изображений не скачана"

    client.post("/api/images/install", json={})
    installer._thread.join(5)
    assert installer.state["finished"] and not installer.state["error"]
    cmds = installer.commands()
    assert "download.pytorch.org/whl/cu126" in cmds[0][-1] and any("diffusers" in p for p in cmds[1])

    _download(client)
    assert engine.downloader.state["done"] == engine.downloader.state["total"] > 0
    assert client.post("/api/images/download", json={"model": "нет"}).status_code == 409
    assert client.get("/api/tools").json() and \
        {t["name"]: t for t in client.get("/api/tools").json()}["generate_image"]["available"]
    assert client.delete("/api/images/models/dreamshaper").status_code == 204
    assert client.delete("/api/images/models/dreamshaper").status_code == 404


def test_generate_api_translates_and_unloads(client):
    _download(client)
    # Модель «загружена» в видеопамять — перед рисованием её нужно выгрузить
    parse_sse(client.post(f"/api/conversations/{client.post('/api/conversations', json={}).json()['id']}/messages",
                          json={"content": "Привет"}).text)
    assert fake_ollama.state["loaded"]
    r = client.post("/api/images/generate", json={"prompt": "кот на подоконнике", "orientation": "portrait", "seed": 42})
    assert r.status_code == 200, r.text
    data = r.json()
    assert not fake_ollama.state["loaded"] and fake_ollama.state.get("unloads", 0) >= 1, "видеопамять освобождена"
    assert data["seed"] == 42 and data["prompt"] != "кот на подоконнике", "русская просьба переведена в промпт"
    [img] = data["images"]
    assert img["meta"]["width"] == 512 and img["meta"]["height"] == 768 and img["meta"]["request"] == "кот на подоконнике"
    png = client.get(img["url"]).content
    assert Image.open(io.BytesIO(png)).size == (512, 768)
    # Тот же seed — та же картинка (повторяемость)
    again = client.post("/api/images/generate", json={"prompt": data["prompt"], "translate": False, "seed": 42,
                                                     "orientation": "portrait"}).json()
    assert client.get(again["images"][0]["url"]).content == png

    gallery = client.get("/api/images/gallery").json()["items"]
    assert len(gallery) == 2 and gallery[0]["meta"]["seed"] == 42
    assert client.delete(f"/api/images/{img['id']}").status_code == 204
    assert len(client.get("/api/images/gallery").json()["items"]) == 1
    assert client.post("/api/images/generate", json={"prompt": "x", "conversation_id": "нет"}).status_code == 404


def test_generate_without_model(client):
    shutil.rmtree(engine.models_dir(), ignore_errors=True)
    r = client.post("/api/images/generate", json={"prompt": "cat", "translate": False})
    assert r.status_code == 503 and "не скачана" in r.json()["detail"]


def test_image_tool_in_chat_with_progress(client, monkeypatch):
    monkeypatch.setenv("FAKE_IMAGE_STEP", "0.03")  # рисуем «медленно», чтобы прогресс успел дойти до чата
    _download(client)
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    events = parse_sse(client.post(f"/api/conversations/{conv_id}/messages",
                                   json={"content": "Нарисуй кота, два варианта"}).text)
    assert "generate_image" in _of(events, "start")[0]["tools"]
    progress = _of(events, "tool_progress")
    assert progress and any(p.get("stage") == "draw" for p in progress), "в чат шёл прогресс рисования"
    [result] = _of(events, "tool_result")
    assert result["status"] == "ok" and len(result["display"]["images"]) == 2
    assert result["display"]["prompt"].startswith("a cute red cat")
    tool_msg = fake_ollama.state["last_request"]["messages"][-1]
    assert tool_msg["role"] == "tool" and "Нарисовано изображений: 2" in tool_msg["content"]
    msg = _of(events, "done")[0]["message"]
    conv = client.get(f"/api/conversations/{conv_id}").json()
    assert conv["messages"][-1]["extras"]["tools"][0]["display"]["images"][0]["url"].endswith("/download")
    # Картинки удаляются вместе с диалогом
    client.delete(f"/api/conversations/{conv_id}")
    assert client.get("/api/images/gallery").json()["items"] == []
    assert msg["id"]


def test_image_tool_disabled(client):
    _download(client)
    client.put("/api/settings", json={"tool_images": False})
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    events = parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": "Нарисуй кота"}).text)
    assert "generate_image" not in _of(events, "start")[0]["tools"]
    assert client.put("/api/settings", json={"image_model": "нет"}).status_code == 422


def test_more_variants_saved_into_chat_card(client):
    _download(client)
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    events = parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": "Нарисуй кота"}).text)
    [result] = _of(events, "tool_result")
    msg_id = _of(events, "done")[0]["message"]["id"]
    r = client.post("/api/images/generate", json={"prompt": result["display"]["prompt"], "translate": False,
                                                 "conversation_id": conv_id, "message_id": msg_id, "tool_id": result["id"]})
    assert r.status_code == 200
    saved = client.get(f"/api/conversations/{conv_id}").json()["messages"][-1]["extras"]["tools"][0]["display"]
    assert len(saved["images"]) == 2, "«Ещё вариант» остался в карточке после перезагрузки"
