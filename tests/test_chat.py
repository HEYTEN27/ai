"""Тесты этапа 1: диалоги, стриминг, выбор модели, ошибки, индикатор VRAM."""

from tests import fake_ollama
from tests.conftest import parse_sse


def _new_conv(client, **kwargs) -> str:
    r = client.post("/api/conversations", json=kwargs)
    assert r.status_code == 201
    return r.json()["id"]


def _send(client, conv_id, content, **kwargs):
    r = client.post(f"/api/conversations/{conv_id}/messages", json={"content": content, **kwargs})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    return parse_sse(r.text)


# ---------- служебное API ----------


def test_health(client):
    data = client.get("/api/health").json()
    assert data == {
        "backend": "ollama", "assistant_name": "Джарвис", "ui_theme": "hud", "address": "сэр",
        "ok": True, "version": "0.34.4-fake", "error": None,
    }


def test_models_list(client):
    data = client.get("/api/models").json()
    names = [m["name"] for m in data["models"]]
    assert "bge-m3:latest" not in names, "модель эмбеддингов не должна попадать в список чата"
    assert [m["name"] for m in data["embedding_models"]] == ["bge-m3:latest"]
    assert data["default_model"] == "qwen3:8b"
    by_name = {m["name"]: m for m in data["models"]}
    assert by_name["qwen3:8b"]["supports_thinking"] is True
    assert by_name["qwen3:8b"]["is_large"] is False
    assert by_name["llama3.1:8b"]["supports_thinking"] is False
    assert by_name["qwen3:14b"]["is_large"] is True  # пометка «медленно, частично на CPU»


# ---------- диалоги ----------


def test_conversation_crud(client):
    conv_id = _new_conv(client)
    assert client.get("/api/conversations").json()[0]["title"] == "Новый чат"

    r = client.patch(f"/api/conversations/{conv_id}", json={"title": "Учёба"})
    assert r.json()["title"] == "Учёба"

    assert client.delete(f"/api/conversations/{conv_id}").status_code == 204
    assert client.get(f"/api/conversations/{conv_id}").status_code == 404
    assert client.delete(f"/api/conversations/{conv_id}").status_code == 404


def test_empty_message_rejected(client):
    conv_id = _new_conv(client)
    assert client.post(f"/api/conversations/{conv_id}/messages", json={"content": ""}).status_code == 422
    assert client.post(f"/api/conversations/{conv_id}/messages", json={"content": "   "}).status_code == 422


# ---------- стриминг ----------


def test_stream_and_history(client):
    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Что такое замыкание в JavaScript?")
    kinds = [e for e, _ in events]

    assert kinds[0] == "start" and kinds[-1] == "done"
    assert kinds.count("token") > 10, "ответ должен приходить по кусочкам"
    streamed = "".join(d["text"] for e, d in events if e == "token")

    # Ответ сохранился в базе ровно в том виде, в каком пришёл
    conv = client.get(f"/api/conversations/{conv_id}").json()
    assert conv["title"] == "Что такое замыкание в JavaScript?"
    assert conv["model"] == "qwen3:8b"
    roles = [m["role"] for m in conv["messages"]]
    assert roles == ["user", "assistant"]
    answer = conv["messages"][1]
    assert answer["content"] == streamed
    assert answer["stopped"] is False
    assert answer["stats"]["tokens_per_second"] > 0

    # В модель ушли нужные параметры: контекст 8K и выключенные «размышления»
    req = fake_ollama.state["last_request"]
    assert req["options"]["num_ctx"] == 8192
    assert req["think"] is False


def test_history_is_sent_to_model(client):
    conv_id = _new_conv(client)
    _send(client, conv_id, "Первый вопрос")
    _send(client, conv_id, "Второй вопрос")
    sent = fake_ollama.state["last_request"]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert sent[1]["content"] == "Первый вопрос"
    # Название диалога задаётся только первым сообщением
    assert client.get(f"/api/conversations/{conv_id}").json()["title"] == "Первый вопрос"


