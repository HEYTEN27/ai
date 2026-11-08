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
import base64
import json
import time
import uuid
from contextlib import aclosing

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..files import store as files_store
from ..files.context import attachments_budget, augment_with_files, build_attachment_block
from ..files import vision as files_vision
from ..knowledge import store as kb_store
from ..lessons import repository as lessons_repo
from ..lessons.learner import format_for_prompt as lessons_block
from ..knowledge.search import augment_question, build_query, sources_for_message
from ..knowledge.search import search as kb_search
from ..llm import LLMError, get_backend
from ..memory import repository as memory_repo
from ..memory.extraction import extract_and_apply
from ..memory.retrieval import format_for_prompt, select_facts
from ..settings import personas as personas_repo
from ..tools import confirm as tool_confirm
from ..tools import registry as tool_registry
from ..settings import store as settings_store
from . import repository as repo
from .artifacts import ARTIFACTS_HINT, compact_history
from .complexity import assess as assess_complexity
from .context import build_messages
from .prompts import build_system_prompt, generation_options

router = APIRouter(prefix="/api/conversations", tags=["chat"])

MAX_MESSAGE_CHARS = 100_000  # защита от случайной вставки гигантского текста
MEMORY_WAIT_SECONDS = 90  # сколько ждать извлечения фактов, чтобы показать «Запомнил» в чате
MAX_TOOL_CALLS = 6  # больше вызовов инструментов за один ответ не даём — защита от зацикливания
MAX_ATTACHMENTS = 10  # файлов в одном сообщении
MAX_IMAGES = 4  # картинок в одном запросе к модели зрения (каждая ≈ 1000–1600 токенов)
NO_VISION_HINT = ("Чтобы Джарвис видел картинки, нужна модель зрения: ⚙ → «Основное» → «👁 Зрение» → «Скачать» "
                  "(рекомендую qwen3-vl:8b, ≈ 6 ГБ) или в терминале: ollama pull qwen3-vl:8b")

# Ссылки на фоновые задачи извлечения памяти. Без них сборщик мусора Python
# может удалить незавершённую задачу.
_background_tasks: set[asyncio.Task] = set()
TITLE_MAX_CHARS = 60


# ---------- схемы запросов (pydantic проверяет типы и выдаёт понятные ошибки) ----------


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    model: str | None = None
    persona_id: int | None = None  # не указана — персона по умолчанию из настроек
    kb_scope: str = "all"  # база знаний: all — вся, off — не использовать, "<id>" — одна коллекция


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    model: str | None = None
    persona_id: int | None = None
    kb_scope: str | None = None


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    model: str | None = None  # если не указана — модель диалога или модель по умолчанию
    think: bool = False  # включить «размышления» (для Qwen3 и других думающих моделей)
    attachments: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)  # id загруженных файлов


class RegenerateRequest(BaseModel):
    model: str | None = None
    think: bool = False


# ---------- вспомогательные функции ----------


