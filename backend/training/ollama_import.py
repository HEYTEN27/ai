"""
Подключение обученной модели к Ollama — то же, что `ollama create`, но кнопкой из приложения.

Как это устроено в Ollama:
  1. Файл модели загружается как «блоб» (POST /api/blobs/sha256:<хэш>). Хэш SHA-256 —
     «отпечаток» файла: Ollama по нему проверяет, что файл дошёл целым, и не грузит повторно.
  2. POST /api/create создаёт модель из блоба: имя, шаблон чата и параметры.

Почему копируем шаблон с qwen3:8b: в GGUF после Colab шаблон тоже есть, но Ollama
определяет умения модели (вызов инструментов, «размышления») по своему шаблону.
Возьмём шаблон исходной модели — и у дообученной всё это будет работать так же.

Два варианта файла:
  * gguf    — полная модель (основной вариант, ~5 ГБ). Если файл несжатый (f16, после
              локального обучения) — можно попросить Ollama сжать до Q4_K_M;
  * adapter — только LoRA-адаптер в GGUF (~100 МБ) поверх уже скачанной qwen3:8b.
"""

import asyncio
import hashlib
import json
import re
from pathlib import Path

import httpx

CHUNK = 4 * 1024 * 1024
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}(:[a-z0-9._-]{1,40})?$")
UPLOAD_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=None, pool=10.0)
MIN_MODEL_BYTES = 100 * 1024 * 1024  # полная модель 8B весит гигабайты; меньше 100 МБ — скорее адаптер


class ImportError_(ValueError):
    """Ошибка подключения с понятным текстом (подчёркивание — чтобы не путать со встроенным ImportError)."""


def validate(path: str, name: str, kind: str) -> Path:
    if kind not in ("gguf", "adapter"):
        raise ImportError_("Вид файла: gguf (полная модель) или adapter (LoRA)")
    if not NAME_RE.match(name):
        raise ImportError_("Имя модели: маленькие латинские буквы, цифры, точка, дефис, «_», например jarvis-qwen3")
    file = Path(path.strip().strip('"')).expanduser()
    if not file.is_file():
        raise ImportError_(f"Файл не найден: {file}")
    if file.suffix.lower() != ".gguf":
        raise ImportError_("Нужен файл .gguf (его делает ноутбук Colab на шаге 13)")
    if kind == "gguf" and file.stat().st_size < MIN_MODEL_BYTES:
        raise ImportError_("Файл меньше 100 МБ — это не полная модель. Если это адаптер LoRA, выберите вариант «адаптер».")
    return file


def parse_parameters(text: str) -> dict:
    """«stop "<|im_end|>"\\ntemperature 0.6» из /api/show → {"stop": [...], "temperature": 0.6}."""
    params: dict = {}
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        key, _, value = line.strip().partition(" ")
        value = value.strip().strip('"')
        if key == "stop":
            params.setdefault("stop", []).append(value)
            continue
        for cast in (int, float):
            try:
                value = cast(value)
                break
            except ValueError:
                continue
        params[key] = value
    return params


def sha256_file(path: Path, progress: dict) -> str:
    h = hashlib.sha256()
    total = path.stat().st_size or 1
    done = 0
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            done += len(chunk)
            progress["value"] = done / total
    return "sha256:" + h.hexdigest()


async def import_model(client: httpx.AsyncClient, *, path: str, name: str, kind: str,
                       base_model: str = "qwen3:8b", quantize: str | None = None):
    """Асинхронный генератор событий: {"stage": ..., "progress": 0..1, "message": ...}."""
    file = validate(path, name, kind)
    size_gb = file.stat().st_size / 1024**3

    # Шаблон и параметры исходной модели (нужны и для проверки, что она скачана)
    try:
        r = await client.post("/api/show", json={"model": base_model})
    except httpx.HTTPError as e:
        raise ImportError_("Ollama недоступна — запустите её и попробуйте снова") from e
    if r.status_code != 200:
        raise ImportError_(f"Исходная модель {base_model} не найдена в Ollama: ollama pull {base_model}")
    base = r.json()

    # 1. Отпечаток файла — в отдельном потоке, чтобы не тормозить сервер (5 ГБ ≈ 10–30 с)
    progress = {"value": 0.0}
    yield {"stage": "hash", "progress": 0, "message": f"Считаю контрольную сумму ({size_gb:.1f} ГБ)…"}
    task = asyncio.create_task(asyncio.to_thread(sha256_file, file, progress))
    while not task.done():
        await asyncio.sleep(0.5)
        yield {"stage": "hash", "progress": round(progress["value"], 3)}
    digest = await task

    # 2. Загрузка в Ollama (если такого файла там ещё нет)
    exists = (await client.head(f"/api/blobs/{digest}")).status_code == 200
    if exists:
        yield {"stage": "upload", "progress": 1, "message": "Этот файл уже есть в Ollama — загрузка не нужна"}
    else:
        yield {"stage": "upload", "progress": 0, "message": "Копирую файл в Ollama…"}
        sent = {"bytes": 0}
        total = file.stat().st_size or 1

        async def body():
            with file.open("rb") as f:
                while chunk := f.read(CHUNK):
                    sent["bytes"] += len(chunk)
                    yield chunk

        upload = asyncio.create_task(client.post(f"/api/blobs/{digest}", content=body(), timeout=UPLOAD_TIMEOUT))
        while not upload.done():
            await asyncio.sleep(0.5)
            yield {"stage": "upload", "progress": round(sent["bytes"] / total, 3)}
        response = await upload
        if response.status_code not in (200, 201):
            raise ImportError_(f"Ollama не приняла файл: {response.text[:200]}")

    # 3. Создание модели
    payload: dict = {"model": name, "stream": True}
    if kind == "adapter":
        payload.update({"from": base_model, "adapters": {file.name: digest}})
    else:
        payload.update({"files": {file.name: digest}, "template": base.get("template", ""),
                        "parameters": parse_parameters(base.get("parameters", ""))})
        if quantize:
            payload["quantize"] = quantize
    yield {"stage": "create", "progress": 0, "message": "Создаю модель в Ollama…"}
    async with client.stream("POST", "/api/create", json=payload, timeout=UPLOAD_TIMEOUT) as r:
        if r.status_code != 200:
            await r.aread()
            raise ImportError_(f"Ollama не смогла создать модель: {r.text[:300]}")
        async for line in r.aiter_lines():
            if not line.strip():
                continue
            data = json.loads(line)
            if data.get("error"):
                hint = " Попробуйте полный GGUF вместо адаптера." if kind == "adapter" else ""
                raise ImportError_(f"Ollama: {data['error']}.{hint}")
            yield {"stage": "create", "message": data.get("status", "")}
    full_name = name if ":" in name else f"{name}:latest"
    yield {"stage": "done", "progress": 1, "model": full_name,
           "message": f"Модель {full_name} готова — выберите её в списке моделей вверху"}
