"""
Служебное API: связь с движком, список моделей, состояние видеопамяти.

  GET /api/health  — запущена ли Ollama, её версия
  GET /api/models  — модели для чата и модели эмбеддингов
  GET /api/status  — какие модели загружены и помещаются ли они в VRAM
  GET  /api/models/vision  — модели зрения: какие рекомендуем и какие скачаны (этап 14)
  POST /api/models/pull    — скачать модель через Ollama: {name}
  GET  /api/models/pull    — прогресс скачивания
"""

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..llm import LLMError, get_backend
from ..settings import store as settings_store

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health():
    backend = get_backend()
    return {
        "backend": backend.name,
        "assistant_name": settings_store.get("assistant_name"),
        # Для интерфейса сразу при загрузке: тема и обращение («Добрый вечер, сэр»)
        "ui_theme": settings_store.get("ui_theme"),
        "address": settings_store.get("address"),
        **(await backend.health()),
    }


@router.get("/models")
async def models():
    backend = get_backend()
    try:
        all_models = await backend.list_models()
    except LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    chat_models = [m for m in all_models if not m.is_embedding]
    names = [m.name for m in chat_models]
    # Модель по умолчанию: из настроек, если скачана, иначе первая попавшаяся
    preferred = settings_store.get("default_model")
    default = preferred if preferred in names else (names[0] if names else None)
    return {
        "backend": backend.name,
        "default_model": default,
        "models": [m.to_dict() for m in chat_models],
        "embedding_models": [m.to_dict() for m in all_models if m.is_embedding],
        "num_ctx": settings_store.get("num_ctx"),
    }


@router.get("/status")
async def status():
    """Индикатор VRAM.

    Ollama сообщает для каждой загруженной модели общий размер (size)
    и сколько из него в видеопамяти (size_vram). Если size_vram < size,
    часть слоёв модели считается на процессоре — это в разы медленнее.
    """
    backend = get_backend()
    try:
        loaded = await backend.loaded_models()
        embedding_names = {m.name for m in await backend.list_models() if m.is_embedding}
    except LLMError as e:
        return {"supported": True, "ok": False, "error": str(e), "loaded": [], "warning": None}

    if loaded is None:
        return {"supported": False, "ok": True, "error": None, "loaded": [], "warning": None}

    warning = None
    # Модели эмбеддингов мы специально держим на CPU, поэтому их не учитываем
    partial = [m for m in loaded if m.name not in embedding_names and not m.fully_on_gpu]
    if partial:
        m = partial[0]
        warning = (
            f"Модель {m.name} помещается в видеопамять только на {m.gpu_percent:.0f}% — "
            "остальное в оперативной памяти, ответы будут заметно медленнее. "
            "Уменьшите контекст, закройте программы, которые используют видеокарту "
            "(браузер, Wallpaper Engine), или выберите модель поменьше."
        )
    return {
        "supported": True,
        "ok": True,
        "error": None,
        "loaded": [{**m.to_dict(), "is_embedding": m.name in embedding_names} for m in loaded],
        "warning": warning,
    }


# ---------- модели зрения и скачивание моделей (этап 14) ----------

# Что поместится в 8 ГБ вместе с контекстом. Модели зрения крупнее 8B — частично на CPU и медленно.
VISION_MODELS = [
    {"name": "qwen3-vl:8b", "title": "Qwen3-VL 8B — лучше всех читает текст, скриншоты и формулы",
     "size_gb": 6.1, "recommended": True},
    {"name": "qwen2.5vl:7b", "title": "Qwen2.5-VL 7B — проверенная, чуть проще", "size_gb": 6.0},
    {"name": "gemma3:4b", "title": "Gemma 3 4B — лёгкая и быстрая, видит хуже", "size_gb": 3.3},
    {"name": "minicpm-v:8b", "title": "MiniCPM-V 8B — хороша для фото", "size_gb": 5.5},
]


class PullBody(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[\w.\-:/]+$")


_pull: dict = {"state": None, "task": None}


async def _run_pull(name: str) -> None:
    state = _pull["state"]
    try:
        async for p in get_backend().pull(name):
            state["status"] = p.get("status", state["status"])
            # Ollama качает модель несколькими слоями; показываем самый большой — это веса
            if p.get("total") and p["total"] >= state.get("total", 0):
                state["total"], state["completed"] = p["total"], p.get("completed", 0)
        state["status"] = "success"
    except LLMError as e:
        state["error"] = str(e)
    finally:
        state["finished"] = True


@router.get("/models/vision")
async def vision_models():
    try:
        installed = {m.name: m for m in await get_backend().list_models()}
    except LLMError:
        installed = {}
    extra = [{"name": n, "title": n, "size_gb": round((m.size_bytes or 0) / 1024 ** 3, 1)}
             for n, m in installed.items() if m.supports_vision and n not in {v["name"] for v in VISION_MODELS}]
    return {
        "selected": settings_store.get("vision_model"),
        "models": [{**v, "installed": v["name"] in installed and installed[v["name"]].supports_vision}
                   for v in VISION_MODELS] + [{**v, "installed": True} for v in extra],
        "pull": _pull["state"],
    }


@router.post("/models/pull", status_code=202)
async def pull_model(body: PullBody):
    task = _pull["task"]
    if task and not task.done():
        raise HTTPException(status_code=409, detail=f"Уже скачивается {_pull['state']['name']}")
    _pull["state"] = {"name": body.name, "status": "начинаю", "completed": 0, "total": 0, "error": None, "finished": False}
    _pull["task"] = asyncio.create_task(_run_pull(body.name))
    return _pull["state"]


@router.get("/models/pull")
def pull_status():
    return _pull["state"] or {}
