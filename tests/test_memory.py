"""Тесты этапа 3: долговременная память."""

from backend.memory import extraction, retrieval
from backend.memory import repository as memory_repo
from tests import fake_ollama
from tests.conftest import parse_sse


def _conv(client) -> str:
    return client.post("/api/conversations", json={}).json()["id"]


def _say(client, conv_id, text) -> list:
    r = client.post(f"/api/conversations/{conv_id}/messages", json={"content": text})
    return parse_sse(r.text)


def _facts(client) -> list[str]:
    return [m["content"] for m in client.get("/api/memory").json()["items"]]


def _memory_events(events) -> list[dict]:
    return next((d["events"] for e, d in events if e == "memory"), [])


# ---------- ручное управление ----------


def test_manual_crud_and_undo(client):
    r = client.post("/api/memory", json={"content": "  учится в МГТУ  ", "category": "учёба"})
    assert r.status_code == 201
    fact = r.json()
    assert fact["content"] == "Учится в МГТУ" and fact["source"] == "manual"

    r = client.put(f"/api/memory/{fact['id']}", json={"content": "Учится в МГТУ им. Баумана", "pinned": True})
    assert r.json()["pinned"] is True

    event_id = client.delete(f"/api/memory/{fact['id']}").json()["event_id"]
    assert _facts(client) == []
    client.post(f"/api/memory/events/{event_id}/undo")
    assert _facts(client) == ["Учится в МГТУ им. Баумана"], "удаление отменено"
    assert client.post(f"/api/memory/events/{event_id}/undo").status_code == 400, "дважды отменить нельзя"

    actions = [e["action"] for e in client.get("/api/memory/events").json()]
    assert actions == ["delete", "update", "add"]


def test_validation_and_search(client):
    assert client.post("/api/memory", json={"content": ""}).status_code == 422
    assert client.post("/api/memory", json={"content": "x" * 301}).status_code == 422
    r = client.post("/api/memory", json={"content": "Любит котов", "category": "непонятно"})
    assert r.json()["category"] == "другое"
    client.post("/api/memory", json={"content": "Живёт в Казани"})
    data = client.get("/api/memory", params={"q": "КАЗАН"}).json()
    assert [m["content"] for m in data["items"]] == ["Живёт в Казани"], "поиск без учёта регистра"
    assert data["stats"]["count"] == 2


def test_delete_all_requires_confirm(client):
    client.post("/api/memory", json={"content": "Факт"})
    assert client.delete("/api/memory").status_code == 400
    assert client.delete("/api/memory", params={"confirm": "yes"}).json() == {"deleted": 1}
    assert _facts(client) == []


# ---------- автоматическое запоминание ----------


def test_auto_extraction_and_usage(client):
    conv = _conv(client)
    events = _say(client, conv, "Привет! Меня зовут Олег, я учусь на 2 курсе и пишу на JavaScript")
    saved = _memory_events(events)
    assert [e["new_content"] for e in saved] == ["Зовут Олег", "Учится на 2 курсе", "Пишет на javascript"]
    assert all(e["action"] == "add" and e["conversation_id"] == conv for e in saved)

    # Служебный запрос: тот же контекст, что у чата (без перезагрузки модели), JSON-схема, без «размышлений»
    req = fake_ollama.state["last_extraction"]
    assert req["options"] == {"num_ctx": 8192, "temperature": 0.0}
    assert req["think"] is False and req["format"]["required"] == ["add", "update", "delete"]

    # В следующем ответе факты попадают в системный промпт
    events = _say(client, conv, "Что посоветуешь почитать?")
    start = events[0][1]
    assert start["memory"]["method"] == "all" and len(start["memory"]["facts"]) == 3
    system = fake_ollama.state["last_request"]["messages"][0]["content"]
    assert "Что ты знаешь о пользователе" in system and "- Зовут Олег" in system

    msg = client.get(f"/api/conversations/{conv}").json()["messages"][-1]
    assert len(msg["extras"]["memory_ids"]) == 3
    assert all(m["use_count"] == 1 for m in client.get("/api/memory").json()["items"])

    # Диалог возвращает события памяти — чтобы показать «Запомнил» после перезагрузки страницы
    conv_data = client.get(f"/api/conversations/{conv}").json()
    assert len(conv_data["memory_events"]) == 3


def test_update_and_forget(client):
    conv = _conv(client)
    _say(client, conv, "Меня зовут Олег, я учусь на 2 курсе и пишу на JavaScript")
    events = _say(client, conv, "Кстати, теперь я учусь на 3 курсе, перевёлся")
    upd = _memory_events(events)
    assert [(e["action"], e["old_content"], e["new_content"]) for e in upd] == [
        ("update", "Учится на 2 курсе", "Учится на 3 курсе")]

    events = _say(client, conv, "Забудь про javascript пожалуйста, это уже неактуально")
    deleted = _memory_events(events)
    assert [(e["action"], e["old_content"]) for e in deleted] == [("delete", "Пишет на javascript")]
    assert sorted(_facts(client)) == ["Зовут Олег", "Учится на 3 курсе"], "чужой id 99999 проигнорирован"

    # Отмена «забудь» прямо из чата возвращает факт
    client.post(f"/api/memory/events/{deleted[0]['id']}/undo")
    assert "Пишет на javascript" in _facts(client)


