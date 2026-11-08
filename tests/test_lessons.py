"""Тесты этапа 11: уроки из исправлений и 👎, авто-размышления, проверка кода кнопкой."""

import pytest

from backend.chat.complexity import assess
from backend.lessons import learner
from tests import fake_ollama
from tests.conftest import parse_sse


def _chat(client, text, conv_id=None, **extra):
    conv_id = conv_id or client.post("/api/conversations", json={}).json()["id"]
    events = parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": text, **extra}).text)
    return conv_id, events


def _answer_id(events):
    return [d for e, d in events if e == "done"][0]["message"]["id"]


# ---------- уроки ----------


def test_lesson_from_correction_goes_to_prompt(client):
    conv_id, events = _chat(client, "Напиши функцию сложения")
    msg_id = _answer_id(events)
    corrected = "```ts\nfunction add(a: number, b: number): number { return a + b }\n```\nПереписал на TypeScript."
    client.post("/api/dataset/correct", json={"message_id": msg_id, "corrected": corrected})
    r = client.post("/api/lessons/learn", json={"message_id": msg_id, "corrected": corrected}).json()
    assert r["action"] == "added" and r["lesson"]["content"] == "Код пиши на TypeScript"
    assert r["lesson"]["source"] == "correction" and r["lesson"]["message_id"] == msg_id
    sent = fake_ollama.state["last_lesson"]
    assert sent["format"] == learner.RESPONSE_SCHEMA and "think" in sent and sent["think"] is False
    assert "Напиши функцию сложения" in sent["messages"][1]["content"], "модель видит вопрос, ответ и исправление"

    _, events = _chat(client, "Ещё одну функцию", conv_id)
    system = fake_ollama.state["last_request"]["messages"][0]["content"]
    assert "Уроки — как этот пользователь просил отвечать" in system and "- Код пиши на TypeScript" in system
    assert [d for e, d in events if e == "start"][0]["lessons"] == 1


def test_one_off_correction_is_not_a_lesson(client):
    _, events = _chat(client, "Столица Австралии?")
    r = client.post("/api/lessons/learn", json={"message_id": _answer_id(events), "corrected": "Канберра."}).json()
    assert r["action"] == "none" and "разовая" in r["note"]
    assert client.get("/api/lessons").json()["items"] == []


def test_quick_reasons_without_model(client):
    _, events = _chat(client, "Расскажи про HTTP")
    msg_id = _answer_id(events)
    before = fake_ollama.state.get("last_lesson")
    r = client.post("/api/lessons/learn", json={"message_id": msg_id, "quick": ["long"]}).json()
    assert r["action"] == "added" and r["lesson"]["content"].startswith("Отвечай короче")
    assert fake_ollama.state.get("last_lesson") is before, "готовая причина — без запроса к модели"
    r = client.post("/api/lessons/learn", json={"message_id": msg_id, "quick": ["wrong"]}).json()
    assert r["action"] == "none", "ошибка факта правилом не становится"


def test_feedback_with_reason_uses_model(client):
    _, events = _chat(client, "Что такое замыкание?")
    r = client.post("/api/lessons/learn", json={"message_id": _answer_id(events), "quick": ["complex"],
                                                 "reason": "объясни проще, я новичок"}).json()
    assert r["action"] == "added" and "проще" in r["lesson"]["content"]
    assert "Сложно объяснено; объясни проще" in fake_ollama.state["last_lesson"]["messages"][1]["content"]


def test_similar_and_replacing_lessons_merge(client):
    first = client.post("/api/lessons", json={"content": "Код пиши на JavaScript"}).json()
    assert first["action"] == "added"
    _, events = _chat(client, "Сделай сортировку")
    r = client.post("/api/lessons/learn", json={"message_id": _answer_id(events),
                                                 "corrected": "переписал на Python"}).json()
    assert r["action"] == "updated" and r["previous"] == "Код пиши на JavaScript"
    assert [x["content"] for x in client.get("/api/lessons").json()["items"]] == ["Код пиши на Python"]
    # Почти такой же урок вручную — обновляет, а не дублирует
    again = client.post("/api/lessons", json={"content": "код пиши на python!"}).json()
    assert again["action"] == "updated" and len(client.get("/api/lessons").json()["items"]) == 1


