"""
Модуль работы с языковыми моделями.

get_backend() возвращает один общий объект движка (Ollama или llama.cpp —
в зависимости от настройки LLM_BACKEND). Остальной код импортирует только его.
"""

from ..config import settings
from .base import ChatChunk, LLMBackend, LLMError, LoadedModel, ModelInfo
from .llamacpp import LlamaCppBackend
from .ollama import OllamaBackend

__all__ = ["ChatChunk", "LLMBackend", "LLMError", "LoadedModel", "ModelInfo", "get_backend", "set_backend"]

_backend: LLMBackend | None = None


def create_backend() -> LLMBackend:
    if settings.llm_backend == "llamacpp":
        return LlamaCppBackend(settings.llamacpp_url)
    if settings.llm_backend == "ollama":
        return OllamaBackend(settings.ollama_url, keep_alive=settings.keep_alive)
    raise ValueError(f"Неизвестный LLM_BACKEND: {settings.llm_backend!r} (ожидается ollama или llamacpp)")


def get_backend() -> LLMBackend:
    global _backend
    if _backend is None:
        _backend = create_backend()
    return _backend


def set_backend(backend: LLMBackend | None) -> None:
    """Подменить движок (используется в тестах)."""
    global _backend
    _backend = backend