def test_sensitive_data_never_saved(client):
    conv = _conv(client)
    events = _say(client, conv, "Запомни мой пароль от почты, пожалуйста: qwerty123")
    assert _memory_events(events) == []
    assert _facts(client) == []


def test_short_messages_skip_extraction(client):
    conv = _conv(client)
    _say(client, conv, "Спасибо!")
    _say(client, conv, "ок")
    assert fake_ollama.state["extraction_count"] == 0


def test_garbage_json_does_not_break_chat(client):
    conv = _conv(client)
    events = _say(client, conv, "Тут модель ответит МУСОР вместо JSON, посмотрим")
    assert events[-1][0] == "done" and _facts(client) == []


def test_duplicates_are_skipped(client):
    conv = _conv(client)
    _say(client, conv, "Привет, меня зовут Олег, рад знакомству")
    _say(client, conv, "Ещё раз: меня зовут Олег, если что")
    assert _facts(client) == ["Зовут Олег"]


def test_memory_switches(client):
    conv = _conv(client)
    client.post("/api/memory", json={"content": "Любит котов"})

    client.put("/api/settings", json={"memory_autosave": False})
    _say(client, conv, "Меня зовут Олег, я учусь на 2 курсе")
    assert fake_ollama.state["extraction_count"] == 0, "автозапоминание выключено"
    assert "Любит котов" in fake_ollama.state["last_request"]["messages"][0]["content"], "но память используется"

    client.put("/api/settings", json={"memory_enabled": False})
    events = _say(client, conv, "Расскажи что-нибудь интересное про космос")
    assert events[0][1]["memory"] == {"method": "off", "facts": []}
    assert "Любит котов" not in fake_ollama.state["last_request"]["messages"][0]["content"]


# ---------- выбор фактов, когда их много ----------


def _many_facts(client):
    for i in range(40):
        client.post("/api/memory", json={"content": f"Любимое число номер {i} равно {i * 7}"})
    client.post("/api/memory", json={"content": "Увлекается программированием игр на Python"})
    client.post("/api/memory", json={"content": "Зовут Олег", "pinned": True})
    client.put("/api/settings", json={"memory_budget_tokens": 60})


def test_semantic_selection_when_memory_is_big(client):
    _many_facts(client)
    conv = _conv(client)
    events = _say(client, conv, "Посоветуй проект по программированию")
    mem = events[0][1]["memory"]
    facts = [f["content"] for f in mem["facts"]]
    assert mem["method"] == "semantic"
    assert "Зовут Олег" in facts, "закреплённый факт — всегда"
    assert "Увлекается программированием игр на Python" in facts, "подходящий по смыслу факт найден"
    assert len(facts) < 42, "все 42 факта не влезли бы в бюджет"
    assert fake_ollama.state["last_embed"]["options"] == {"num_gpu": 0}, "эмбеддинги — на CPU"

    # Векторы сохранены: повторный вопрос считает эмбеддинг только для самого вопроса
    calls = fake_ollama.state["embed_calls"]
    _say(client, conv, "А ещё идеи по программированию?")
    assert fake_ollama.state["embed_calls"] == calls + 1


def test_lexical_fallback_without_embedding_model(client):
    fake_ollama.state["embed_available"] = False
    _many_facts(client)
    data = client.get("/api/memory").json()
    assert data["embedding"] == {"model": "bge-m3", "available": True}  # в /api/tags она есть...
    conv = _conv(client)
    events = _say(client, conv, "Посоветуй проект по программированию")
    mem = events[0][1]["memory"]
    assert mem["method"] == "lexical", "...но /api/embed не отвечает — ищем по словам"
    assert "Увлекается программированием игр на Python" in [f["content"] for f in mem["facts"]]


# ---------- модульные ----------


def test_sensitive_filter():
    assert extraction.is_sensitive("Карта 4276 1234 5678 9012")
    assert extraction.is_sensitive("Пароль от wifi: 12345678")
    assert extraction.is_sensitive("Телефон +7 999 123-45-67")
    assert not extraction.is_sensitive("Учится на 3 курсе с 2023 года")


def test_parse_response_is_robust():
    assert extraction.parse_response("не json") == {"add": [], "update": [], "delete": []}
    assert extraction.parse_response('Вот: {"add": [{"content": "Факт"}], "delete": ["x", 3]}') == {
        "add": [{"content": "Факт"}], "update": [], "delete": [3]}


def test_worth_checking():
    assert not extraction.worth_checking("спасибо")
    assert extraction.worth_checking("Запомни: я сова")
    assert extraction.worth_checking("Меня зовут Оля")


def test_lexical_and_cosine():
    assert retrieval.lexical_score("где я учусь", "Учится в МГТУ") == 0  # «учус» ≠ «учит» — поэтому нужны эмбеддинги
    assert retrieval.lexical_score("задача по программированию", "Любит программирование") > 0.3
    assert abs(retrieval.cosine([1, 0], [1, 0]) - 1) < 1e-9 and retrieval.cosine([1, 0], [0, 1]) == 0


def test_vector_packing():
    vec = [0.5, -1.25, 3.0]
    assert memory_repo.unpack_vector(memory_repo.pack_vector(vec)) == vec
