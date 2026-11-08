"""
HTTP API базы знаний.

  GET    /api/knowledge                          — коллекции, документы, сводка
  POST   /api/knowledge/collections              — создать коллекцию
  PATCH  /api/knowledge/collections/{id}         — переименовать
  DELETE /api/knowledge/collections/{id}         — удалить вместе с документами
  POST   /api/knowledge/folders                  — подключить папку (например, Obsidian)
  POST   /api/knowledge/collections/{id}/sync    — пересканировать папку
  POST   /api/knowledge/upload                   — загрузить файлы (multipart)
  DELETE /api/knowledge/documents/{id}           — удалить документ
  POST   /api/knowledge/documents/{id}/reindex   — переиндексировать
  GET    /api/knowledge/documents/{id}/file      — открыть оригинал
  GET    /api/knowledge/chunks/{id}              — фрагмент (для просмотра источника)
  GET    /api/knowledge/search?q=                — проверить, что найдёт поиск
  POST   /api/knowledge/reembed                  — досчитать недостающие векторы
"""

import mimetypes
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..llm import get_backend
from ..settings import store as settings_store
from . import store
from .indexer import indexer, uploads_dir
from .parsers import ParseError
from .search import search

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])

MAX_UPLOAD_FILES = 50


class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class FolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    name: str | None = Field(default=None, max_length=80)


def _collection_or_404(collection_id: int) -> dict:
    c = store.get_collection(collection_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Коллекция не найдена")
    return c


def _document_or_404(document_id: int) -> dict:
    d = store.get_document(document_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Документ не найден")
    return d


async def _embedding_status(model: str) -> dict:
    try:
        names = {m.name for m in await get_backend().list_models()}
    except Exception:  # noqa: BLE001
        return {"model": model, "available": False}
    full = model if ":" in model else f"{model}:latest"
    return {"model": model, "available": model in names or full in names}


@router.get("")
async def overview():
    collections = store.list_collections()
    docs = store.list_documents()
    for c in collections:
        c["documents"] = [d for d in docs if d["collection_id"] == c["id"]]
    cfg = settings_store.get_all()
    return {
        "collections": collections,
        "stats": store.stats(),
        "embedding": await _embedding_status(cfg["embedding_model"]),
        "current_document": indexer.current,
        "settings": {k: cfg[k] for k in ("rag_top_k", "rag_budget_tokens", "rag_min_score",
                                         "chunk_size", "chunk_overlap", "embedding_on_gpu")},
    }


@router.post("/collections", status_code=201)
def create_collection(body: CollectionCreate):
    return store.create_collection(body.name.strip())


@router.patch("/collections/{collection_id}")
def rename_collection(collection_id: int, body: CollectionCreate):
    _collection_or_404(collection_id)
    store.rename_collection(collection_id, body.name.strip())
    return store.get_collection(collection_id)


@router.delete("/collections/{collection_id}", status_code=204)
def delete_collection(collection_id: int):
    collection = _collection_or_404(collection_id)
    store.delete_collection(collection_id)
    if collection["kind"] == "upload":
        # Копии загруженных файлов больше не нужны. Файлы подключённой папки НЕ трогаем.
        folder = uploads_dir() / str(collection_id)
        if folder.is_dir():
            for f in folder.iterdir():
                f.unlink(missing_ok=True)
            folder.rmdir()


@router.post("/folders", status_code=201)
def add_folder(body: FolderCreate):
    path = Path(body.path.strip().strip('"')).expanduser()
    if not path.is_dir():
        raise HTTPException(status_code=422, detail=f"Папка не найдена: {path}")
    for c in store.list_collections():
        if c["kind"] == "folder" and c["path"] and Path(c["path"]).resolve() == path.resolve():
            raise HTTPException(status_code=409, detail=f"Эта папка уже подключена как «{c['name']}»")
    collection = store.create_collection((body.name or path.name or str(path)).strip(), "folder", str(path.resolve()))
    result = indexer.sync_folder(collection["id"])
    return {"collection": collection, "sync": result}


@router.post("/collections/{collection_id}/sync")
def sync_collection(collection_id: int):
    collection = _collection_or_404(collection_id)
    if collection["kind"] != "folder":
        raise HTTPException(status_code=400, detail="Синхронизировать можно только подключённую папку")
    try:
        return indexer.sync_folder(collection_id)
    except ParseError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/upload", status_code=201)
async def upload(files: list[UploadFile] = File(...), collection_id: int | None = Form(None)):
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(status_code=422, detail=f"За раз можно загрузить не больше {MAX_UPLOAD_FILES} файлов")
    if collection_id is None:
        collection = store.default_upload_collection()
    else:
        collection = _collection_or_404(collection_id)
        if collection["kind"] != "upload":
            raise HTTPException(status_code=400, detail="В подключённую папку файлы добавляются через саму папку")
    added, errors = [], []
    for f in files:
        try:
            added.append(indexer.add_upload(collection["id"], f.filename or "file", await f.read()))
        except ParseError as e:
            errors.append(str(e))
    return {"collection": collection, "documents": added, "errors": errors}


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: int):
    doc = _document_or_404(document_id)
    store.delete_document(document_id)
    collection = store.get_collection(doc["collection_id"])
    if collection and collection["kind"] == "upload":
        Path(doc["file_path"]).unlink(missing_ok=True)  # копия загруженного файла


@router.post("/documents/{document_id}/reindex")
def reindex(document_id: int):
    _document_or_404(document_id)
    store.set_status(document_id, "pending", progress=0)
    indexer.enqueue(document_id)
    return store.get_document(document_id)


@router.get("/documents/{document_id}/file")
def open_file(document_id: int):
    """Отдаёт оригинал. Путь берётся из базы по id — подсунуть чужой путь через адрес нельзя."""
    doc = _document_or_404(document_id)
    path = Path(doc["file_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл больше не существует на диске")
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if doc["file_type"] in ("md", "txt"):
        media = "text/plain; charset=utf-8"
    # inline — браузер откроет PDF у себя (и перейдёт на страницу по #page=5), а не скачает
    return FileResponse(path, media_type=media, filename=path.name, content_disposition_type="inline")


@router.get("/chunks/{chunk_id}")
def get_chunk(chunk_id: int):
    chunk = store.get_chunks([chunk_id]).get(chunk_id)
    if chunk is None:
        raise HTTPException(status_code=404, detail="Фрагмент не найден — возможно, документ удалён или переиндексирован")
    return chunk


@router.get("/search")
async def test_search(q: str, collection_id: int | None = None):
    cfg = settings_store.get_all()
    hits, method = await search(get_backend(), q, collection_id=collection_id, settings=cfg)
    return {"method": method, "results": hits}


@router.post("/reembed")
def reembed():
    return {"queued": indexer.reembed_all()}
