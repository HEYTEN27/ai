"""
Эмулятор Ollama для тестов и разработки без видеокарты.

Повторяет формат настоящего API Ollama (/api/tags, /api/show, /api/chat, /api/ps),
но вместо нейросети отвечает заготовленным текстом. Позволяет проверить
стриминг, «размышления», ошибки и предупреждение о нехватке VRAM.

Запуск отдельным сервером (например, чтобы потыкать интерфейс без Ollama):
    python -m uvicorn tests.fake_ollama:app --port 11434
Задержка между токенами: переменная окружения FAKE_DELAY (секунды, по умолчанию 0.03).
"""

import asyncio
import json
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Fake Ollama")

GB = 1024**3

# Модели, которые «скачаны». gpu_share — какая доля модели поместится в VRAM 8 ГБ.
MODELS = {
    "qwen3:8b": {
        "family": "qwen3", "parameter_size": "8.2B", "quantization_level": "Q4_K_M",
        "size": int(5.2 * GB), "capabilities": ["completion", "tools", "thinking"], "gpu_share": 1.0,
    },
    "llama3.1:8b": {
        "family": "llama", "parameter_size": "8.0B", "quantization_level": "Q4_K_M",
        "size": int(4.9 * GB), "capabilities": ["completion", "tools"], "gpu_share": 1.0,
    },
    "qwen3:14b": {
        "family": "qwen3", "parameter_size": "14.8B", "quantization_level": "Q4_K_M",
        "size": int(9.3 * GB), "capabilities": ["completion", "tools", "thinking"], "gpu_share": 0.62,
    },
    "bge-m3:latest": {
        "family": "bert", "parameter_size": "566.70M", "quantization_level": "F16",
        "size": int(1.2 * GB), "capabilities": ["embedding"], "gpu_share": 0.0,
    },
}

# Состояние эмулятора — тесты заглядывают сюда, чтобы проверить, что именно прислал наш сервер
state: dict = {"loaded": {}, "last_request": None, "closed_early": 0, "completed": 0}


def reset_state() -> None:
    state.update(loaded={}, last_request=None, closed_early=0, completed=0)


def _delay() -> float:
    return float(os.getenv("FAKE_DELAY", "0.03"))


@app.get("/api/version")
async def version():
    return {"version": "0.34.4-fake"}


@app.get("/api/tags")
async def tags():
    return {
        "models": [
            {
                "name": name, "model": name, "size": m["size"], "digest": f"sha256:{abs(hash(name))}",
                "details": {
                    "family": m["family"], "parameter_size": m["parameter_size"],
                    "quantization_level": m["quantization_level"], "format": "gguf",
                },
            }
            for name, m in MODELS.items()
        ]
    }


@app.post("/api/show")
async def show(request: Request):
    name = (await request.json()).get("model")
    if name not in MODELS:
        return JSONResponse({"error": f"model '{name}' not found"}, status_code=404)
    return {"capabilities": MODELS[name]["capabilities"], "details": {"family": MODELS[name]["family"]}}


@app.get("/api/ps")
async def ps():
    return {"models": list(state["loaded"].values())}


def _answer_text(question: str) -> str:
    return (
        f"Вы спросили: «{question[:80]}». Это **тестовый ответ** эмулятора Ollama.\n\n"
        "Пример кода:\n\n```python\ndef hello(name):\n    return f\"Привет, {name}!\"\n```\n\n"
        "- пункт первый\n- пункт второй\n"
    )


def _tokens(text: str) -> list[str]:
    """Режем текст на кусочки по словам, сохраняя пробелы — как это делает настоящая модель."""
    parts, current = [], ""
    for ch in text:
        current += ch
        if ch in " \n":
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    return parts


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    state["last_request"] = body
    name = body.get("model")
    if name not in MODELS:
        return JSONResponse({"error": f"model '{name}' not found, try pulling it first"}, status_code=404)
    model = MODELS[name]
    if "embedding" in model["capabilities"]:
        return JSONResponse({"error": f'"{name}" does not support chat'}, status_code=400)
    # Настоящая Ollama отвечает ошибкой, если просить «думать» модель, которая не умеет
    if "think" in body and "thinking" not in model["capabilities"]:
        return JSONResponse({"error": f'"{name}" does not support thinking'}, status_code=400)

    num_ctx = (body.get("options") or {}).get("num_ctx", 4096)
    state["loaded"][name] = {
        "name": name, "model": name, "size": model["size"],
        "size_vram": int(model["size"] * model["gpu_share"]), "context_length": num_ctx,
    }

    question = body["messages"][-1]["content"]
    thinking = _tokens("Пользователь спрашивает. Надо ответить коротко и по делу.") if body.get("think") else []
    content = _tokens(_answer_text(question))

    async def stream():
        finished = False
        try:
            for t in thinking:
                yield json.dumps({"model": name, "message": {"role": "assistant", "content": "", "thinking": t}, "done": False}) + "\n"
                await asyncio.sleep(_delay())
            for i, t in enumerate(content):
                # Специальное слово в вопросе — эмулируем сбой посреди генерации
                if "СБОЙ" in question and i == 3:
                    yield json.dumps({"error": "CUDA error: out of memory"}) + "\n"
                    return
                yield json.dumps({"model": name, "message": {"role": "assistant", "content": t}, "done": False}) + "\n"
                await asyncio.sleep(_delay())
            yield json.dumps({
                "model": name, "message": {"role": "assistant", "content": ""}, "done": True,
                "done_reason": "stop", "total_duration": 2_500_000_000, "load_duration": 100_000_000,
                "prompt_eval_count": 42, "eval_count": len(content), "eval_duration": 2_000_000_000,
            }) + "\n"
            finished = True
            state["completed"] += 1
        finally:
            if not finished:
                state["closed_early"] += 1

    return StreamingResponse(stream(), media_type="application/x-ndjson")
