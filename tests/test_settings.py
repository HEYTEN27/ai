"""Тесты этапа 2: настройки, персоны, системный промпт, параметры генерации, оценка VRAM."""

import sqlite3
from datetime import datetime

from backend.chat.prompts import render, today_text
from backend.db import MIGRATIONS, init_db
from backend.settings import vram
from tests import fake_ollama
from tests.conftest import parse_sse


def _personas(client) -> dict:
    return {p["slug"] or p["name"]: p for p in client.get("/api/personas").json()}


def _chat(client, content="Привет", **conv):
    conv_id = client.post("/api/conversations", json=conv).json()["id"]
    r = client.post(f"/api/conversations/{conv_id}/messages", json={"content": content})
    return conv_id, parse_sse(r.text)


def _sent():
    return fake_ollama.state["last_request"]


# ---------- настройки ----------


def test_settings_defaults(client):
    data = client.get("/api/settings").json()
    v = data["values"]
    assert v["assistant_name"] == "Джарвис"
    assert v["num_ctx"] == 8192
    assert v["kv_cache_type"] == "f16"
    assert "{name}" in v["system_prompt"]
    assert data["context_steps"][0] == 2048 and 32768 in data["context_steps"]


def test_settings_update_and_reset(client):
    r = client.put("/api/settings", json={"assistant_name": "Пятница", "num_ctx": 12288})
    assert r.status_code == 200
    assert r.json()["values"]["assistant_name"] == "Пятница"
    assert client.get("/api/health").json()["assistant_name"] == "Пятница"

    r = client.post("/api/settings/reset", json={"keys": ["assistant_name"]})
    assert r.json()["values"]["assistant_name"] == "Джарвис"
    assert r.json()["values"]["num_ctx"] == 12288, "сброшена только указанная настройка"

    client.post("/api/settings/reset", json={})
    assert client.get("/api/settings").json()["values"]["num_ctx"] == 8192


def test_settings_validation(client):
    for bad in ({"num_ctx": 100}, {"assistant_name": ""}, {"kv_cache_type": "q2"}, {"unknown": 1},
                {"vram_total_gb": 0}):
        r = client.put("/api/settings", json=bad)
        assert r.status_code == 422, bad
        assert isinstance(r.json()["detail"], str)


# ---------- персоны ----------


def test_builtin_personas(client):
    p = _personas(client)
    assert list(p)[:5] == ["jarvis", "universal", "teacher", "programmer", "editor"], "Джарвис — первым"
    assert p["programmer"]["temperature"] == 0.3
    assert all(x["builtin"] for x in p.values())


def test_persona_crud(client):
    r = client.post("/api/personas", json={"name": "Переводчик", "icon": "🌍", "prompt": "Переводи на английский",
                                            "temperature": 0.2})
    assert r.status_code == 201
    pid = r.json()["id"]
    assert r.json()["top_k"] == 20, "непереданные параметры — как у «Универсального»"

    r = client.put(f"/api/personas/{pid}", json={"temperature": 0.5, "name": "Переводчик EN"})
    assert r.json()["temperature"] == 0.5 and r.json()["name"] == "Переводчик EN"

    assert client.put(f"/api/personas/{pid}", json={"temperature": 5}).status_code == 422
    assert client.post("/api/personas", json={"prompt": "без имени"}).status_code == 422

    assert client.delete(f"/api/personas/{pid}").status_code == 204
    assert client.delete(f"/api/personas/{pid}").status_code == 404


def test_builtin_persona_cannot_be_deleted_but_can_be_reset(client):
    teacher = _personas(client)["teacher"]
    assert client.delete(f"/api/personas/{teacher['id']}").status_code == 400

    client.put(f"/api/personas/{teacher['id']}", json={"prompt": "испорчено", "temperature": 1.5})
    r = client.post(f"/api/personas/{teacher['id']}/reset")
    assert r.json()["prompt"] == teacher["prompt"] and r.json()["temperature"] == 0.7


# ---------- как настройки попадают в модель ----------


