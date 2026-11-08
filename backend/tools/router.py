"""
HTTP API инструментов.

  GET  /api/tools                 — какие инструменты есть и доступны ли (для настроек)
  POST /api/tools/confirm/{id}    — ответ пользователя на «Разрешить / Отклонить»
  GET  /api/tools/files/check     — проверить папку для чтения файлов
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..settings import store as settings_store
from . import confirm, files
from .registry import TOOLS, availability

router = APIRouter(prefix="/api/tools", tags=["tools"])


class ConfirmBody(BaseModel):
    approved: bool


@router.get("")
def list_tools():
    settings = settings_store.get_all()
    reasons = availability(settings)
    return [
        {"name": t.name, "title": t.title, "icon": t.icon, "online": t.online,
         "available": reasons[t.name] is None, "reason": reasons[t.name], "needs_confirm": t.confirm(settings)}
        for t in TOOLS.values()
    ]


@router.post("/confirm/{confirm_id}")
async def answer_confirmation(confirm_id: str, body: ConfirmBody):
    # async — чтобы выполниться в том же цикле событий, где ждёт генерация ответа
    if not confirm.resolve(confirm_id, body.approved):
        raise HTTPException(status_code=404, detail="Запрос на подтверждение не найден или уже устарел")
    return {"ok": True}


@router.get("/files/check")
def check_folder(path: str):
    try:
        listing = files.list_files(path, ".", recursive=True)
    except files.FileToolError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    count = sum(1 for e in listing["entries"] if e["type"] == "file")
    return {"ok": True, "files": count, "truncated": listing["truncated"], "path": str(files.root_path(path))}
