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
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from ..chat import repository as chat_repo
from ..projects import repository as projects_repo
from . import docgen, model3d, store, vision
from .extract import IMAGE_EXTENSIONS, MIME_TYPES, MODEL_EXTENSIONS, ExtractError, check_supported, extract_bytes, mime_for

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 МБ — больше в контекст всё равно не поместится
READ_CHUNK = 1024 * 1024


def _get_or_404(file_id: str) -> dict:
    record = store.get_file(file_id)
    if record is None or not store.path_of(record).is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    return record


@router.post("", status_code=201)
async def upload(file: UploadFile = File(...), conversation_id: str | None = Form(default=None),
                 project_id: int | None = Form(default=None)):
    name = store.safe_name(file.filename or "файл")
    try:
        check_supported(name)  # сначала расширение — не качаем зря 20 МБ картинки
    except ExtractError as e:
        raise HTTPException(status_code=415, detail=str(e)) from e
    if conversation_id and chat_repo.get_conversation(conversation_id) is None:
        raise HTTPException(status_code=404, detail="Диалог не найден")
    if project_id is not None and projects_repo.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if project_id is not None and Path(name).suffix.lower() in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=415, detail="В проект кладите документы и тексты; картинки прикрепляйте к сообщению")

    # Читаем частями и обрываем на лимите, а не грузим в память файл любого размера
    data = bytearray()
    while chunk := await file.read(READ_CHUNK):
        data += chunk
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Файл больше 25 МБ. Разделите его или добавьте в базу знаний.")
    data = bytes(data)
    ext = Path(name).suffix.lower()

    # Картинка (этап 14): текста нет — делаем уменьшенную копию для модели зрения
    if ext in IMAGE_EXTENSIONS:
        try:
            meta, jpeg = await asyncio.to_thread(vision.prepare_image, data)
        except vision.VisionError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        record = store.create_file(kind="upload", name=name, data=data, mime=mime_for(name),
                                   conversation_id=conversation_id, meta=meta)
        store.write_extra(record, vision.VISION_NAME, jpeg)
        return record

    # 3D-модель (этап 15б): считаем габариты, объём и расход пластика — это и есть «текст» для модели
    if ext in MODEL_EXTENSIONS:
        try:
            text, meta = await asyncio.to_thread(model3d.analyze, data, name)
        except model3d.ModelError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        return store.create_file(kind="upload", name=name, data=data, mime=mime_for(name),
                                 conversation_id=conversation_id, text=text, meta=meta, project_id=project_id)

    try:
        # Разбор PDF на сотни страниц занимает секунды — в отдельном потоке, чтобы сервер не замирал
        extracted = await asyncio.to_thread(extract_bytes, data, name)
    except ExtractError as e:
        if ext == ".pdf" and re.search(r"не найдено текста|скан", str(e)):  # PDF без текстового слоя
            return await _upload_scan(data, name, conversation_id)
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:  # повреждённый файл: библиотека разбора упала с непредсказуемой ошибкой
        raise HTTPException(status_code=422, detail=f"Не удалось прочитать файл: {e}") from e
    meta = {**extracted.meta, "tokens": extracted.meta["chars"] // 3}
    record = store.create_file(kind="upload", name=name, data=data, mime=mime_for(name),
                               conversation_id=conversation_id, text=extracted.text, meta=meta, project_id=project_id)
    if project_id is not None:
        projects_repo.touch(project_id)
    return record


async def _upload_scan(data: bytes, name: str, conversation_id: str | None) -> dict:
    """PDF без текста — скан: первые страницы-картинки покажем модели зрения."""
    try:
        total, pages = await asyncio.to_thread(vision.scan_pages, data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"В PDF нет текста, и картинки страниц не извлечь: {e}") from e
    if not pages:
        raise HTTPException(status_code=422, detail="В PDF нет ни текста, ни картинок страниц.")
    meta = {"type": "scan", "pages": total, "scan_pages": len(pages)}
    record = store.create_file(kind="upload", name=name, data=data, mime=MIME_TYPES[".pdf"],
                               conversation_id=conversation_id, meta=meta)
    for n, jpeg in enumerate(pages, 1):
        store.write_extra(record, vision.page_name(n), jpeg)
    return record


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


@router.get("/{file_id}/preview")
def preview(file_id: str):
    """Уменьшенная JPEG-копия картинки (для миниатюр в чате) — или первая страница скана."""
    record = _get_or_404(file_id)
    paths = vision.vision_files(store.path_of(record).parent, record["meta"])
    if not paths or not paths[0].is_file():
        raise HTTPException(status_code=404, detail="У файла нет картинки")
    return FileResponse(paths[0], media_type="image/jpeg")


@router.delete("/{file_id}", status_code=204)
def remove(file_id: str):
    record = store.get_file(file_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Файл не найден")
    # Удалить можно ещё не отправленное вложение или файл проекта
    if record["kind"] != "upload" or (record["message_id"] is not None and record.get("project_id") is None):
        raise HTTPException(status_code=409, detail="Файл уже в переписке — он удалится вместе с диалогом")
    store.delete_file(file_id)