def test_persona_prompt_and_options_sent_to_model(client):
    prog = _personas(client)["programmer"]
    _, events = _chat(client, persona_id=prog["id"])
    assert events[0][1]["persona_id"] == prog["id"]

    req = _sent()
    system = req["messages"][0]["content"]
    assert system.startswith("Тебя зовут Джарвис"), "общий промпт идёт первым"
    assert "опытного разработчика" in system, "затем инструкция персоны"
    assert req["options"] == {"num_ctx": 8192, "temperature": 0.3, "top_p": 0.8, "top_k": 20,
                              "repeat_penalty": 1.0}


def test_default_persona_is_jarvis_with_address(client):
    _, events = _chat(client)
    assert events[0][1]["persona_id"] == _personas(client)["jarvis"]["id"]
    system = _sent()["messages"][0]["content"]
    assert "ИИ-дворецкий" in system and "Обращайся к пользователю «сэр»" in system and "{address}" not in system
    client.put("/api/settings", json={"address": "мисс"})
    _chat(client)
    assert "«Да, мисс.»" in _sent()["messages"][0]["content"], "обращение подставляется из настроек"


def test_universal_persona_has_no_extra_instruction(client):
    _chat(client, persona_id=_personas(client)["universal"]["id"])
    system = _sent()["messages"][0]["content"]
    assert "Сейчас ты в роли" not in system and "дворецкий" not in system
    assert _sent()["options"]["temperature"] == 0.7


def test_theme_and_address_validation(client):
    assert client.put("/api/settings", json={"ui_theme": "classic"}).json()["values"]["ui_theme"] == "classic"
    for bad in ({"ui_theme": "neon"}, {"address": ""}, {"address": "x" * 31}, {"tts_rate": 3}):
        assert client.put("/api/settings", json=bad).status_code == 422, bad
    assert client.get("/api/health").json()["ui_theme"] == "classic"


def test_jarvis_persona_added_to_existing_database(client):
    """У пользователя база с 4 персонами из этапа 2 — «Джарвис» добавляется при запуске и встаёт первым."""
    from backend.db import get_conn
    from backend.settings.personas import ensure_builtin

    with get_conn() as conn:
        conn.execute("DELETE FROM personas WHERE slug = 'jarvis'")
    assert "jarvis" not in _personas(client)
    ensure_builtin()
    assert list(_personas(client))[0] == "jarvis"


def test_default_persona_setting(client):
    editor = _personas(client)["editor"]
    client.put("/api/settings", json={"default_persona_id": editor["id"]})
    _chat(client)
    assert "литературного редактора" in _sent()["messages"][0]["content"]


def test_switch_persona_inside_conversation(client):
    p = _personas(client)
    conv_id, _ = _chat(client, persona_id=p["teacher"]["id"])
    client.patch(f"/api/conversations/{conv_id}", json={"persona_id": p["editor"]["id"]})
    client.post(f"/api/conversations/{conv_id}/messages", json={"content": "Ещё"})
    msgs = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    answers = [m["persona_id"] for m in msgs if m["role"] == "assistant"]
    assert answers == [p["teacher"]["id"], p["editor"]["id"]], "каждый ответ помнит свою персону"

    # PATCH без persona_id не трогает персону, null — сбрасывает на умолчание
    client.patch(f"/api/conversations/{conv_id}", json={"title": "x"})
    assert client.get(f"/api/conversations/{conv_id}").json()["persona_id"] == p["editor"]["id"]
    client.patch(f"/api/conversations/{conv_id}", json={"persona_id": None})
    assert client.get(f"/api/conversations/{conv_id}").json()["persona_id"] is None
    assert client.patch(f"/api/conversations/{conv_id}", json={"persona_id": 9999}).status_code == 422


def test_deleted_persona_falls_back(client):
    pid = client.post("/api/personas", json={"name": "Временная", "prompt": "ВРЕМЕННАЯ"}).json()["id"]
    client.put("/api/settings", json={"default_persona_id": pid})
    conv_id, _ = _chat(client, persona_id=pid)
    client.delete(f"/api/personas/{pid}")
    assert client.get(f"/api/conversations/{conv_id}").json()["persona_id"] is None
    assert client.get("/api/settings").json()["values"]["default_persona_id"] is None
    client.post(f"/api/conversations/{conv_id}/messages", json={"content": "Ещё"})
    assert "ВРЕМЕННАЯ" not in _sent()["messages"][0]["content"]


