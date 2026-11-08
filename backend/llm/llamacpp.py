"""
Адаптер для llama.cpp (программа llama-server).

Запасной вариант на случай, если захочется запускать GGUF-файл напрямую, без Ollama.
llama-server отдаёт OpenAI-совместимый API:
  GET  /health                — проверка связи
  GET  /v1/models             — какая модель загружена (обычно одна)
  POST /v1/chat/completions   — генерация (поток в формате SSE: строки "data: {...}")

Пример запуска на Windows (контекст задаётся при старте, а не в запросе):
  llama-server -m qwen3-8b-q4_k_m.gguf -c 8192 -ngl 99 --jinja --port 8080
"""

import json
from typing import AsyncIterator

import httpx

from .base import ChatChunk, LLMBackend, LLMError, ModelInfo, normalize_tool_call

TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)

# Какие наши параметры понимает llama-server (num_ctx среди них нет — он задаётся флагом -c)
SUPPORTED_OPTIONS = {"temperature", "top_p", "top_k", "repeat_penalty", "seed", "min_p"}


def _openai_message(message: dict) -> dict:
    """Картинки у Ollama — поле images (base64), а у OpenAI-совместимого сервера — части content."""
    if not message.get("images"):
        return message
    parts = [{"type": "text", "text": message.get("content") or ""}]
    parts += [{"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}} for b64 in message["images"]]
    return {k: v for k, v in message.items() if k != "images"} | {"content": parts}


class LlamaCppBackend(LLMBackend):
    name = "llamacpp"

    def __init__(self, base_url: str, *, transport=None):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=TIMEOUT, transport=transport)

    def _connection_error(self) -> LLMError:
        return LLMError(
            f"Не удаётся подключиться к llama-server по адресу {self.base_url}. "
            "Проверьте, что он запущен."
        )

    async def health(self) -> dict:
        try:
            r = await self._client.get("/health")
            return {"ok": r.status_code == 200, "version": None, "error": None}
        except httpx.HTTPError:
            return {"ok": False, "version": None, "error": str(self._connection_error())}

    async def list_models(self) -> list[ModelInfo]:
        try:
            r = await self._client.get("/v1/models")
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise self._connection_error() from e
        # Что модель умеет, llama-server не сообщает; считаем, что это чат-модель
        return [ModelInfo(name=m["id"], capabilities=["completion"]) for m in r.json().get("data", [])]

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
        payload: dict = {"model": model, "messages": [_openai_message(m) for m in messages], "stream": True}
        if tools:
            payload["tools"] = tools  # формат описаний у Ollama и OpenAI одинаковый
        # OpenAI-сервер присылает вызов инструмента кусками: имя, потом аргументы по частям.
        # Собираем их по номеру вызова (index) и отдаём целиком в конце.
        pending_calls: dict[int, dict] = {}
        if format is not None:
            # OpenAI-совместимый способ попросить ответ строго по JSON-схеме
            payload["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "schema": format}}
        payload.update({k: v for k, v in (options or {}).items() if k in SUPPORTED_OPTIONS})
        if think is not None:
            # Так шаблон Qwen3 включает/выключает «размышления» в llama.cpp
            payload["chat_template_kwargs"] = {"enable_thinking": think}

        stats: dict = {}
        try:
            async with self._client.stream("POST", "/v1/chat/completions", json=payload) as response:
                if response.status_code != 200:
                    await response.aread()
                    raise LLMError(f"llama-server: {response.text}")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    body = line[len("data:"):].strip()
                    if body == "[DONE]":
                        break
                    data = json.loads(body)
                    if "timings" in data:  # llama-server присылает скорость генерации
                        t = data["timings"]
                        stats = {
                            "prompt_tokens": t.get("prompt_n"),
                            "completion_tokens": t.get("predicted_n"),
                            "tokens_per_second": round(t["predicted_per_second"], 1)
                            if t.get("predicted_per_second")
                            else None,
                        }
                    for choice in data.get("choices", []):
                        delta = choice.get("delta") or {}
                        if delta.get("reasoning_content"):
                            yield ChatChunk("thinking", delta["reasoning_content"])
                        if delta.get("content"):
                            yield ChatChunk("content", delta["content"])
                        for part in delta.get("tool_calls") or []:
                            call = pending_calls.setdefault(part.get("index", 0), {"name": "", "arguments": ""})
                            fn = part.get("function") or {}
                            call["name"] += fn.get("name") or ""
                            call["arguments"] += fn.get("arguments") or ""
                        if choice.get("finish_reason"):
                            stats["done_reason"] = choice["finish_reason"]
        except httpx.ConnectError as e:
            raise self._connection_error() from e
        except httpx.TimeoutException as e:
            raise LLMError("llama-server слишком долго не отвечает.") from e
        except httpx.HTTPError as e:
            raise LLMError(f"Обрыв связи с llama-server: {e}") from e
        for index in sorted(pending_calls):
            yield ChatChunk("tool_call", tool_call=normalize_tool_call({"function": pending_calls[index]}))
        yield ChatChunk("done", stats=stats)

    async def close(self) -> None:
        await self._client.aclose()
