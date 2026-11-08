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
import hashlib
import json
import math
import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Fake Ollama")

GB = 1024**3

# Модели, которые «скачаны». gpu_share — какая доля модели поместится в VRAM 8 ГБ.
MODELS = {
    "qwen3:8b": {
        "family": "qwen3", "parameter_size": "8.2B", "quantization_level": "Q4_K_M",
        "size": 5_225_388_164, "capabilities": ["completion", "tools", "thinking"], "gpu_share": 1.0,
        "arch": {"general.architecture": "qwen3", "qwen3.block_count": 36, "qwen3.attention.head_count_kv": 8,
                 "qwen3.attention.key_length": 128, "qwen3.attention.value_length": 128},
    },
    "llama3.1:8b": {
        "family": "llama", "parameter_size": "8.0B", "quantization_level": "Q4_K_M",
        "size": int(4.9 * GB), "capabilities": ["completion", "tools"], "gpu_share": 1.0,
        # У llama длины K/V не указаны — проверяем запасную формулу «эмбеддинг / головы»
        "arch": {"general.architecture": "llama", "llama.block_count": 32, "llama.attention.head_count_kv": 8,
                 "llama.embedding_length": 4096, "llama.attention.head_count": 32},
    },
    "qwen3:14b": {
        "family": "qwen3", "parameter_size": "14.8B", "quantization_level": "Q4_K_M",
        "size": int(9.3 * GB), "capabilities": ["completion", "tools", "thinking"], "gpu_share": 0.62,
        "arch": {"general.architecture": "qwen3", "qwen3.block_count": 40, "qwen3.attention.head_count_kv": 8,
                 "qwen3.attention.key_length": 128, "qwen3.attention.value_length": 128},
    },
    "bge-m3:latest": {
        "family": "bert", "parameter_size": "566.70M", "quantization_level": "F16",
        "size": int(1.2 * GB), "capabilities": ["embedding"], "gpu_share": 0.0,
    },
}

# Состояние эмулятора — тесты заглядывают сюда, чтобы проверить, что именно прислал наш сервер
state: dict = {}


def reset_state() -> None:
    state.clear()
    state.update(
        loaded={},
        last_request=None,  # последний запрос ЧАТА (с ответом пользователю)
        last_extraction=None,  # последний служебный запрос памяти (с format = JSON-схема)
        extraction_count=0,
        embed_calls=0,
        embed_available=True,  # False — эмулируем «bge-m3 не скачана»
        closed_early=0,
        completed=0,
    )


reset_state()


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
    m = MODELS[name]
    return {"capabilities": m["capabilities"], "details": {"family": m["family"]}, "model_info": m.get("arch", {})}


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
    if body.get("format"):
        return await _extraction(body)
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


@app.get("/_test/last_request")
async def test_last_request():
    """Только для тестов: что последним прислал наш сервер (промпт, параметры генерации)."""
    return state["last_request"] or {}


# ---------- служебный запрос памяти (ответ строго в JSON) ----------


async def _extraction(body: dict):
    """Изображает модель, которая извлекает факты. Правила простые и предсказуемые для тестов."""
    state["last_extraction"] = body
    state["extraction_count"] += 1
    await asyncio.sleep(state.get("extract_delay", 0))  # «модель думает» — для теста закрытой вкладки
    text = body["messages"][-1]["content"]
    user = re.search(r"Пользователь: (.*)\nАссистент:", text, re.DOTALL).group(1)
    known = {int(i): c for i, c in re.findall(r"\[id=(\d+)\] (.*)", text)}
    low = user.lower()
    result: dict = {"add": [], "update": [], "delete": []}

    if "МУСОР" in user:  # модель ответила не JSON — сервер не должен упасть
        content = "Конечно! Вот факты: никаких"
    else:
        if m := re.search(r"меня зовут (\w+)", low):
            result["add"].append({"content": f"Зовут {m.group(1).capitalize()}", "category": "личное"})
        if m := re.search(r"учусь на (\d) курсе", low):
            old = next((i for i, c in known.items() if "курс" in c), None)
            if old:
                result["update"].append({"id": old, "content": f"Учится на {m.group(1)} курсе"})
            else:
                result["add"].append({"content": f"Учится на {m.group(1)} курсе", "category": "учёба"})
        if m := re.search(r"пишу на ([\w, ]+)", low):
            result["add"].append({"content": f"Пишет на {m.group(1).strip()}", "category": "навыки"})
        if "пароль" in low:
            result["add"].append({"content": "Пароль от почты qwerty123", "category": "личное"})
        if m := re.search(r"забудь (?:про |о |что )?(\w+)", low):
            word = m.group(1)[:4]
            result["delete"] += [i for i, c in known.items() if word in c.lower()]
            result["delete"].append(99999)  # чужой id — сервер должен его проигнорировать
        content = json.dumps(result, ensure_ascii=False)

    return {"model": body["model"], "message": {"role": "assistant", "content": content}, "done": True,
            "eval_count": 20, "eval_duration": 400_000_000}


# ---------- эмбеддинги ----------


def _fake_vector(text: str, dims: int = 64) -> list[float]:
    """«Смысловой» вектор из корней слов: тексты с общими корнями получают близкие векторы."""
    vec = [0.0] * dims
    for word in re.findall(r"[a-zа-яё0-9]+", text.lower().replace("ё", "е")):
        if len(word) > 2:
            h = int(hashlib.md5(word[:5].encode()).hexdigest(), 16)
            vec[h % dims] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


@app.post("/api/embed")
async def embed(request: Request):
    body = await request.json()
    name = body.get("model", "")
    if not state["embed_available"] or name.split(":")[0] != "bge-m3":
        return JSONResponse({"error": f"model '{name}' not found, try pulling it first"}, status_code=404)
    state["embed_calls"] += 1
    state["last_embed"] = body
    texts = body["input"] if isinstance(body["input"], list) else [body["input"]]
    return {"model": name, "embeddings": [_fake_vector(t) for t in texts]}


@app.post("/_test/config")
async def test_config(request: Request):
    """Только для тестов: менять поведение эмулятора (например, embed_available)."""
    state.update(await request.json())
    return {"ok": True}


@app.get("/_test/state")
async def test_state():
    return {k: v for k, v in state.items() if k != "loaded"}
