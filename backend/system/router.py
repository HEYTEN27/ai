"""
Служебное API: связь с движком, список моделей, состояние видеопамяти.

  GET /api/health  — запущена ли Ollama, её версия
  GET /api/models  — модели для чата и модели эмбеддингов
  GET /api/status  — какие модели загружены и помещаются ли они в VRAM
"""

from fastapi import APIRouter, HTTPException

from ..config import settings
from ..llm import LLMError, get_backend

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health():
    backend = get_backend()
    return {"backend": backend.name, **(await backend.health())}


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
    default = settings.default_model if settings.default_model in names else (names[0] if names else None)
    return {
        "backend": backend.name,
        "default_model": default,
        "models": [m.to_dict() for m in chat_models],
        "embedding_models": [m.to_dict() for m in all_models if m.is_embedding],
        "num_ctx": settings.num_ctx,
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
