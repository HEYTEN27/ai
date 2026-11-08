"""
Адаптер для Ollama.

Ollama — программа, которая скачивает и запускает модели, а наружу отдаёт
HTTP API на порту 11434. Мы используем эндпоинты:
  GET  /api/version — версия (проверка связи)
  GET  /api/tags    — список скачанных моделей
  POST /api/show    — подробности о модели (умеет ли думать, вызывать инструменты)
  POST /api/chat    — генерация ответа (потоком, построчный JSON)
  GET  /api/ps      — какие модели загружены и сколько из них в VRAM

Документация: https://github.com/ollama/ollama/blob/main/docs/api.md
"""

import asyncio
import json
from typing import AsyncIterator

import httpx

from .base import (
    ChatChunk,
    LLMBackend,
    LLMError,
    LoadedModel,
    ModelInfo,
    kv_bytes_per_token,
    normalize_tool_call,
    parse_parameter_size,
)

# Таймауты: подключиться надо быстро, а вот первый токен может прийти нескоро —
# Ollama сначала загружает модель с диска в видеопамять (5 ГБ — это 10–30 секунд).
TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)

NOT_RUNNING_HINT = (
    "Не удаётся подключиться к Ollama по адресу {url}. "
    "Проверьте, что Ollama запущена (значок в трее или команда `ollama serve`)."
)


