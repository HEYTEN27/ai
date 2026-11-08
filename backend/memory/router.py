"""
HTTP API страницы «Память».

  GET    /api/memory                      — все факты (?q= — поиск) + сводка
  POST   /api/memory                      — добавить факт вручную
  PUT    /api/memory/{id}                 — изменить текст / категорию / закрепление
  DELETE /api/memory/{id}                 — удалить факт
  DELETE /api/memory?confirm=yes          — стереть всю память
  GET    /api/memory/events               — журнал изменений
  POST   /api/memory/events/{id}/undo     — отменить изменение
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..llm import get_backend
from ..settings import store as settings_store
from . import repository as repo
from .retrieval import estimate_tokens

router = APIRouter(prefix="/api/memory", tags=["memory"])


class FactCreate(BaseModel):
    content: str = Field(min_length=1, max_length=repo.MAX_FACT_CHARS)
    category: str | None = None
    pinned: bool = False


class FactUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=repo.MAX_FACT_CHARS)
    category: str | None = None
    pinned: bool | None = None


async def _embedding_status(model: str) -> dict:
    """Скачана ли модель эмбеддингов (для подсказки «поиск по смыслу / по словам»)."""
    try:
        names = {m.name for m in await get_backend().list_models()}
    except Exception:  # noqa: BLE001 — Ollama выключена: просто «недоступно»
        return {"model": model, "available": False}
    # «bge-m3» и «bge-m3:latest» — одна и та же модель
    full = model if ":" in model else f"{model}:latest"
    return {"model": model, "available": model in names or full in names}


@router.get("")
async def list_facts(q: str | None = None):
    items = repo.list_memories(q)
    all_items = items if not q else repo.list_memories()
    settings = settings_store.get_all()
    return {
        "items": items,
        "categories": repo.CATEGORIES,
        "stats": {
            "count": len(all_items),
            "tokens": sum(estimate_tokens(m["content"]) for m in all_items),
            "budget_tokens": settings["memory_budget_tokens"],
        },
        "settings": {k: settings[k] for k in ("memory_enabled", "memory_autosave", "memory_budget_tokens")},
        "embedding": await _embedding_status(settings["embedding_model"]),
    }


@router.post("", status_code=201)
def create_fact(body: FactCreate):
    try:
        fact, _ = repo.add_memory(body.content, category=body.category, pinned=body.pinned, source="manual")
    except repo.FactError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return fact


@router.put("/{memory_id}")
def update_fact(memory_id: int, body: FactUpdate):
    try:
        fact, _ = repo.update_memory(memory_id, content=body.content, category=body.category,
                                     pinned=body.pinned, source="manual")
    except repo.FactError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if fact is None:
        raise HTTPException(status_code=404, detail="Факт не найден")
    return fact


@router.delete("/{memory_id}")
def delete_fact(memory_id: int):
    event_id = repo.delete_memory(memory_id, source="manual")
    if event_id is None:
        raise HTTPException(status_code=404, detail="Факт не найден")
    return {"event_id": event_id}  # чтобы интерфейс мог предложить «Отменить»


@router.delete("")
def delete_all(confirm: str = ""):
    if confirm != "yes":
        raise HTTPException(status_code=400, detail="Для удаления всей памяти передайте confirm=yes")
    return {"deleted": repo.delete_all()}


@router.get("/events")
def list_events(limit: int = 50, conversation_id: str | None = None):
    return repo.list_events(conversation_id=conversation_id, limit=min(limit, 500))


@router.post("/events/{event_id}/undo")
def undo(event_id: int):
    try:
        return repo.undo_event(event_id)
    except repo.FactError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