def _get_or_404(conv_id: str) -> dict:
    conv = repo.get_conversation(conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Диалог не найден")
    return conv


def resolve_persona(conv: dict, settings: dict) -> dict:
    """Персона диалога → персона по умолчанию из настроек → «Универсальный»."""
    return (
        personas_repo.get_persona(conv.get("persona_id"))
        or personas_repo.get_persona(settings["default_persona_id"])
        or personas_repo.fallback_persona()
    )


def _check_kb_scope(scope: str) -> None:
    if scope in ("all", "off"):
        return
    if not scope.isdigit() or kb_store.get_collection(int(scope)) is None:
        raise HTTPException(status_code=422, detail="Такой коллекции в базе знаний нет")


def _check_persona(persona_id: int | None) -> None:
    if persona_id is not None and personas_repo.get_persona(persona_id) is None:
        raise HTTPException(status_code=422, detail="Такой персоны нет")


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

    # Настройки и персону читаем при каждом ответе — изменения в интерфейсе
    # применяются сразу, без перезапуска сервера.
    settings = settings_store.get_all()
    persona = resolve_persona(repo.get_conversation(conv_id) or {}, settings)

    saved: dict = {}  # защита от двойного сохранения (например, «Стоп» пришёл после done)
    facts: list[dict] = []  # факты из памяти, подставленные в контекст
    sources: list[dict] = []  # фрагменты из базы знаний (для ссылок [1], [2])
    tool_log: list[dict] = []  # какие инструменты вызывались — для карточек в чате
    files_report: list[dict] = []  # какие файлы диалога ушли в контекст (целиком или выдержками)
    auto_think = False  # «размышления» включились сами (сложный вопрос)
    images_b64: list[str] = []  # картинки для модели зрения (уменьшенные копии в base64)
    vision_swap: str | None = None  # какую модель подменили моделью зрения
    think_reasons: list[str] = []

    def save(stopped: bool, stats: dict | None = None) -> dict | None:
        if "message" in saved:
            return saved["message"]
        content = "".join(content_parts)
        if tool_log:
            content = content.rstrip()  # разделитель после инструмента мог остаться последним
        thinking = "".join(thinking_parts)
        if not content and not thinking:
            return None  # нечего сохранять
        # Что было в контексте ответа: факты из памяти и источники из базы знаний
        extras = {}
        if facts:
            extras["memory_ids"] = [f["id"] for f in facts]
        if sources:
            extras["sources"] = sources
        if tool_log:
            extras["tools"] = tool_log
        if files_report:
            extras["files"] = files_report
        if auto_think:
            extras["auto_think"] = think_reasons
        if images_b64:
            extras["vision"] = {"model": model, "images": len(images_b64), "instead_of": vision_swap}
        saved["message"] = repo.add_message(
            conv_id, "assistant", content, thinking=thinking, model=model, stats=stats,
            stopped=stopped, persona_id=persona["id"], extras=extras or None,
        )
        # Документы, созданные инструментами, привязываем к этому ответу
        created = [e["display"]["file"]["id"] for e in tool_log if (e.get("display") or {}).get("file")]
        if created:
            files_store.attach_to_message(created, conv_id, saved["message"]["id"])
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
        history = repo.list_messages(conv_id)
        user_messages = [m["content"] for m in history if m["role"] == "user"]

        # Зрение (этап 14): картинки из последних сообщений. Если модель их не видит — на этот
        # ответ подключаем модель зрения из настроек (Ollama сама освободит под неё видеопамять)
        recent_user_ids = [m["id"] for m in history if m["role"] == "user"][-3:]
        vision_records = files_store.vision_inputs(conv_id, recent_user_ids)
        if vision_records:
            for record in vision_records:
                for path in files_vision.vision_files(files_store.path_of(record).parent, record["meta"]):
                    if path.is_file() and len(images_b64) < MAX_IMAGES:
                        images_b64.append(base64.b64encode(path.read_bytes()).decode("ascii"))
            if not (info is not None and info.supports_vision):
                vision_model = settings["vision_model"]
                vision_info = models.get(vision_model)
                if vision_info is None or not vision_info.supports_vision:
                    raise LLMError(NO_VISION_HINT)
                vision_swap = model
                model, info = vision_model, vision_info

        # Авто-размышления: переключатель выключен, но вопрос сложный — модель сначала подумает
        auto_think, think_reasons = False, []
        if not think and settings["auto_think"] and info is not None and info.supports_thinking and user_messages:
            auto_think, think_reasons = assess_complexity(user_messages[-1])
        think_param = (think or auto_think) if (info is not None and info.supports_thinking) else None

        # Долговременная память: выбираем факты о пользователе, подходящие к вопросу.
        # Ищем по двум последним вопросам — «а на нём можно?» без предыдущего непонятно.
        method = "off"
        if settings["memory_enabled"]:
            facts, method = await select_facts(
                backend, "\n".join(user_messages[-2:]),
                budget_tokens=settings["memory_budget_tokens"],
                embedding_model=settings["embedding_model"],
            )
            memory_repo.mark_used([f["id"] for f in facts])

        # База знаний: ищем фрагменты документов, подходящие к вопросу
        conv = repo.get_conversation(conv_id) or {}
        scope = conv.get("kb_scope") or "all"
        kb_method = "off"
        if scope != "off" and user_messages and kb_store.stats()["ready"]:
            chunks, kb_method = await kb_search(
                backend, build_query(user_messages),
                collection_id=int(scope) if scope.isdigit() else None, settings=settings,
            )
            if chunks:
                sources = sources_for_message(chunks)
                # Подменяем последний вопрос на «фрагменты + правила + вопрос» — только в запросе
                # к модели; в базе вопрос остаётся как есть
                history = history[:-1] + [{**history[-1], "content": augment_question(history[-1]["content"], chunks)}]

        # Файлы диалога (вложения и созданные документы): целиком или выдержками по вопросу
        context_files = files_store.files_for_context(conv_id)
        if context_files and user_messages:
            block, files_report = build_attachment_block(
                context_files, user_messages[-1], attachments_budget(settings["num_ctx"]))
            history = history[:-1] + [{**history[-1], "content": augment_with_files(
                history[-1]["content"], block, has_kb=bool(sources))}]

        if images_b64:
            names = ", ".join(f"«{r['name']}»" + (f" (скан PDF: страницы 1–{r['meta']['scan_pages']} из {r['meta']['pages']})"
                                                     if r["meta"].get("type") == "scan" else "") for r in vision_records)
            note = (f"[К вопросу приложены изображения: {names}. Отвечая, опирайся на то, что на них видно; "
                    "если что-то не разобрать — так и скажи.]\n\n")
            history = history[:-1] + [{**history[-1], "content": note + history[-1]["content"]}]

        # Инструменты — только если модель умеет их вызывать (qwen3, llama3.1 умеют)
        tools = tool_registry.enabled_tools(settings) if (info is not None and info.supports_tools) else []
        tools_by_name = {t.name: t for t in tools}

        options = generation_options(settings, persona)
        # Артефакты: инструкция модели + в контексте полный код только у последних версий игр и схем
        hints = [tool_registry.system_hint(tools)]
        if settings["artifacts_enabled"]:
            hints.append(ARTIFACTS_HINT)
            history = compact_history(history)
        # Уроки из исправлений и 👎 (этап 11) — модель учитывает их со следующего же ответа
        lessons = lessons_repo.enabled_lessons() if settings["lessons_enabled"] else []
        hints.append(lessons_block(lessons))
        messages = build_messages(
            history,
            num_ctx=settings["num_ctx"],
            system_prompt=build_system_prompt(settings, persona, model, format_for_prompt(facts),
                                              "\n\n".join(h for h in hints if h)),
            # Если у персоны задан лимит длины ответа — столько и оставляем под ответ;
            # картинки тоже занимают контекст (≈ 1 токен на квадрат 28×28) — вычитаем их из бюджета истории
            reserve_for_answer=((options.get("num_predict") or max(1024, settings["num_ctx"] // 4))
                                + sum(r["meta"].get("tokens", 1500) * (r["meta"].get("scan_pages") or 1)
                                      for r in vision_records)) if images_b64 else options.get("num_predict"),
        )
        if images_b64:
            messages[-1]["images"] = images_b64  # формат Ollama: картинки в base64 рядом с текстом вопроса
        yield _sse("start", {
            "model": model, "think": bool(think_param), "persona_id": persona["id"],
            "auto_think": auto_think, "think_reasons": think_reasons,
            "vision": {"model": model, "images": len(images_b64), "instead_of": vision_swap} if images_b64 else None,
            "memory": {"method": method, "facts": [{"id": f["id"], "content": f["content"]} for f in facts]},
            "knowledge": {"method": kb_method, "sources": sources},
            "tools": [t.name for t in tools],
            "files": files_report,
            "lessons": len([line for line in hints[-1].splitlines() if line.startswith("- ")]),
        })

        # Цикл «модель → инструмент → модель». Обычно один проход: модель просто отвечает.
        # Если она просит инструмент — выполняем его, добавляем результат в переписку
        # (роль tool) и спрашиваем модель снова, пока она не ответит без инструментов.
        stats = None
        while True:
            # Лимит исчерпан — последний раз спрашиваем уже без инструментов, чтобы получить ответ
            offer_tools = [t.schema() for t in tools] if len(tool_log) < MAX_TOOL_CALLS else None
            step_text: list[str] = []
            calls: list[dict] = []
            # aclosing гарантирует, что поток к Ollama закроется, даже если браузер оборвал соединение
            async with aclosing(
                backend.chat_stream(model, messages, think=think_param, options=options, tools=offer_tools)
            ) as stream:
                async for chunk in stream:
                    if chunk.kind == "thinking":
                        thinking_parts.append(chunk.text)
                        yield _sse("thinking", {"text": chunk.text})
                    elif chunk.kind == "content":
                        content_parts.append(chunk.text)
                        step_text.append(chunk.text)
                        yield _sse("token", {"text": chunk.text})
                    elif chunk.kind == "tool_call":
                        calls.append(chunk.tool_call)
                    elif chunk.kind == "done":
                        stats = chunk.stats

            if not calls or not offer_tools:
                break

            # Запоминаем в переписке, что модель попросила инструменты
            messages.append({"role": "assistant", "content": "".join(step_text),
                             "tool_calls": [{"function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls]})
            for call in calls[: MAX_TOOL_CALLS - len(tool_log)]:
                entry = {"id": uuid.uuid4().hex[:12], "name": call["name"], "arguments": call["arguments"]}
                tool = tools_by_name.get(call["name"])
                entry.update(title=tool.title if tool else call["name"], icon=tool.icon if tool else "🛠️",
                             summary=tool_registry.summarize_args(call["name"], call["arguments"]))
                needs_confirm = bool(tool and tool.confirm(settings))
                yield _sse("tool_start", {**entry, "needs_confirm": needs_confirm})

                approved = True
                if needs_confirm:
                    tool_confirm.create(entry["id"])
                    yield _sse("tool_confirm", entry)
                    approved = await tool_confirm.wait(entry["id"])  # генерация ждёт кнопку в интерфейсе

                started = time.monotonic()
                if approved:
                    # Инструмент выполняется отдельной задачей: пока он работает (картинка рисуется
                    # десятки секунд), шлём в чат его прогресс — «Рисую: шаг 7 из 25»
                    job = asyncio.create_task(tool_registry.execute(
                        call["name"], call["arguments"], settings, {"conversation_id": conv_id}))
                    try:
                        while not job.done():
                            await asyncio.wait({job}, timeout=0.5)
                            if not job.done() and tool and tool.progress and (p := tool.progress()):
                                yield _sse("tool_progress", {"id": entry["id"], **p})
                    except (asyncio.CancelledError, GeneratorExit):
                        if tool and tool.cancel:
                            tool.cancel()  # «Стоп» — останавливаем и сам инструмент (рисование)
                        job.cancel()
                        raise
                    status, result_text, display = job.result()
                else:
                    status, result_text, display = "declined", "Пользователь отклонил это действие.", {}
                entry.update(status=status, display=display, duration=round(time.monotonic() - started, 2))
                tool_log.append(entry)
                yield _sse("tool_result", entry)
                messages.append({"role": "tool", "content": result_text, "tool_name": call["name"]})

            if "".join(step_text).strip():
                content_parts.append("\n\n")  # отделяем текст до инструмента от продолжения ответа

        message = save(stopped=False, stats=stats)
        yield _sse("done", {"message": message})

        # Ответ готов — теперь ищем в этом обмене новые факты о пользователе.
        # Делаем это в отдельной задаче: даже если пользователь закроет вкладку,
        # запоминание доведётся до конца.
        if settings["memory_enabled"] and settings["memory_autosave"] and message and user_messages:
            task = asyncio.create_task(extract_and_apply(
                backend, model=model, think_supported=bool(info and info.supports_thinking),
                num_ctx=settings["num_ctx"], user_text=user_messages[-1], answer_text=message["content"],
                known=facts, conversation_id=conv_id, message_id=message["id"],
            ))
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
            try:
                # shield — если браузер отключится, отменится только ожидание, а не сама задача
                events = await asyncio.wait_for(asyncio.shield(task), timeout=MEMORY_WAIT_SECONDS)
            except asyncio.TimeoutError:
                events = []
            if events:
                yield _sse("memory", {"events": events})

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
    _check_persona(body.persona_id)
    _check_kb_scope(body.kb_scope)
    return repo.create_conversation(
        title=body.title or repo.DEFAULT_TITLE, model=body.model, persona_id=body.persona_id,
        kb_scope=body.kb_scope,
    )


@router.get("/{conv_id}")
def get_conversation(conv_id: str):
    conv = _get_or_404(conv_id)
    return {
        **conv,
        "messages": repo.list_messages(conv_id),
        # Что Джарвис запомнил в этом диалоге — чтобы показать под нужными ответами
        "memory_events": memory_repo.list_events(conversation_id=conv_id, limit=500),
    }


@router.patch("/{conv_id}")
def update_conversation(conv_id: str, body: ConversationUpdate):
    _get_or_404(conv_id)
    changes = {"title": body.title, "model": body.model}
    if body.kb_scope is not None:
        _check_kb_scope(body.kb_scope)
        changes["kb_scope"] = body.kb_scope
    # persona_id меняем, только если поле реально прислали (null = вернуть персону по умолчанию)
    if "persona_id" in body.model_fields_set:
        _check_persona(body.persona_id)
        changes["persona_id"] = body.persona_id
    return repo.update_conversation(conv_id, **changes)


@router.delete("/{conv_id}", status_code=204)
def delete_conversation(conv_id: str):
    if not repo.delete_conversation(conv_id):
        raise HTTPException(status_code=404, detail="Диалог не найден")
    files_store.cleanup()  # записи о файлах удалились каскадом — убираем и сами файлы с диска


@router.post("/{conv_id}/messages")
async def send_message(conv_id: str, body: MessageCreate):
    conv = _get_or_404(conv_id)
    if not body.content.strip():
        raise HTTPException(status_code=422, detail="Пустое сообщение")
    model = body.model or conv["model"] or settings_store.get("default_model")

    # Вложения проверяем до любых изменений в базе
    try:
        uploads = files_store.pending_uploads(body.attachments, conv_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    # Первое сообщение задаёт название диалога
    is_first = not repo.list_messages(conv_id)
    title = _make_title(body.content) if is_first and conv["title"] == repo.DEFAULT_TITLE else None
    repo.update_conversation(conv_id, title=title, model=model)

    extras = {"attachments": [{k: f[k] for k in ("id", "name", "size", "mime", "meta", "url")} for f in uploads]} \
        if uploads else None
    message = repo.add_message(conv_id, "user", body.content, extras=extras)
    if uploads:
        files_store.attach_to_message([f["id"] for f in uploads], conv_id, message["id"])
    return _stream_response(_generate_answer(conv_id, model, body.think))


@router.post("/{conv_id}/regenerate")
async def regenerate(conv_id: str, body: RegenerateRequest):
    conv = _get_or_404(conv_id)
    repo.delete_last_assistant_message(conv_id)
    messages = repo.list_messages(conv_id)
    if not messages or messages[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Нет вопроса, на который можно ответить заново")
    model = body.model or conv["model"] or settings_store.get("default_model")
    repo.update_conversation(conv_id, model=model)
    return _stream_response(_generate_answer(conv_id, model, body.think))
