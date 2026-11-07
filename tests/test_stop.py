"""
Тест кнопки «Стоп» на настоящих HTTP-серверах.

Поднимаем два сервера uvicorn в фоновых потоках: эмулятор Ollama (медленный,
50 мс на токен) и наше приложение. Начинаем читать ответ, обрываем соединение
и проверяем, что:
  1) частичный ответ сохранился в базе с пометкой stopped;
  2) наш сервер закрыл поток к Ollama (иначе видеокарта продолжала бы зря генерировать).
"""

import os
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from backend.chat import repository as repo
from backend.llm import set_backend
from backend.llm.ollama import OllamaBackend
from tests import fake_ollama


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_server(app, port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            return server
        time.sleep(0.05)
    raise RuntimeError("сервер не запустился")


@pytest.fixture
def live_servers(fresh_db):
    from backend.main import app

    os.environ["FAKE_DELAY"] = "0.05"
    fake_ollama.reset_state()
    ollama_port, app_port = _free_port(), _free_port()
    ollama_server = _start_server(fake_ollama.app, ollama_port)
    set_backend(OllamaBackend(f"http://127.0.0.1:{ollama_port}"))
    app_server = _start_server(app, app_port)
    yield f"http://127.0.0.1:{app_port}"
    app_server.should_exit = True
    ollama_server.should_exit = True
    os.environ["FAKE_DELAY"] = "0"
    set_backend(None)
    time.sleep(0.3)


def test_stop_saves_partial_answer_and_cancels_ollama(live_servers):
    base = live_servers
    conv_id = httpx.post(f"{base}/api/conversations", json={}).json()["id"]

    received = 0
    with httpx.stream("POST", f"{base}/api/conversations/{conv_id}/messages",
                      json={"content": "Расскажи длинно"}, timeout=10) as r:
        for line in r.iter_lines():
            if line.startswith("event: token"):
                received += 1
                if received == 5:
                    break  # «нажали Стоп»: выходим из with — соединение закрывается
    assert received == 5

    # Даём серверу немного времени заметить обрыв
    for _ in range(40):
        msgs = repo.list_messages(conv_id)
        if len(msgs) == 2:
            break
        time.sleep(0.1)

    assert [m["role"] for m in msgs] == ["user", "assistant"]
    answer = msgs[1]
    assert answer["stopped"] is True
    assert 0 < len(answer["content"]) < len(fake_ollama._answer_text("Расскажи длинно"))
    assert fake_ollama.state["closed_early"] == 1, "поток к Ollama должен быть закрыт"
    assert fake_ollama.state["completed"] == 0