class OllamaBackend(LLMBackend):
    name = "ollama"

    def __init__(self, base_url: str, *, keep_alive: str = "30m", transport=None):
        self.base_url = base_url.rstrip("/")
        self.keep_alive = keep_alive
        # transport можно подменить в тестах на эмулятор Ollama
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=TIMEOUT, transport=transport)
        # Кэш ответов /api/show: ключ — digest (хэш файла модели), он меняется при обновлении модели.
        # Значение — (возможности модели, байт KV-кэша на токен)
        self._show_cache: dict[str, tuple[list[str], int | None]] = {}

    @property
    def client(self) -> httpx.AsyncClient:
        """HTTP-клиент Ollama — для служебных операций вроде подключения обученной модели."""
        return self._client

    # ---------- служебное ----------

    def _connection_error(self) -> LLMError:
        return LLMError(NOT_RUNNING_HINT.format(url=self.base_url))

    @staticmethod
    def _error_text(response: httpx.Response) -> str:
        """Достаёт текст ошибки из ответа Ollama ({"error": "..."})."""
        try:
            return response.json().get("error") or response.text
        except (json.JSONDecodeError, ValueError):
            return response.text

    # ---------- методы интерфейса ----------

    async def health(self) -> dict:
        try:
            r = await self._client.get("/api/version")
            r.raise_for_status()
            return {"ok": True, "version": r.json().get("version"), "error": None}
        except httpx.HTTPError:
            return {"ok": False, "version": None, "error": str(self._connection_error())}

    async def _show(self, name: str, digest: str | None, details: dict) -> tuple[list[str], int | None]:
        """Подробности о модели из /api/show (с кэшем): что умеет и сколько весит токен контекста.

        Если /api/show не ответил — угадываем возможности по названию.
        """
        if digest and digest in self._show_cache:
            return self._show_cache[digest]
        caps: list[str] = []
        kv = None
        try:
            r = await self._client.post("/api/show", json={"model": name})
            if r.status_code == 200:
                data = r.json()
                caps = data.get("capabilities") or []
                kv = kv_bytes_per_token(data.get("model_info") or {})
        except httpx.HTTPError:
            pass
        if not caps:
            # Запасной вариант для очень старых версий Ollama
            family = (details.get("family") or "").lower()
            if "embed" in name.lower() or family in {"bert", "nomic-bert", "xlm-roberta"}:
                caps = ["embedding"]
            else:
                caps = ["completion"]
        if digest:
            self._show_cache[digest] = (caps, kv)
        return caps, kv

    async def list_models(self) -> list[ModelInfo]:
        try:
            r = await self._client.get("/api/tags")
        except httpx.HTTPError as e:
            raise self._connection_error() from e
        if r.status_code != 200:
            raise LLMError(f"Ollama вернула ошибку: {self._error_text(r)}")

        raw_models = r.json().get("models", [])
        # Запрашиваем возможности всех моделей параллельно — так быстрее
        show_list = await asyncio.gather(
            *(self._show(m["name"], m.get("digest"), m.get("details") or {}) for m in raw_models)
        )
        models = []
        for m, (caps, kv) in zip(raw_models, show_list):
            details = m.get("details") or {}
            models.append(
                ModelInfo(
                    name=m["name"],
                    family=details.get("family"),
                    parameter_size=details.get("parameter_size"),
                    parameters_b=parse_parameter_size(details.get("parameter_size")),
                    quantization=details.get("quantization_level"),
                    size_bytes=m.get("size"),
                    capabilities=caps,
                    kv_bytes_per_token=kv,
                )
            )
        models.sort(key=lambda x: x.name)
        return models

    async def chat_stream(
        self,
        model: str,
        messages: list[dict],
        *,
        think: bool | None = None,
        options: dict | None = None,
        format: dict | None = None,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[ChatChunk]:
        payload: dict = {
            "model": model,
            "messages": messages,
            "stream": True,
            "keep_alive": self.keep_alive,
            "options": options or {},
        }
        # Параметр think отправляем, только если он задан: модели без поддержки
        # «размышлений» (например llama3.1) на него отвечают ошибкой.
        if think is not None:
            payload["think"] = think
        if format is not None:
            payload["format"] = format  # Ollama ограничит ответ этой JSON-схемой
        if tools:
            payload["tools"] = tools  # модель сможет попросить вызвать инструмент

        try:
            async with self._client.stream("POST", "/api/chat", json=payload) as response:
                if response.status_code != 200:
                    await response.aread()
                    raise LLMError(f"Ollama: {self._error_text(response)}")

                # Ollama присылает по одному JSON-объекту на строку (NDJSON)
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if data.get("error"):
                        raise LLMError(f"Ollama: {data['error']}")

                    message = data.get("message") or {}
                    if message.get("thinking"):
                        yield ChatChunk("thinking", message["thinking"])
                    if message.get("content"):
                        yield ChatChunk("content", message["content"])
                    for call in message.get("tool_calls") or []:
                        yield ChatChunk("tool_call", tool_call=normalize_tool_call(call))

                    if data.get("done"):
                        yield ChatChunk("done", stats=self._stats(data))
                        return
        except httpx.ConnectError as e:
            raise self._connection_error() from e
        except httpx.TimeoutException as e:
            raise LLMError(
                "Ollama слишком долго не отвечает. Возможно, модель не помещается в память "
                "и работает на процессоре — попробуйте модель поменьше или меньший контекст."
            ) from e
        except httpx.HTTPError as e:
            raise LLMError(f"Обрыв связи с Ollama: {e}") from e

    @staticmethod
    def _stats(data: dict) -> dict:
        """Статистика из последнего сообщения Ollama. Длительности там в наносекундах."""
        eval_count = data.get("eval_count") or 0
        eval_ns = data.get("eval_duration") or 0
        return {
            "prompt_tokens": data.get("prompt_eval_count"),
            "completion_tokens": eval_count,
            "tokens_per_second": round(eval_count / (eval_ns / 1e9), 1) if eval_ns else None,
            "load_seconds": round((data.get("load_duration") or 0) / 1e9, 2),
            "total_seconds": round((data.get("total_duration") or 0) / 1e9, 2),
            "done_reason": data.get("done_reason"),
        }

    async def embed(self, model: str, texts: list[str], *, on_gpu: bool = False) -> list[list[float]]:
        payload: dict = {"model": model, "input": texts, "keep_alive": "10m"}
        if not on_gpu:
            # num_gpu = 0 — ни одного слоя на видеокарту: эмбеддинг-модель живёт в обычной RAM
            # и не вытесняет qwen3:8b из видеопамяти (её там и так впритык)
            payload["options"] = {"num_gpu": 0}
        try:
            r = await self._client.post("/api/embed", json=payload)
        except httpx.ConnectError as e:
            raise self._connection_error() from e
        except httpx.HTTPError as e:
            raise LLMError(f"Ошибка эмбеддингов: {e}") from e
        if r.status_code != 200:
            raise LLMError(f"Ollama (эмбеддинги): {self._error_text(r)}")
        return r.json().get("embeddings") or []

    async def loaded_models(self) -> list[LoadedModel] | None:
        try:
            r = await self._client.get("/api/ps")
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise self._connection_error() from e
        return [
            LoadedModel(
                name=m["name"],
                size_bytes=m.get("size") or 0,
                vram_bytes=m.get("size_vram") or 0,
                context_length=m.get("context_length"),
            )
            for m in r.json().get("models", [])
        ]

    async def pull(self, name: str):
        """Скачивание модели через Ollama (/api/pull): поток строк JSON с прогрессом."""
        try:
            async with self._client.stream("POST", "/api/pull", json={"model": name, "stream": True},
                                           timeout=httpx.Timeout(30, read=None)) as r:
                if r.status_code != 200:
                    await r.aread()
                    raise LLMError(f"Ollama (скачивание): {self._error_text(r)}")
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if data.get("error"):
                        raise LLMError(f"Ollama: {data['error']}")
                    yield data
        except httpx.ConnectError as e:
            raise self._connection_error() from e
        except httpx.HTTPError as e:
            raise LLMError(f"Скачивание прервалось: {e}") from e
        self._show_cache.clear()  # у новой модели свои возможности — перечитаем

    async def unload_all(self) -> list[str]:
        """Выгрузить все модели из видеопамяти (перед генерацией картинок: вместе они в 8 ГБ не влезают).

        В Ollama это пустой запрос /api/generate с keep_alive = 0. Следующий вопрос в чате
        загрузит модель обратно (5–10 секунд)."""
        try:
            loaded = await self.loaded_models() or []
            for m in loaded:
                await self._client.post("/api/generate", json={"model": m.name, "keep_alive": 0})
        except (httpx.HTTPError, LLMError):
            return []  # Ollama не запущена — выгружать нечего
        return [m.name for m in loaded]

    async def close(self) -> None:
        await self._client.aclose()
