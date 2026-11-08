"""
HTTP API уроков.

  GET    /api/lessons            — все уроки
  POST   /api/lessons            — добавить вручную: {content}
  PATCH  /api/lessons/{id}       — изменить текст / включить-выключить
  DELETE /api/lessons/{id}       — удалить
  POST   /api/lessons/learn      — вывести урок из ответа: {message_id, corrected?, reason?, quick?[]}
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..chat import repository as chat_repo
from ..llm import get_backend
from ..settings import store as settings_store
from . import learner
from . import repository as repo

router = APIRouter(prefix="/api/lessons", tags=["lessons"])


class LessonCreate(BaseModel):
    content: str = Field(min_length=1, max_length=repo.MAX_CHARS)


class LessonUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=repo.MAX_CHARS)
    enabled: bool | None = None


class LearnBody(BaseModel):
    message_id: int
    corrected: str | None = Field(default=None, max_length=50_000)  # исправленный ответ (если исправляли)
    reason: str | None = Field(default=None, max_length=1000)  # пояснение к 👎
    quick: list[str] = Field(default_factory=list, max_length=5)  # быстрые причины: long, short, complex...


def _call(fn):
    try:
        return fn()
    except repo.LessonError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("")
def list_lessons():
    return {"items": repo.list_lessons(), "quick_reasons": {k: v[0] for k, v in learner.QUICK_REASONS.items()}}


@router.post("", status_code=201)
def create_lesson(body: LessonCreate):
    return _call(lambda: learner.save(body.content, source="manual"))


@router.patch("/{lesson_id}")
def update_lesson(lesson_id: int, body: LessonUpdate):
    if repo.get_lesson(lesson_id) is None:
        raise HTTPException(status_code=404, detail="Урок не найден")
    return _call(lambda: repo.update_lesson(lesson_id, content=body.content, enabled=body.enabled))


@router.delete("/{lesson_id}", status_code=204)
def delete_lesson(lesson_id: int):
    if not repo.delete_lesson(lesson_id):
        raise HTTPException(status_code=404, detail="Урок не найден")


@router.post("/learn")
async def learn(body: LearnBody):
    message = chat_repo.get_message(body.message_id)
    if message is None or message["role"] != "assistant":
        raise HTTPException(status_code=404, detail="Ответ не найден")
    settings = settings_store.get_all()
    if not settings["lessons_enabled"]:
        return {"action": "none", "lesson": None, "previous": None, "note": "Уроки выключены в настройках"}
    # Вопрос, на который был этот ответ, — ближайшее сообщение пользователя перед ним
    history = chat_repo.list_messages(message["conversation_id"])
    before = [m for m in history if m["id"] < message["id"] and m["role"] == "user"]
    question = before[-1]["content"] if before else ""

    backend = get_backend()
    model = message.get("model") or settings["default_model"]
    try:
        info = {m.name: m for m in await backend.list_models()}.get(model)
    except Exception:  # Ollama недоступна — learn сам вернёт понятную причину
        info = None
    return await learner.learn(
        backend, model=model, think_supported=bool(info and info.supports_thinking), num_ctx=settings["num_ctx"],
        question=question, answer=message["content"], corrected=(body.corrected or "").strip() or None,
        reason=body.reason, quick=body.quick, message_id=message["id"], conversation_id=message["conversation_id"],
    )
