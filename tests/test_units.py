"""Модульные тесты: сборка контекста, миграции, разбор размеров, адаптер llama.cpp."""

import asyncio
import json
import sqlite3

import httpx

from backend.chat.context import build_messages, estimate_tokens
from backend.db import MIGRATIONS, init_db
from backend.llm.base import LoadedModel, parse_parameter_size
from backend.llm.llamacpp import LlamaCppBackend


def test_parse_parameter_size():
    assert parse_parameter_size("8.2B") == 8.2
    assert parse_parameter_size("566.70M") == 0.567
    assert parse_parameter_size(None) is None
    assert parse_parameter_size("abc") is None


def test_loaded_model_percent():
    assert LoadedModel("m", 100, 100).fully_on_gpu is True
    assert LoadedModel("m", 100, 62).gpu_percent == 62.0
    assert LoadedModel("m", 0, 0).gpu_percent == 0.0


def test_context_keeps_recent_messages():
    history = [{"role": "user" if i % 2 == 0 else "assistant", "content": "x" * 3000} for i in range(20)]
    msgs = build_messages(history, num_ctx=8192)
    total = sum(estimate_tokens(m["content"]) for m in msgs)
    assert total <= 8192 - 2048, "должно остаться место на ответ"
    assert msgs[-1] == {"role": "assistant", "content": "x" * 3000}  # самые свежие — на месте
    assert len(msgs) < len(history)


def test_context_always_keeps_last_question():
    huge = {"role": "user", "content": "я" * 100_000}
    assert build_messages([huge], num_ctx=8192) == [{"role": "user", "content": huge["content"]}]


def test_context_with_system_prompt():
    msgs = build_messages([{"role": "user", "content": "привет"}], num_ctx=8192, system_prompt="Ты учитель")
    assert msgs[0] == {"role": "system", "content": "Ты учитель"}


def test_migrations_are_idempotent(tmp_path):
    db = tmp_path / "t.db"
    init_db(db)
    init_db(db)  # повторный запуск не должен падать
    conn = sqlite3.connect(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"conversations", "messages"} <= tables


def test_llamacpp_stream():
    """Адаптер llama.cpp разбирает OpenAI-совместимый поток SSE."""
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "qwen3-8b.gguf"}]})
        sent.update(json.loads(request.content))
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "хм"}}]},
            {"choices": [{"delta": {"content": "При"}}]},
            {"choices": [{"delta": {"content": "вет"}, "finish_reason": "stop"}],
             "timings": {"prompt_n": 5, "predicted_n": 2, "predicted_per_second": 33.3}},
        ]
        body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    async def run():
        backend = LlamaCppBackend("http://fake", transport=httpx.MockTransport(handler))
        models = await backend.list_models()
        chunks = [c async for c in backend.chat_stream(
            "qwen3-8b.gguf", [{"role": "user", "content": "hi"}], think=False,
            options={"num_ctx": 8192, "temperature": 0.5},
        )]
        await backend.close()
        return models, chunks

    models, chunks = asyncio.run(run())
    assert models[0].name == "qwen3-8b.gguf"
    assert [(c.kind, c.text) for c in chunks[:3]] == [("thinking", "хм"), ("content", "При"), ("content", "вет")]
    assert chunks[-1].kind == "done" and chunks[-1].stats["tokens_per_second"] == 33.3
    assert sent["temperature"] == 0.5 and "num_ctx" not in sent  # num_ctx задаётся при запуске сервера
    assert sent["chat_template_kwargs"] == {"enable_thinking": False}
