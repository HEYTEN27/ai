"""
HTTP API настроек и персон.

  GET    /api/settings                 — все настройки + значения по умолчанию + допустимые варианты
  PUT    /api/settings                 — изменить одну или несколько настроек
  POST   /api/settings/reset           — сбросить к умолчаниям ({"keys": [...]} или всё)
  GET    /api/settings/vram-estimate   — оценка видеопамяти для модели и контекста

  GET    /api/personas                 — список персон
  POST   /api/personas                 — создать свою персону
  PUT    /api/personas/{id}            — изменить
  DELETE /api/personas/{id}            — удалить (только свои)
  POST   /api/personas/{id}/reset      — вернуть встроенную персону к исходной
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..llm import LLMError, get_backend
from . import personas as personas_repo
from . import store, vram

router = APIRouter(prefix="/api", tags=["settings"])


class ResetRequest(BaseModel):
    keys: list[str] | None = None


# ---------- настройки ----------


@router.get("/settings")
def get_settings():
    return {
        "values": store.get_all(),
        "defaults": store.defaults(),
        "context_steps": store.CONTEXT_STEPS,
        "kv_cache_types": store.KV_CACHE_TYPES,
    }


@router.put("/settings")
def update_settings(changes: dict):
    try:
        values = store.update(changes)
    except (store.SettingsError, ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"values": values}


@router.post("/settings/reset")
def reset_settings(body: ResetRequest):
    if body.keys:
        unknown = set(body.keys) - set(store.defaults())
        if unknown:
            raise HTTPException(status_code=422, detail=f"Неизвестные настройки: {', '.join(sorted(unknown))}")
    return {"values": store.reset(body.keys)}


@router.get("/settings/vram-estimate")
async def vram_estimate(
    model: str,
    num_ctx: int = Query(ge=512, le=131072),
    kv_cache_type: str | None = None,
):
    """Оценка VRAM. Тип KV-кэша можно передать, чтобы посчитать «что будет, если»."""
    values = store.get_all()
    kv_type = kv_cache_type or values["kv_cache_type"]
    if kv_type not in store.KV_CACHE_TYPES:
        raise HTTPException(status_code=422, detail="Неизвестный тип KV-кэша")
    try:
        models = {m.name: m for m in await get_backend().list_models()}
    except LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    info = models.get(model)
    if info is None or not info.size_bytes:
        raise HTTPException(status_code=404, detail=f"Модель «{model}» не найдена или её размер неизвестен")

    common = dict(
        weights_bytes=info.size_bytes,
        kv_bytes_per_token=info.kv_bytes_per_token,
        kv_cache_type=kv_type,
        vram_total_gb=values["vram_total_gb"],
        vram_reserved_gb=values["vram_reserved_gb"],
    )
    result = vram.estimate(num_ctx=num_ctx, **common)
    result["max_safe_context"] = vram.max_safe_context(steps=store.CONTEXT_STEPS, **common)
    result["kv_cache_type"] = kv_type
    return result


# ---------- персоны ----------


def _persona_or_404(persona_id: int) -> dict:
    persona = personas_repo.get_persona(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="Персона не найдена")
    return persona


@router.get("/personas")
def list_personas():
    return personas_repo.list_personas()


@router.post("/personas", status_code=201)
def create_persona(fields: dict):
    try:
        return personas_repo.create_persona(fields)
    except personas_repo.PersonaError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.put("/personas/{persona_id}")
def update_persona(persona_id: int, fields: dict):
    _persona_or_404(persona_id)
    try:
        return personas_repo.update_persona(persona_id, fields)
    except personas_repo.PersonaError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/personas/{persona_id}/reset")
def reset_persona(persona_id: int):
    _persona_or_404(persona_id)
    try:
        return personas_repo.reset_persona(persona_id)
    except personas_repo.PersonaError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/personas/{persona_id}", status_code=204)
def delete_persona(persona_id: int):
    _persona_or_404(persona_id)
    try:
        personas_repo.delete_persona(persona_id)
    except personas_repo.PersonaError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Если удалили персону по умолчанию — возвращаемся к «Универсальному»
    if store.get("default_persona_id") == persona_id:
        store.update({"default_persona_id": None})
