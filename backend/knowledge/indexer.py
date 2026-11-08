"""
Индексация документов в фоне.

Очередь задач обрабатывается одной фоновой корутиной, по одному документу:
  1. разобрать файл (PDF/DOCX/TXT/MD) — в отдельном потоке, чтобы не тормозить сервер;
  2. нарезать на фрагменты;
  3. записать фрагменты в SQLite и полнотекстовый индекс — по словам уже можно искать;
  4. посчитать векторы пачками по 8 (bge-m3 на процессоре: ~0,2–0,5 с на фрагмент),
     обновляя прогресс — интерфейс показывает полоску «обработано 40 из 120».

Если модель эмбеддингов не скачана, документ всё равно индексируется: поиск по словам
работает, а векторы можно досчитать позже кнопкой «Досчитать векторы».

Синхронизация папки (Obsidian): сравниваем файлы на диске с документами в базе —
новые и изменённые (по времени изменения и размеру) индексируем, удалённые убираем.
"""

import asyncio
import hashlib
import logging
from pathlib import Path

from ..config import settings as env
from ..llm import LLMError, get_backend
from ..settings import store as settings_store
from . import store
from .chunker import chunk_blocks, chunk_header
from .parsers import ParseError, file_type, parse_file

log = logging.getLogger(__name__)

EMBED_BATCH = 8
MAX_FILE_BYTES = 50 * 1024 * 1024  # больше 50 МБ — скорее всего, не учебник, а что-то не то
MAX_FOLDER_FILES = 5000
# Служебные папки, которые не индексируем: настройки Obsidian, корзина, git, зависимости
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules", "__pycache__", ".venv"}