def test_thinking_qwen3(client):
    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Подумай", think=True)
    assert any(e == "thinking" for e, _ in events)
    msg = client.get(f"/api/conversations/{conv_id}").json()["messages"][-1]
    assert msg["thinking"].startswith("Пользователь спрашивает")
    # «Размышления» не отправляются обратно в модель вместе с историей
    _send(client, conv_id, "Ещё вопрос")
    assert all("thinking" not in m for m in fake_ollama.state["last_request"]["messages"])


def test_think_not_sent_to_models_without_support(client):
    """llama3.1 не умеет «думать»: параметр think не должен уходить, иначе Ollama вернёт ошибку."""
    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Привет", model="llama3.1:8b", think=True)
    assert events[-1][0] == "done"
    assert "think" not in fake_ollama.state["last_request"]


def test_model_switch_inside_conversation(client):
    conv_id = _new_conv(client)
    _send(client, conv_id, "Привет")
    _send(client, conv_id, "А теперь ты", model="llama3.1:8b")
    conv = client.get(f"/api/conversations/{conv_id}").json()
    assert conv["model"] == "llama3.1:8b"
    assert [m["model"] for m in conv["messages"] if m["role"] == "assistant"] == ["qwen3:8b", "llama3.1:8b"]


def test_regenerate(client):
    conv_id = _new_conv(client)
    _send(client, conv_id, "Вопрос")
    r = client.post(f"/api/conversations/{conv_id}/regenerate", json={"model": "llama3.1:8b"})
    events = parse_sse(r.text)
    assert events[-1][0] == "done"
    msgs = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"], "старый ответ заменяется новым"
    assert msgs[1]["model"] == "llama3.1:8b"


def test_system_prompt_has_name_and_model(client):
    """Модель получает системный промпт с именем «Джарвис» и честным названием своей модели."""
    conv_id = _new_conv(client)
    _send(client, conv_id, "Как тебя зовут?", model="llama3.1:8b")
    system = fake_ollama.state["last_request"]["messages"][0]
    assert system["role"] == "system"
    assert "Тебя зовут Джарвис" in system["content"]
    assert "llama3.1:8b" in system["content"]


# ---------- ошибки ----------


def test_unknown_model(client):
    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Привет", model="mistral:7b")
    assert events[-1][0] == "error"
    assert "ollama pull mistral:7b" in events[-1][1]["message"]


def test_embedding_model_cannot_chat(client):
    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Привет", model="bge-m3:latest")
    assert events[-1][0] == "error"
    assert "эмбеддингов" in events[-1][1]["message"]


def test_error_mid_stream_saves_partial(client):
    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Вызови СБОЙ")
    assert events[-1][0] == "error"
    assert "out of memory" in events[-1][1]["message"]
    msg = client.get(f"/api/conversations/{conv_id}").json()["messages"][-1]
    assert msg["role"] == "assistant" and msg["stopped"] is True and msg["content"]


def test_ollama_not_running(client):
    """Ollama выключена: понятное сообщение вместо падения сервера."""
    from backend.llm import set_backend
    from backend.llm.ollama import OllamaBackend

    set_backend(OllamaBackend("http://127.0.0.1:1"))  # на этом порту никого нет
    health = client.get("/api/health").json()
    assert health["ok"] is False and "Ollama" in health["error"]

    r = client.get("/api/models")
    assert r.status_code == 503 and "ollama serve" in r.json()["detail"]

    conv_id = _new_conv(client)
    events = _send(client, conv_id, "Привет")
    assert events[-1][0] == "error"
    assert "Не удаётся подключиться к Ollama" in events[-1][1]["message"]


# ---------- индикатор VRAM ----------


def test_vram_status(client):
    assert client.get("/api/status").json()["loaded"] == []

    conv_id = _new_conv(client)
    _send(client, conv_id, "Привет")  # qwen3:8b целиком в VRAM
    status = client.get("/api/status").json()
    assert status["loaded"][0]["fully_on_gpu"] is True
    assert status["warning"] is None

    _send(client, conv_id, "Привет", model="qwen3:14b")  # не влезает в 8 ГБ
    status = client.get("/api/status").json()
    assert "qwen3:14b" in status["warning"] and "62%" in status["warning"]
