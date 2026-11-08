"""Тесты этапа 15а: проекты, ветки при правке вопроса, поиск по диалогам, стили ответов."""

from tests import fake_ollama
from tests.conftest import parse_sse


def _of(events, kind):
    return [d for e, d in events if e == kind]


def _ask(client, conv_id, text, **extra):
    return parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": text, **extra}).text)


def _new(client, **data):
    return client.post("/api/conversations", json=data).json()["id"]


# ---------- проекты ----------


def test_project_instructions_and_files_in_every_chat(client):
    p = client.post("/api/projects", json={"name": "Курсовая по БД", "icon": "🗄️",
                                           "instructions": "Пиши примеры на PostgreSQL."}).json()
    up = client.post("/api/files", files={"file": ("тема.txt", "Тема курсовой: учёт книг в библиотеке.".encode())},
                     data={"project_id": str(p["id"])})
    assert up.status_code == 201 and up.json()["project_id"] == p["id"]
    conv_id = _new(client, project_id=p["id"])
    events = _ask(client, conv_id, "Какая у меня тема?")
    req = fake_ollama.state["last_request"]
    assert "в проекте «Курсовая по БД»" in req["messages"][0]["content"] and "PostgreSQL" in req["messages"][0]["content"]
    assert "Тема курсовой: учёт книг" in req["messages"][-1]["content"], "файл проекта в контексте"
    assert _of(events, "start")[0]["files"][0]["name"] == "тема.txt"

    detail = client.get(f"/api/projects/{p['id']}").json()
    assert [c["id"] for c in detail["conversations"]] == [conv_id] and detail["files"][0]["name"] == "тема.txt"
    assert client.get("/api/projects").json()[0] | {} and client.get("/api/projects").json()[0]["chats"] == 1
    assert client.get(f"/api/conversations/{conv_id}").json()["project"]["name"] == "Курсовая по БД"

    # Чат вне проекта ничего о проекте не знает
    other = _new(client)
    _ask(client, other, "Привет")
    assert "Курсовая" not in fake_ollama.state["last_request"]["messages"][0]["content"]

    # Перенос чата в проект и обратно
    client.patch(f"/api/conversations/{other}", json={"project_id": p["id"]})
    assert len(client.get(f"/api/projects/{p['id']}").json()["conversations"]) == 2
    client.patch(f"/api/conversations/{other}", json={"project_id": None})
    assert len(client.get(f"/api/projects/{p['id']}").json()["conversations"]) == 1

    # Файл проекта можно удалить; переименование; удаление проекта не удаляет чаты
    assert client.delete(f"/api/files/{up.json()['id']}").status_code == 204
    assert client.patch(f"/api/projects/{p['id']}", json={"name": "Курсовая"}).json()["name"] == "Курсовая"
    assert client.delete(f"/api/projects/{p['id']}").status_code == 204
    assert client.get(f"/api/conversations/{conv_id}").json()["project_id"] is None


def test_project_validation(client):
    assert client.post("/api/projects", json={"name": ""}).status_code == 422
    assert client.post("/api/conversations", json={"project_id": 999}).status_code == 422
    assert client.get("/api/projects/999").status_code == 404
    p = client.post("/api/projects", json={"name": "П"}).json()
    r = client.post("/api/files", files={"file": ("a.png", b"x")}, data={"project_id": str(p["id"])})
    assert r.status_code == 415, "картинки в проект не кладём"


# ---------- стиль ----------


def test_style_goes_to_prompt(client):
    conv_id = _new(client, style="concise")
    _ask(client, conv_id, "Что такое HTTP?")
    assert "КРАТКО" in fake_ollama.state["last_request"]["messages"][0]["content"]
    client.patch(f"/api/conversations/{conv_id}", json={"style": "simple"})
    _ask(client, conv_id, "А HTTPS?")
    system = fake_ollama.state["last_request"]["messages"][0]["content"]
    assert "ПРОСТЫМИ СЛОВАМИ" in system and "КРАТКО" not in system
    assert client.patch(f"/api/conversations/{conv_id}", json={"style": "стихами"}).status_code == 422


# ---------- ветки ----------