def test_custom_system_prompt_and_context(client):
    client.put("/api/settings", json={
        "system_prompt": "Я {name}, работаю на {model}. JS: function f() { return {a: 1}; }",
        "assistant_name": "Пятница", "num_ctx": 16384,
    })
    _chat(client)
    system = _sent()["messages"][0]["content"]
    assert system.startswith("Я Пятница, работаю на qwen3:8b. JS: function f() { return {a: 1}; }")
    assert "У тебя есть инструменты" in system  # qwen3 умеет вызывать инструменты — к промпту добавлены правила
    assert _sent()["options"]["num_ctx"] == 16384


def test_num_predict_limits_answer(client):
    pid = client.post("/api/personas", json={"name": "Кратко", "num_predict": 256}).json()["id"]
    _chat(client, persona_id=pid)
    assert _sent()["options"]["num_predict"] == 256


def test_render_and_date():
    assert render("{name} {unknown} {{x}}", {"name": "Д"}) == "Д {unknown} {{x}}"
    assert render("Да, {address}.", {"address": "сэр"}) == "Да, сэр."
    assert today_text(datetime(2026, 11, 7)) == "7 ноября 2026 года, суббота"


# ---------- оценка VRAM ----------


def test_kv_bytes_from_ollama(client):
    models = {m["name"]: m for m in client.get("/api/models").json()["models"]}
    assert models["qwen3:8b"]["kv_bytes_per_token"] == 36 * 8 * 256 * 2  # 144 КиБ
    assert models["llama3.1:8b"]["kv_bytes_per_token"] == 32 * 8 * 256 * 2  # через embedding/heads


def test_vram_estimate_matches_measurement(client):
    """Цифры для RTX 2060 Super (8 ГиБ, 0,8 занято) должны совпадать с замером пользователя."""
    def est(ctx, kv=None):
        params = {"model": "qwen3:8b", "num_ctx": ctx}
        if kv:
            params["kv_cache_type"] = kv
        return client.get("/api/settings/vram-estimate", params=params).json()

    e = est(8192)
    assert e["level"] == "ok" and abs(e["total_gb"] - 5.99) < 0.05  # замер: 5,9 ГиБ
    assert e["max_safe_context"] == 12288
    assert est(16384)["level"] == "warn"
    assert est(24576)["level"] == "danger"
    assert est(16384, "q8_0")["level"] == "ok"
    assert est(16384, "q8_0")["max_safe_context"] == 24576
    assert est(32768, "q8_0")["level"] == "danger"

    assert client.get("/api/settings/vram-estimate", params={"model": "nope", "num_ctx": 8192}).status_code == 404


def test_vram_estimate_unknown_architecture():
    e = vram.estimate(weights_bytes=4 * 1024**3, kv_bytes_per_token=None, num_ctx=8192,
                      kv_cache_type="f16", vram_total_gb=8, vram_reserved_gb=0.8)
    assert e["kv_gb"] is None and "не учтён" in e["message"]


# ---------- миграция старой базы ----------


def test_migration_from_stage1_database(tmp_path):
    """У пользователя уже есть база этапа 1 — после обновления диалоги должны сохраниться."""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(MIGRATIONS[0])
    conn.execute("PRAGMA user_version = 1")
    conn.execute("INSERT INTO conversations VALUES ('c1', 'Старый диалог', 'qwen3:8b', 't', 't')")
    conn.execute("INSERT INTO messages (conversation_id, role, content, stopped, created_at) "
                 "VALUES ('c1', 'user', 'Привет из этапа 1', 0, 't')")
    conn.commit()
    conn.close()

    init_db(db)

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
    conv = conn.execute("SELECT * FROM conversations").fetchone()
    assert conv["title"] == "Старый диалог" and conv["persona_id"] is None
    assert conn.execute("SELECT content FROM messages").fetchone()[0] == "Привет из этапа 1"
