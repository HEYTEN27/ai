"""Тесты этапа 6: датасет — 👍/👎, исправления, снимки, экспорт SFT и DPO."""

import json
import sqlite3
import time

from backend.config import settings as env
from backend.db import MIGRATIONS, init_db
from tests import fake_ollama
from tests.conftest import parse_sse
from tests.test_knowledge import MD_NOTE


def _conv(client, **kw) -> str:
    return client.post("/api/conversations", json=kw).json()["id"]


def _say(client, conv_id, text):
    return parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": text}).text)


def _answers(client, conv_id) -> list[dict]:
    return [m for m in client.get(f"/api/conversations/{conv_id}").json()["messages"] if m["role"] == "assistant"]


def _rate(client, message_id, rating):
    r = client.post("/api/dataset/feedback", json={"message_id": message_id, "rating": rating})
    assert r.status_code == 200, r.text
    return r.json()


def _jsonl(client, **params) -> list[dict]:
    r = client.get("/api/dataset/export", params=params)
    assert r.status_code == 200 and r.headers["content-disposition"].startswith("attachment")
    return [json.loads(line) for line in r.text.splitlines()]


def test_like_creates_snapshot_and_sft_example(client):
    conv = _conv(client)
    _say(client, conv, "Привет! Как дела?")
    _say(client, conv, "Объясни замыкания коротко")
    answer = _answers(client, conv)[-1]

    data = _rate(client, answer["id"], 1)
    ex = data["example"]
    assert ex["rating"] == 1 and ex["in_sft"] is True and ex["persona"] == "Джарвис"
    assert ex["question"] == "Объясни замыкания коротко"
    assert [m["role"] for m in ex["history"]] == ["user", "assistant"], "предыдущий обмен — в истории"
    assert ex["system_prompt"].startswith("Тебя зовут Джарвис")
    assert "У тебя есть инструменты" not in ex["system_prompt"], "в снимке только имя и персона — без служебных блоков"
    assert data["stats"]["in_sft"] == 1

    [row] = _jsonl(client, format="sft")
    roles = [m["role"] for m in row["messages"]]
    assert roles == ["system", "user", "assistant", "user", "assistant"]
    assert row["messages"][-1]["content"] == answer["content"]
    assert [m["role"] for m in _jsonl(client, format="sft", system="false")[0]["messages"]][0] == "user"

    # Оценка видна в чате после перезагрузки
    assert _answers(client, conv)[-1]["rating"] == 1


def test_unrate_removes_example_and_dislike_is_not_trained(client):
    conv = _conv(client)
    _say(client, conv, "Расскажи анекдот про программистов")
    mid = _answers(client, conv)[-1]["id"]
    _rate(client, mid, 1)
    assert _rate(client, mid, 0)["example"] is None, "оценку сняли — пример удалён"
    ex = _rate(client, mid, -1)["example"]
    assert ex["rating"] == -1 and ex["in_sft"] is False
    assert _jsonl(client, format="sft") == []
    assert client.get("/api/dataset").json()["stats"]["bad"] == 1


def test_correction_becomes_target_and_dpo_pair(client):
    conv = _conv(client)
    _say(client, conv, "Сколько будет дважды два без инструментов, просто ответь")
    answer = _answers(client, conv)[-1]
    _rate(client, answer["id"], -1)
    r = client.post("/api/dataset/correct", json={"message_id": answer["id"], "corrected": "Четыре."})
    ex = r.json()["example"]
    assert ex["corrected"] == "Четыре." and ex["rating"] == -1 and ex["in_sft"] is True, "исправленный — в выборке"

    [sft] = _jsonl(client, format="sft")
    assert sft["messages"][-1] == {"role": "assistant", "content": "Четыре."}
    [dpo] = _jsonl(client, format="dpo")
    assert dpo["chosen"] == [{"role": "assistant", "content": "Четыре."}]
    assert dpo["rejected"][0]["content"] == answer["content"]
    assert dpo["prompt"][-1]["content"].startswith("Сколько будет дважды два")

    # В чате видно исправление, а в следующем запросе модель получает исправленную версию
    assert _answers(client, conv)[-1]["corrected"] == "Четыре."
    _say(client, conv, "А трижды три?")
    sent = fake_ollama.state["last_request"]["messages"]
    assert {"role": "assistant", "content": "Четыре."} in sent

    # Убрать исправление (и оценку) — пример удаляется
    client.post("/api/dataset/correct", json={"message_id": answer["id"], "corrected": ""})
    assert _rate(client, answer["id"], 0)["example"] is None


def test_correction_same_as_original_is_ignored(client):
    conv = _conv(client)
    _say(client, conv, "Скажи что-нибудь доброе")
    answer = _answers(client, conv)[-1]
    r = client.post("/api/dataset/correct", json={"message_id": answer["id"], "corrected": answer["content"] + "  "})
    assert r.json()["example"] is None


def test_example_survives_conversation_deletion(client):
    conv = _conv(client)
    _say(client, conv, "Что почитать по алгоритмам?")
    _rate(client, _answers(client, conv)[-1]["id"], 1)
    client.delete(f"/api/conversations/{conv}")
    [ex] = client.get("/api/dataset").json()["items"]
    assert ex["message_id"] is None and ex["conversation_id"] is None and ex["in_sft"]
    assert len(_jsonl(client, format="sft")) == 1


