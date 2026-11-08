"""Тесты этапа 10: артефакты — инструкция модели и сжатие старых версий кода в контексте."""

from backend.chat import artifacts
from tests import fake_ollama
from tests.conftest import parse_sse

GAME_V1 = "```html\n<!DOCTYPE html><html><head><title>Змейка</title></head><body><script>v1()</script></body></html>\n```"
GAME_V2 = GAME_V1.replace("v1()", "v2()")
CHART = "```mermaid\nflowchart LR\n A-->B\n```"


def test_is_artifact_and_title():
    assert artifacts.is_artifact("html", "<!DOCTYPE html><title>Игра</title>")
    assert not artifacts.is_artifact("html", "<b>жирный</b>"), "короткий пример тега — не артефакт"
    assert artifacts.is_artifact("svg", "<svg></svg>")
    assert artifacts.artifact_title("html", "<html><title> Тетрис </title>") == "Тетрис"
    assert artifacts.artifact_title("html", "<html><body>") == "Страница"
    assert artifacts.artifact_title("mermaid", "flowchart") == "Схема"


def test_compact_keeps_only_latest_version():
    history = [
        {"role": "user", "content": "сделай змейку"},
        {"role": "assistant", "content": f"Вот:\n\n{GAME_V1}\n\nИ схема:\n{CHART}"},
        {"role": "user", "content": "сделай быстрее"},
        {"role": "assistant", "content": f"Готово:\n\n{GAME_V2}"},
        {"role": "user", "content": "ещё"},
    ]
    compacted = artifacts.compact_history(history)
    old = compacted[1]["content"]
    assert "v1()" not in old and "код «Змейка» (1 строк) опущен" in old, "старая версия игры заменена пометкой"
    assert "A-->B" in old, "схема — другой артефакт, её последняя версия остаётся"
    assert "v2()" in compacted[3]["content"], "последняя версия игры целиком"
    assert history[1]["content"].count("v1()") == 1, "исходная история не изменилась"


def test_compact_uses_corrected_answer_and_unclosed_fence():
    history = [
        {"role": "assistant", "content": "черновик", "corrected": f"исправлено\n{GAME_V1}"},
        {"role": "assistant", "content": "обрыв\n```html\n<!DOCTYPE html><title>Змейка</title><script>v3("},
    ]
    compacted = artifacts.compact_history(history)
    assert "v1()" not in compacted[0]["corrected"] and compacted[0]["content"] == "черновик"
    assert "v3(" in compacted[1]["content"], "оборванный код последней версии не трогаем"


def test_hint_and_compaction_in_chat(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    url = f"/api/conversations/{conv_id}/messages"
    first = parse_sse(client.post(url, json={"content": "Сделай игру змейка"}).text)
    assert "```html" in first[-1][1]["message"]["content"]
    parse_sse(client.post(url, json={"content": "Сделай игру ещё раз"}).text)
    parse_sse(client.post(url, json={"content": "Что умеет игра?"}).text)  # в истории уже две версии
    req = fake_ollama.state["last_request"]
    assert "Артефакты." in req["messages"][0]["content"], "инструкция про артефакты в системном промпте"
    assistant = [m["content"] for m in req["messages"] if m["role"] == "assistant"]
    assert "опущен" in assistant[0] and "<canvas" not in assistant[0] and "<canvas" in assistant[1]

    client.put("/api/settings", json={"artifacts_enabled": False})
    parse_sse(client.post(url, json={"content": "Привет"}).text)
    req = fake_ollama.state["last_request"]
    assert "Артефакты." not in req["messages"][0]["content"]
    assert all("опущен" not in m["content"] for m in req["messages"]), "выключено — история как есть"