def test_lessons_crud_toggle_and_garbage(client):
    lesson = client.post("/api/lessons", json={"content": "Отвечай списками"}).json()["lesson"]
    client.patch(f"/api/lessons/{lesson['id']}", json={"enabled": False})
    _chat(client, "Привет")
    assert "Отвечай списками" not in fake_ollama.state["last_request"]["messages"][0]["content"], "выключенный не идёт в промпт"
    assert client.patch(f"/api/lessons/{lesson['id']}", json={"content": "x" * 400}).status_code == 422
    assert client.delete(f"/api/lessons/{lesson['id']}").status_code == 204
    assert client.delete(f"/api/lessons/{lesson['id']}").status_code == 404

    _, events = _chat(client, "Вопрос")
    r = client.post("/api/lessons/learn", json={"message_id": _answer_id(events), "corrected": "МУСОР"}).json()
    assert r["action"] == "none", "мусор вместо JSON не роняет сервер"
    assert client.post("/api/lessons/learn", json={"message_id": 999999}).status_code == 404


def test_lessons_disabled(client):
    client.post("/api/lessons", json={"content": "Отвечай стихами"})
    client.put("/api/settings", json={"lessons_enabled": False})
    _chat(client, "Привет")
    assert "Отвечай стихами" not in fake_ollama.state["last_request"]["messages"][0]["content"]


def test_lessons_budget():
    lessons = [{"content": f"Правило номер {i} " + "очень длинное " * 10} for i in range(40)]
    block = learner.format_for_prompt(lessons, budget_tokens=200)
    assert 0 < block.count("\n- ") + 1 < 40 and len(block) // 3 < 260


# ---------- авто-размышления ----------


@pytest.mark.parametrize("text, think", [
    ("Реши уравнение x^2 - 5x + 6 = 0 и объясни", True),
    ("Почему не работает мой код?\n```js\nfor (var i=0;i<3;i++) setTimeout(()=>console.log(i))\n```", True),
    ("Сравни 3 способа сортировки и оцени сложность алгоритма каждого", True),
    ("Привет! Как дела?", False),
    ("Переведи слово apple", False),
    ("Напиши письмо преподавателю о переносе дедлайна", False),
    ("Сделай игру змейка", False),
    ("ок", False),
])
def test_complexity(text, think):
    assert assess(text)[0] is think


def test_auto_think_in_chat(client):
    _, events = _chat(client, "Докажи, что корень из 2 иррационален")
    start = [d for e, d in events if e == "start"][0]
    assert start["auto_think"] and start["think"] and "математика" in start["think_reasons"]
    assert fake_ollama.state["last_request"]["think"] is True
    msg = [d for e, d in events if e == "done"][0]["message"]
    assert msg["thinking"] and msg["extras"]["auto_think"] == ["математика"]

    _, events = _chat(client, "Привет, как дела у тебя сегодня?")
    assert [d for e, d in events if e == "start"][0]["auto_think"] is False
    assert fake_ollama.state["last_request"]["think"] is False

    client.put("/api/settings", json={"auto_think": False})
    _chat(client, "Докажи, что корень из 2 иррационален")
    assert fake_ollama.state["last_request"]["think"] is False, "выключено в настройках"

    # Модель без «размышлений» — параметр think не отправляется вовсе
    client.put("/api/settings", json={"auto_think": True})
    _chat(client, "Докажи теорему Пифагора", model="llama3.1:8b")
    assert "think" not in fake_ollama.state["last_request"]


# ---------- «▶ Проверить» ----------


def test_run_python_button(client):
    r = client.post("/api/tools/run-python", json={"code": "print(sum(range(5)))"}).json()
    assert r["stdout"].strip() == "10" and r["exit_code"] == 0
    r = client.post("/api/tools/run-python", json={"code": "1/0"}).json()
    assert "ZeroDivisionError" in r["stderr"] and r["exit_code"] != 0
    r = client.post("/api/tools/run-python", json={"code": "import socket; socket.create_connection(('example.com', 80))"}).json()
    assert r["exit_code"] != 0, "сеть в песочнице закрыта и для кнопки"
    client.put("/api/settings", json={"tool_python": False})
    assert client.post("/api/tools/run-python", json={"code": "print(1)"}).status_code == 403