def test_tool_answers_excluded_by_default(client):
    conv = _conv(client)
    _say(client, conv, "Посчитай 12*12")
    ex = _rate(client, _answers(client, conv)[-1]["id"], 1)["example"]
    assert ex["used_tools"] is True and ex["in_sft"] is False
    assert _jsonl(client, format="sft") == []
    assert len(_jsonl(client, format="sft", tools="true")) == 1


def test_rag_answer_keeps_fragments_or_strips_citations(client):
    client.put("/api/settings", json={"rag_min_score": 0.15})
    files = [("files", ("closures.md", MD_NOTE.encode()))]
    client.post("/api/knowledge/upload", files=files)
    for _ in range(100):
        if client.get("/api/knowledge").json()["stats"]["in_progress"] == 0:
            break
        time.sleep(0.05)
    conv = _conv(client)
    _say(client, conv, "Объясни замыкание и счётчик по моему конспекту")
    answer = _answers(client, conv)[-1]
    assert "[1]" in answer["content"]

    ex = _rate(client, answer["id"], 1)["example"]
    assert ex["question"].startswith("Фрагменты из базы знаний") and not ex["strip_citations"]
    assert "[1]" in _jsonl(client, format="sft")[0]["messages"][-1]["content"]

    # Документ удалили до оценки следующего ответа — ссылки вести некуда, их вырезаем
    _say(client, conv, "Ещё раз объясни замыкание и счётчик")
    second = _answers(client, conv)[-1]
    doc_id = client.get("/api/knowledge").json()["collections"][0]["documents"][0]["id"]
    client.delete(f"/api/knowledge/documents/{doc_id}")
    ex2 = _rate(client, second["id"], 1)["example"]
    assert ex2["strip_citations"] and not ex2["question"].startswith("Фрагменты")
    target = _jsonl(client, format="sft")[-1]["messages"][-1]["content"]
    assert "[1]" not in target and "По вашим материалам" in target


def test_dataset_page_operations(client):
    conv = _conv(client)
    _say(client, conv, "Первый вопрос для датасета")
    _say(client, conv, "Второй вопрос для датасета")
    a1, a2 = _answers(client, conv)
    e1 = _rate(client, a1["id"], 1)["example"]
    _rate(client, a2["id"], -1)

    data = client.get("/api/dataset").json()
    assert data["stats"] == {**data["stats"], "total": 2, "in_sft": 1, "good": 1, "bad": 1, "target": 200}
    assert [e["id"] for e in client.get("/api/dataset", params={"filter": "good"}).json()["items"]] == [e1["id"]]

    r = client.patch(f"/api/dataset/{e1['id']}", json={"included": False})
    assert r.json()["in_sft"] is False and _jsonl(client, format="sft") == []
    client.patch(f"/api/dataset/{e1['id']}", json={"included": True, "corrected": "Лучший ответ", "question": "Уточнённый вопрос"})
    [row] = _jsonl(client, format="sft")
    assert row["messages"][-2:] == [{"role": "user", "content": "Уточнённый вопрос"},
                                    {"role": "assistant", "content": "Лучший ответ"}]
    assert client.patch(f"/api/dataset/{e1['id']}", json={"question": "  "}).status_code == 400

    assert client.delete(f"/api/dataset/{e1['id']}").status_code == 204
    assert client.delete(f"/api/dataset/{e1['id']}").status_code == 404
    assert client.get("/api/dataset/export", params={"format": "xml"}).status_code == 422


def test_files_are_written_on_disk(client):
    conv = _conv(client)
    _say(client, conv, "Вопрос, который попадёт в файл")
    _rate(client, _answers(client, conv)[-1]["id"], 1)
    path = env.data_dir / "dataset" / "train_sft.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["messages"][-2]["content"] == "Вопрос, который попадёт в файл"
    assert (env.data_dir / "dataset" / "train_dpo.jsonl").exists()


def test_feedback_validation(client):
    conv = _conv(client)
    _say(client, conv, "Привет, это проверка")
    user_msg = client.get(f"/api/conversations/{conv}").json()["messages"][0]
    assert client.post("/api/dataset/feedback", json={"message_id": user_msg["id"], "rating": 1}).status_code == 400
    assert client.post("/api/dataset/feedback", json={"message_id": 99999, "rating": 1}).status_code == 404
    mid = _answers(client, conv)[0]["id"]
    assert client.post("/api/dataset/feedback", json={"message_id": mid, "rating": 5}).status_code == 400


def test_migration_5_from_stage4_db(tmp_path):
    db = tmp_path / "v4.db"
    conn = sqlite3.connect(db)
    for sql in MIGRATIONS[:4]:
        conn.executescript(sql)
    conn.execute("PRAGMA user_version = 4")
    conn.commit()
    conn.close()
    init_db(db)
    conn = sqlite3.connect(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
    assert conn.execute("SELECT COUNT(*) FROM dataset_examples").fetchone()[0] == 0