def test_edit_creates_branch_and_switching(client):
    conv_id = _new(client)
    _ask(client, conv_id, "Первый вопрос")
    _ask(client, conv_id, "Второй вопрос про var")
    msgs = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    second_q = msgs[2]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]

    r = client.post(f"/api/conversations/{conv_id}/messages/{second_q['id']}/edit", json={"content": "Второй вопрос про let"})
    events = parse_sse(r.text)
    assert "про let" in _of(events, "done")[0]["message"]["content"]
    req = fake_ollama.state["last_request"]
    assert [m["content"] for m in req["messages"] if m["role"] == "user"] == ["Первый вопрос", "Второй вопрос про let"], \
        "модель не видит старую ветку"

    msgs = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    assert len(msgs) == 4 and msgs[2]["content"] == "Второй вопрос про let"
    assert msgs[2]["branch"] == {"index": 2, "count": 2, "ids": [second_q["id"], msgs[2]["id"]]}
    assert "branch" not in msgs[0], "у первого вопроса веток нет"

    # Переключаемся на старую версию — видна старая ветка целиком, с её ответом
    conv = client.post(f"/api/conversations/{conv_id}/branch", json={"message_id": second_q["id"]}).json()
    assert conv["messages"][2]["content"] == "Второй вопрос про var" and conv["messages"][2]["branch"]["index"] == 1
    assert "про var" in conv["messages"][3]["content"]
    # Новый вопрос продолжает активную (старую) ветку
    _ask(client, conv_id, "Третий")
    users = [m["content"] for m in fake_ollama.state["last_request"]["messages"] if m["role"] == "user"]
    assert users == ["Первый вопрос", "Второй вопрос про var", "Третий"]

    # «Повторить» работает внутри ветки
    parse_sse(client.post(f"/api/conversations/{conv_id}/regenerate", json={}).text)
    msgs = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    assert [m["content"] for m in msgs if m["role"] == "user"] == ["Первый вопрос", "Второй вопрос про var", "Третий"]
    assert len(msgs) == 6

    # Править можно только сообщение текущей ветки
    other_branch_q = [i for i in conv["messages"][2]["branch"]["ids"] if i != second_q["id"]][0]
    r = client.post(f"/api/conversations/{conv_id}/messages/{other_branch_q}/edit", json={"content": "x"})
    assert r.status_code == 404


def test_rating_works_on_any_branch(client):
    conv_id = _new(client)
    _ask(client, conv_id, "Вопрос A")
    first_answer = client.get(f"/api/conversations/{conv_id}").json()["messages"][1]
    q = client.get(f"/api/conversations/{conv_id}").json()["messages"][0]
    parse_sse(client.post(f"/api/conversations/{conv_id}/messages/{q['id']}/edit", json={"content": "Вопрос B"}).text)
    # Ответ из неактивной ветки всё равно можно оценить — пример строится по его собственной ветке
    r = client.post("/api/dataset/feedback", json={"message_id": first_answer["id"], "rating": 1})
    assert r.status_code == 200 and r.json()["example"]["question"] == "Вопрос A"


# ---------- поиск ----------


def test_search_messages_and_titles(client):
    a = _new(client)
    _ask(client, a, "Объясни замыкания в JavaScript")
    b = _new(client)
    _ask(client, b, "Как приготовить борщ?")
    r = client.get("/api/search", params={"q": "замык"}).json()
    hits = r["messages"]
    assert hits and all(h["conversation_id"] == a for h in hits)
    assert "\u0001" in hits[0]["snippet"], "совпадение подсвечено"
    assert hits[0]["title"].startswith("Объясни замыкания")
    assert client.get("/api/search", params={"q": "борщ приготовить"}).json()["messages"][0]["conversation_id"] == b
    assert r["conversations"][0]["id"] == a, "нашлось и по названию"
    assert client.get("/api/search", params={"q": "!!"}).json()["messages"] == []
    assert client.get("/api/search", params={"q": 'AND OR "NEAR'}).status_code == 200, "операторы FTS не ломают запрос"
    # Удалённый диалог пропадает из поиска (триггер чистит индекс)
    client.delete(f"/api/conversations/{a}")
    assert client.get("/api/search", params={"q": "замык"}).json()["messages"] == []
