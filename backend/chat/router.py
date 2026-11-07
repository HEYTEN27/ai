"""
HTTP API чата.

  GET    /api/conversations                 — список диалогов
  POST   /api/conversations                 — создать диалог
  GET    /api/conversations/{id}            — диалог с сообщениями
  PATCH  /api/conversations/{id}            — переименовать / сменить модель
  DELETE /api/conversations/{id}            — удалить
  POST   /api/conversations/{id}/messages   — отправить сообщение, ответ приходит ПОТОКОМ
  POST   /api/conversations/{id}/regenerate — пересоздать последний ответ (тоже потоком)

Как устроен стриминг. Ответ отдаётся в формате Server-Sent Events (SSE):
сервер не закрывает соединение и по мере генерации шлёт куски текста вида

    event: token
    data: {"text": "Привет"}

Браузер читает их и сразу дорисовывает сообщение, поэтому текст
появляется по словам, а не целиком через 20 секунд.

Кнопка «Стоп» в браузере просто обрывает соединение. Сервер это замечает,
перестаёт читать Ollama (она тоже прекращает генерацию) и сохраняет
уже написанную часть ответа с пометкой stopped.
"""

import asyncio
import json
from contextlib import aclosing

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..llm import LLMError, get_backend
from . import repository as repo
from .context import build_messages
from .prompts import default_system_prompt

router = APIRouter(prefix="/api/conversations", tags=["chat"])

MAX_MESSAGE_CHARS = 100_000  # защита от случайной вставки гигантского текста
TITLE_MAX_CHARS = 60


# ---------- схемы запросов (pydantic проверяет типы и выдаёт понятные ошибки) ----------


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    model: str | None = None


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    model: str | None = None


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    model: str | None = None  # если не указана — модель диалога или модель по умолчанию
    think: bool = False  # включить «размышления» (для Qwen3 и других думающих моделей)


class RegenerateRequest(BaseModel):
    model: str | None = None
    think: bool = False


# ---------- вспомогательные функции ----------


def _get_or_404(conv_id: str) -> dict:
    conv = repo.get_conversation(conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Диалог не найден")
    return conv


def _sse(event: str, data: dict) -> str:
    """Форматирует одно событие SSE."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _make_title(text: str) -> str:
    """Название диалога из первого сообщения: первая строка, не длиннее 60 символов."""
    first_line = text.strip().splitlines()[0] if text.strip() else repo.DEFAULT_TITLE
    if len(first_line) > TITLE_MAX_CHARS:
        first_line = first_line[: TITLE_MAX_CHARS - 1].rstrip() + "…"
    return first_line


def _stream_response(generator) -> StreamingResponse:
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _generate_answer(conv_id: str, model: str, think: bool):
    """Асинхронный генератор: спрашивает модель и отдаёт события SSE.

    В конце (или при ошибке / остановке) сохраняет ответ ассистента в базу.
    """
    backend = get_backend()
    content_parts: list[str] = []
    thinking_parts: list[str] = []

    saved: dict = {}  # защита от двойного сохранения (например, «Стоп» пришёл после done)

    def save(stopped: bool, stats: dict | None = None) -> dict | None:
        if "message" in saved:
            return saved["message"]
        content = "".join(content_parts)
        thinking = "".join(thinking_parts)
        if not content and not thinking:
            return None  # нечего сохранять
        saved["message"] = repo.add_message(
            conv_id, "assistant", content, thinking=thinking, model=model, stats=stats, stopped=stopped
        )
        return saved["message"]

    try:
        # Узнаём, умеет ли модель «думать». Если нет — параметр think не отправляем вовсе.
        models = {m.name: m for m in await backend.list_models()}
        info = models.get(model)
        if info is None and backend.name == "ollama":
            raise LLMError(
                f"Модель «{model}» не найдена в Ollama. Скачайте её командой: ollama pull {model}"
            )
        if info is not None and info.is_embedding:
            raise LLMError(f"«{model}» — модель эмбеддингов, она не умеет вести диалог. Выберите другую.")
        think_param = think if (info is not None and info.supports_thinking) else None

        messages = build_messages(
            repo.list_messages(conv_id),
            num_ctx=settings.num_ctx,
            system_prompt=default_system_prompt(model),
        )
        yield _sse("start", {"model": model, "think": bool(think_param)})

        stats = None
        # aclosing гарантирует, что поток к Ollama закроется, даже если браузер оборвал соединение
        async with aclosing(
            backend.chat_stream(model, messages, think=think_param, options={"num_ctx": settings.num_ctx})
        ) as stream:
            async for chunk in stream:
                if chunk.kind == "thinking":
                    thinking_parts.append(chunk.text)
                    yield _sse("thinking", {"text": chunk.text})
                elif chunk.kind == "content":
                    content_parts.append(chunk.text)
                    yield _sse("token", {"text": chunk.text})
                elif chunk.kind == "done":
                    stats = chunk.stats

        message = save(stopped=False, stats=stats)
        yield _sse("done", {"message": message})

    except LLMError as e:
        message = save(stopped=True)  # частичный ответ всё равно сохраняем
        yield _sse("error", {"message": str(e), "partial": message})

    except (asyncio.CancelledError, GeneratorExit):
        # Пользователь нажал «Стоп» или закрыл вкладку: сохраняем то, что успели
        save(stopped=True)
        raise


# ---------- эндпоинты ----------


@router.get("")
def list_conversations():
    return repo.list_conversations()


@router.post("", status_code=201)
def create_conversation(body: ConversationCreate):
    return repo.create_conversation(title=body.title or repo.DEFAULT_TITLE, model=body.model)


@router.get("/{conv_id}")
def get_conversation(conv_id: str):
    conv = _get_or_404(conv_id)
    return {**conv, "messages": repo.list_messages(conv_id)}


@router.patch("/{conv_id}")
def update_conversation(conv_id: str, body: ConversationUpdate):
    _get_or_404(conv_id)
    return repo.update_conversation(conv_id, title=body.title, model=body.model)


@router.delete("/{conv_id}", status_code=204)
def delete_conversation(conv_id: str):
    if not repo.delete_conversation(conv_id):
        raise HTTPException(status_code=404, detail="Диалог не найден")


@router.post("/{conv_id}/messages")
async def send_message(conv_id: str, body: MessageCreate):
    conv = _get_or_404(conv_id)
    if not body.content.strip():
        raise HTTPException(status_code=422, detail="Пустое сообщение")
    model = body.model or conv["model"] or settings.default_model

    # Первое сообщение задаёт название диалога
    is_first = not repo.list_messages(conv_id)
    title = _make_title(body.content) if is_first and conv["title"] == repo.DEFAULT_TITLE else None
    repo.update_conversation(conv_id, title=title, model=model)

    repo.add_message(conv_id, "user", body.content)
    return _stream_response(_generate_answer(conv_id, model, body.think))


@router.post("/{conv_id}/regenerate")
async def regenerate(conv_id: str, body: RegenerateRequest):
    conv = _get_or_404(conv_id)
    repo.delete_last_assistant_message(conv_id)
    messages = repo.list_messages(conv_id)
    if not messages or messages[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Нет вопроса, на который можно ответить заново")
    model = body.model or conv["model"] or settings.default_model
    repo.update_conversation(conv_id, model=model)
    return _stream_response(_generate_answer(conv_id, model, body.think))
