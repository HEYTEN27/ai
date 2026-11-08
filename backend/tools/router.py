"""
HTTP API инструментов.

  GET  /api/tools                 — какие инструменты есть и доступны ли (для настроек)
  POST /api/tools/confirm/{id}    — ответ пользователя на «Разрешить / Отклонить»
  GET  /api/tools/files/check     — проверить папку для чтения файлов
  POST /api/tools/run-python      — «▶ Проверить» под блоком кода: запустить его в песочнице
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..settings import store as settings_store
from . import confirm, files, sandbox
from .registry import TOOLS, availability

router = APIRouter(prefix="/api/tools", tags=["tools"])


class ConfirmBody(BaseModel):
    approved: bool


class RunBody(BaseModel):
    code: str = Field(min_length=1, max_length=100_000)


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


@router.post("/run-python")
async def run_python(body: RunBody):
    """Пользователь сам нажал «▶ Проверить» — это и есть разрешение, отдельного вопроса не задаём.
    Код запускается в той же песочнице, что и инструмент run_python: без сети и без доступа к файлам."""
    settings = settings_store.get_all()
    if not settings["tool_python"]:
        raise HTTPException(status_code=403, detail="Python-песочница выключена в настройках (⚙ → «Инструменты»)")
    return await sandbox.run_python(body.code, timeout=settings["python_timeout"])