def uploads_dir() -> Path:
    return env.data_dir / "knowledge" / "uploads"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class Indexer:
    def __init__(self):
        self.queue: asyncio.Queue[tuple[str, int]] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self.current: int | None = None  # id документа, который обрабатывается сейчас

    # ---------- жизненный цикл ----------

    def start(self) -> None:
        self.queue = asyncio.Queue()  # очередь привязана к текущему циклу событий
        self._task = asyncio.create_task(self._worker())
        # Сервер могли выключить посреди индексации — доделываем незавершённое
        for doc in store.list_documents():
            if doc["status"] in ("pending", "indexing"):
                self.queue.put_nowait(("index", doc["id"]))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def enqueue(self, document_id: int, kind: str = "index") -> None:
        self.queue.put_nowait((kind, document_id))

    async def _worker(self) -> None:
        while True:
            kind, doc_id = await self.queue.get()
            self.current = doc_id
            try:
                if kind == "index":
                    await self.index_document(doc_id)
                else:
                    await self.embed_document(doc_id)
            except Exception as e:  # noqa: BLE001 — одна битая задача не должна останавливать очередь
                log.exception("Ошибка индексации документа %s", doc_id)
                store.set_status(doc_id, "error", error=f"Внутренняя ошибка: {e}")
            finally:
                self.current = None
                self.queue.task_done()

    # ---------- индексация одного документа ----------

    async def index_document(self, doc_id: int) -> None:
        doc = store.get_document(doc_id)
        if doc is None:
            return  # документ удалили, пока он ждал в очереди
        store.set_status(doc_id, "indexing", progress=0)
        path = Path(doc["file_path"])
        if not path.exists():
            store.set_status(doc_id, "error", error="Файл не найден на диске")
            return
        try:
            parsed = await asyncio.to_thread(parse_file, path)
        except ParseError as e:
            store.set_status(doc_id, "error", error=str(e))
            return

        cfg = settings_store.get_all()
        chunks = chunk_blocks(parsed.blocks, size=cfg["chunk_size"], overlap=cfg["chunk_overlap"])
        store.replace_chunks(doc_id, [
            {"text": c.text, "section": c.section, "page_start": c.page_start, "page_end": c.page_end,
             "header": chunk_header(parsed.title, c)}
            for c in chunks
        ])
        store.set_status(doc_id, "indexing", title=parsed.title, page_count=parsed.page_count)
        await self.embed_document(doc_id)

    async def embed_document(self, doc_id: int) -> None:
        """Считает недостающие векторы фрагментов документа."""
        if store.get_document(doc_id) is None:
            return
        cfg = settings_store.get_all()
        model = cfg["embedding_model"]
        todo = store.chunks_without_vectors(model, doc_id)
        total = store.get_document(doc_id)["chunk_count"]
        done = total - len(todo)
        warning = None
        for start in range(0, len(todo), EMBED_BATCH):
            batch = todo[start:start + EMBED_BATCH]
            # К тексту добавляем шапку «Документ › Раздел» — так поиск по смыслу точнее
            texts = [f"{' › '.join(x for x in (c['title'], c['section']) if x)}\n{c['text']}" for c in batch]
            try:
                vectors = await get_backend().embed(model, texts, on_gpu=cfg["embedding_on_gpu"])
            except LLMError as e:
                warning = (f"Поиск по смыслу недоступен ({e}). Работает поиск по словам. "
                           f"Скачайте модель: ollama pull {model} — и нажмите «Досчитать векторы».")
                break
            if len(vectors) != len(batch):
                warning = "Модель эмбеддингов вернула неожиданный ответ — работает только поиск по словам."
                break
            store.save_vectors([(c["id"], v) for c, v in zip(batch, vectors)], model)
            done += len(batch)
            store.set_status(doc_id, "indexing", progress=done)
        # error у готового документа — это предупреждение, а не ошибка
        store.set_status(doc_id, "ready", error=warning, progress=done)

    # ---------- загрузка файлов ----------

    def add_upload(self, collection_id: int, filename: str, content: bytes) -> dict:
        """Сохраняет загруженный файл в data/knowledge/uploads и ставит его в очередь."""
        safe = Path(filename).name.replace("\\", "_").replace("/", "_").strip() or "file"
        kind = file_type(Path(safe))
        if kind is None:
            raise ParseError(f"«{safe}»: формат не поддерживается (нужны PDF, DOCX, TXT, MD)")
        if len(content) > MAX_FILE_BYTES:
            raise ParseError(f"«{safe}»: файл больше 50 МБ")
        folder = uploads_dir() / str(collection_id)
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / safe
        path.write_bytes(content)
        doc = store.upsert_document(
            collection_id, rel_path=safe, file_path=str(path), file_type=kind, title=path.stem,
            size_bytes=len(content), mtime=path.stat().st_mtime, sha256=hashlib.sha256(content).hexdigest(),
        )
        self.enqueue(doc["id"])
        return doc

    # ---------- синхронизация папки ----------

    def sync_folder(self, collection_id: int) -> dict:
        collection = store.get_collection(collection_id)
        root = Path(collection["path"]).expanduser()
        if not root.is_dir():
            raise ParseError(f"Папка не найдена: {root}")

        on_disk: dict[str, Path] = {}
        for path in root.rglob("*"):
            rel = path.relative_to(root)
            if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts[:-1]):
                continue
            if path.is_file() and file_type(path) and path.stat().st_size <= MAX_FILE_BYTES:
                on_disk[rel.as_posix()] = path
                if len(on_disk) >= MAX_FOLDER_FILES:
                    break

        existing = {d["rel_path"]: d for d in store.list_documents(collection_id)}
        result = {"added": 0, "updated": 0, "removed": 0, "unchanged": 0}
        for rel, path in on_disk.items():
            st = path.stat()
            doc = existing.get(rel)
            if doc and doc["mtime"] == st.st_mtime and doc["size_bytes"] == st.st_size and doc["status"] != "error":
                result["unchanged"] += 1
                continue
            new = store.upsert_document(
                collection_id, rel_path=rel, file_path=str(path), file_type=file_type(path),
                title=path.stem, size_bytes=st.st_size, mtime=st.st_mtime, sha256=None,
            )
            self.enqueue(new["id"])
            result["updated" if doc else "added"] += 1
        for rel, doc in existing.items():
            if rel not in on_disk:
                store.delete_document(doc["id"])
                result["removed"] += 1
        store.mark_synced(collection_id)
        return result

    def reembed_all(self) -> int:
        """Ставит в очередь досчёт векторов для всех документов, где их не хватает."""
        model = settings_store.get("embedding_model")
        doc_ids = sorted({c_doc for c_doc in self._docs_missing_vectors(model)})
        for doc_id in doc_ids:
            store.set_status(doc_id, "pending")
            self.enqueue(doc_id, kind="embed")
        return len(doc_ids)

    @staticmethod
    def _docs_missing_vectors(model: str) -> list[int]:
        from ..db import get_conn

        with get_conn() as conn:
            rows = conn.execute(
                """SELECT DISTINCT c.document_id FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
                   WHERE d.status = 'ready' AND (c.embedding IS NULL OR c.embedding_model IS NOT ?)""",
                (model,),
            ).fetchall()
        return [r[0] for r in rows]


indexer = Indexer()
