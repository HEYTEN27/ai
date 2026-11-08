"""
HTTP API файлов.

  POST   /api/files                         — загрузить вложение (текст извлекается сразу)
  GET    /api/files/{id}                    — сведения о файле
  GET    /api/files/{id}/download           — скачать
  DELETE /api/files/{id}                    — убрать ещё не отправленное вложение
  GET    /api/files/from-message/{msg_id}   — ответ Джарвиса как документ Word (кнопка под ответом)
"""

import asyncio
import re

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from ..chat import repository as chat_repo
from . import docgen, store
from .extract import MIME_TYPES, ExtractError, check_supported, extract_bytes, mime_for

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 МБ — больше в контекст всё равно не поместится
READ_CHUNK = 1024 * 1024


def _get_or_404(file_id: str) -> dict:
    record = store.get_file(file_id)
    if record is None or not store.path_of(record).is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    return record


@router.post("", status_code=201)
async def upload(file: UploadFile = File(...), conversation_id: str | None = Form(default=None)):
    name = store.safe_name(file.filename or "файл")
    try:
        check_supported(name)  # сначала расширение — не качаем зря 20 МБ картинки
    except ExtractError as e:
        raise HTTPException(status_code=415, detail=str(e)) from e
    if conversation_id and chat_repo.get_conversation(conversation_id) is None:
        raise HTTPException(status_code=404, detail="Диалог не найден")

    # Читаем частями и обрываем на лимите, а не грузим в память файл любого размера
    data = bytearray()
    while chunk := await file.read(READ_CHUNK):
        data += chunk
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Файл больше 25 МБ. Разделите его или добавьте в базу знаний.")
    try:
        # Разбор PDF на сотни страниц занимает секунды — в отдельном потоке, чтобы сервер не замирал
        extracted = await asyncio.to_thread(extract_bytes, bytes(data), name)
    except ExtractError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:  # повреждённый файл: библиотека разбора упала с непредсказуемой ошибкой
        raise HTTPException(status_code=422, detail=f"Не удалось прочитать файл: {e}") from e
    meta = {**extracted.meta, "tokens": extracted.meta["chars"] // 3}
    return store.create_file(kind="upload", name=name, data=bytes(data), mime=mime_for(name),
                             conversation_id=conversation_id, text=extracted.text, meta=meta)


@router.get("/from-message/{message_id}")
async def message_as_docx(message_id: int):
    message = chat_repo.get_message(message_id)
    if message is None or message["role"] != "assistant":
        raise HTTPException(status_code=404, detail="Ответ не найден")
    content = message.get("corrected") or message["content"]
    if message.get("extras") and message["extras"].get("sources"):
        content = re.sub(r"\[(\d+)\]", "", content)  # ссылки [1] на базу знаний вне чата никуда не ведут
    conv = chat_repo.get_conversation(message["conversation_id"]) or {}
    title = conv.get("title") or "Ответ Джарвиса"
    try:
        data = await asyncio.to_thread(docgen.markdown_to_docx, content, None)
    except docgen.DocError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    name = store.with_extension(title, ".docx")
    return Response(data, media_type=MIME_TYPES[".docx"], headers={
        # filename* — имя в UTF-8 (кириллица); filename — запасное латиницей для старых программ
        "Content-Disposition": f"attachment; filename=\"jarvis.docx\"; filename*=UTF-8''{_quote(name)}",
    })


def _quote(name: str) -> str:
    from urllib.parse import quote
    return quote(name, safe="")


@router.get("/{file_id}")
def info(file_id: str):
    return _get_or_404(file_id)


@router.get("/{file_id}/download")
def download(file_id: str):
    record = _get_or_404(file_id)
    return FileResponse(store.path_of(record), media_type=record["mime"], filename=record["name"])


@router.delete("/{file_id}", status_code=204)
def remove(file_id: str):
    record = store.get_file(file_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Файл не найден")
    if record["kind"] != "upload" or record["message_id"] is not None:
        raise HTTPException(status_code=409, detail="Файл уже в переписке — он удалится вместе с диалогом")
    store.delete_file(file_id)
