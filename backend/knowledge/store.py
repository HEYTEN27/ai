"""
Хранилище базы знаний: коллекции, документы, фрагменты (SQLite) и векторный индекс.

Векторный индекс — «аналог ChromaDB» на numpy. Все векторы фрагментов лежат в
SQLite (BLOB float32), а для поиска один раз загружаются в матрицу в памяти.
Поиск = умножение матрицы на вектор вопроса: для 10 000 фрагментов это
миллисекунды, а отдельный сервер или тяжёлая библиотека не нужны.
Векторы нормированы (длина 1), поэтому скалярное произведение = косинусная близость.
"""

import threading
from datetime import datetime, timezone

import numpy as np

from ..db import get_conn

DEFAULT_COLLECTION = "Мои файлы"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- коллекции ----------


def list_collections() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT c.*,
                      COUNT(d.id) AS document_count,
                      COALESCE(SUM(d.chunk_count), 0) AS chunk_count
               FROM kb_collections c LEFT JOIN kb_documents d ON d.collection_id = c.id
               GROUP BY c.id ORDER BY c.id"""
        ).fetchall()
    return [dict(r) for r in rows]


def get_collection(collection_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM kb_collections WHERE id = ?", (collection_id,)).fetchone()
    return dict(row) if row else None


def create_collection(name: str, kind: str = "upload", path: str | None = None) -> dict:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO kb_collections (name, kind, path, created_at) VALUES (?, ?, ?, ?)",
            (name, kind, path, _now()),
        )
    return get_collection(cur.lastrowid)


def default_upload_collection() -> dict:
    """Коллекция «Мои файлы» для загрузок — создаётся при первой загрузке."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM kb_collections WHERE kind = 'upload' ORDER BY id LIMIT 1").fetchone()
    return dict(row) if row else create_collection(DEFAULT_COLLECTION)


def rename_collection(collection_id: int, name: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE kb_collections SET name = ? WHERE id = ?", (name, collection_id))


def mark_synced(collection_id: int) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE kb_collections SET synced_at = ? WHERE id = ?", (_now(), collection_id))


def delete_collection(collection_id: int) -> None:
    with get_conn() as conn:
        # Полнотекстовый индекс — виртуальная таблица, каскадное удаление на неё не действует
        conn.execute(
            "DELETE FROM kb_fts WHERE rowid IN (SELECT c.id FROM kb_chunks c JOIN kb_documents d "
            "ON d.id = c.document_id WHERE d.collection_id = ?)", (collection_id,))
        conn.execute("DELETE FROM kb_collections WHERE id = ?", (collection_id,))
    vector_index.invalidate()


# ---------- документы ----------


def list_documents(collection_id: int | None = None) -> list[dict]:
    sql = "SELECT * FROM kb_documents"
    params: tuple = ()
    if collection_id is not None:
        sql += " WHERE collection_id = ?"
        params = (collection_id,)
    with get_conn() as conn:
        rows = conn.execute(sql + " ORDER BY rel_path", params).fetchall()
    return [dict(r) for r in rows]


def get_document(document_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM kb_documents WHERE id = ?", (document_id,)).fetchone()
    return dict(row) if row else None


def upsert_document(collection_id: int, *, rel_path: str, file_path: str, file_type: str, title: str,
                    size_bytes: int, mtime: float | None, sha256: str | None) -> dict:
    """Создаёт документ или (если такой путь уже есть в коллекции) ставит его на переиндексацию."""
    now = _now()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO kb_documents
               (collection_id, title, rel_path, file_path, file_type, size_bytes, mtime, sha256,
                status, error, progress, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?)
               ON CONFLICT (collection_id, rel_path) DO UPDATE SET
                 title = excluded.title, file_path = excluded.file_path, file_type = excluded.file_type,
                 size_bytes = excluded.size_bytes, mtime = excluded.mtime, sha256 = excluded.sha256,
                 status = 'pending', error = NULL, progress = 0, updated_at = excluded.updated_at""",
            (collection_id, title, rel_path, file_path, file_type, size_bytes, mtime, sha256, now, now),
        )
        row = conn.execute(
            "SELECT * FROM kb_documents WHERE collection_id = ? AND rel_path = ?", (collection_id, rel_path)
        ).fetchone()
    return dict(row)


def set_status(document_id: int, status: str, *, error: str | None = None, progress: int | None = None,
               title: str | None = None, page_count: int | None = None) -> None:
    fields, values = ["status = ?", "error = ?", "updated_at = ?"], [status, error, _now()]
    if progress is not None:
        fields.append("progress = ?")
        values.append(progress)
    if title is not None:
        fields.append("title = ?")
        values.append(title)
    if page_count is not None:
        fields.append("page_count = ?")
        values.append(page_count)
    with get_conn() as conn:
        conn.execute(f"UPDATE kb_documents SET {', '.join(fields)} WHERE id = ?", (*values, document_id))


def delete_document(document_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE document_id = ?)",
                     (document_id,))
        conn.execute("DELETE FROM kb_documents WHERE id = ?", (document_id,))
    vector_index.invalidate()


# ---------- фрагменты ----------


def replace_chunks(document_id: int, chunks: list[dict]) -> list[int]:
    """Заменяет все фрагменты документа новыми. Возвращает id созданных фрагментов."""
    ids = []
    with get_conn() as conn:
        conn.execute("DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE document_id = ?)",
                     (document_id,))
        conn.execute("DELETE FROM kb_chunks WHERE document_id = ?", (document_id,))
        for i, c in enumerate(chunks):
            cur = conn.execute(
                "INSERT INTO kb_chunks (document_id, ord, text, section, page_start, page_end) VALUES (?, ?, ?, ?, ?, ?)",
                (document_id, i, c["text"], c["section"], c["page_start"], c["page_end"]),
            )
            # В полнотекстовый индекс кладём и раздел — по названию раздела тоже должно находиться
            conn.execute("INSERT INTO kb_fts (rowid, text) VALUES (?, ?)",
                         (cur.lastrowid, f"{c.get('header') or ''}\n{c['text']}"))
            ids.append(cur.lastrowid)
        conn.execute("UPDATE kb_documents SET chunk_count = ? WHERE id = ?", (len(chunks), document_id))
    vector_index.invalidate()
    return ids


def save_vectors(items: list[tuple[int, list[float]]], model: str) -> None:
    """Сохраняет векторы фрагментов (предварительно нормируя их до длины 1)."""
    rows = []
    for chunk_id, vec in items:
        arr = np.asarray(vec, dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        if norm:
            arr = arr / norm
        rows.append((arr.tobytes(), model, chunk_id))
    with get_conn() as conn:
        conn.executemany("UPDATE kb_chunks SET embedding = ?, embedding_model = ? WHERE id = ?", rows)
    vector_index.invalidate()


def chunks_without_vectors(model: str, document_id: int | None = None) -> list[dict]:
    sql = """SELECT c.id, c.text, c.section, d.title FROM kb_chunks c
             JOIN kb_documents d ON d.id = c.document_id
             WHERE (c.embedding IS NULL OR c.embedding_model IS NOT ?)"""
    params: tuple = (model,)
    if document_id is not None:
        sql += " AND c.document_id = ?"
        params += (document_id,)
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(sql + " ORDER BY c.id", params).fetchall()]


def get_chunks(chunk_ids: list[int]) -> dict[int, dict]:
    """Фрагменты с данными документа и коллекции, по id."""
    if not chunk_ids:
        return {}
    marks = ",".join("?" * len(chunk_ids))
    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT c.id, c.document_id, c.ord, c.text, c.section, c.page_start, c.page_end,
                       d.title, d.rel_path, d.file_type, d.collection_id, k.name AS collection_name
                FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
                JOIN kb_collections k ON k.id = d.collection_id
                WHERE c.id IN ({marks})""",
            chunk_ids,
        ).fetchall()
    return {r["id"]: dict(r) for r in rows}


def fts_search(query: str, *, collection_id: int | None, limit: int) -> list[tuple[int, float]]:
    """Поиск по словам (FTS5). Возвращает [(id фрагмента, оценка)], лучшие первыми.

    Русских окончаний FTS5 не понимает, поэтому ищем по началу слова:
    «замыкания» → «замык*» найдёт и «замыкание», и «замыканиями».
    """
    import re

    words = [w for w in re.findall(r"[\wёЁ]+", query.lower()) if len(w) > 2]
    if not words:
        return []
    terms = [f'"{w[:max(4, len(w) - 2)]}"*' for w in words]  # отрезаем окончание (~2 буквы)
    match = " OR ".join(terms)
    sql = """SELECT f.rowid, bm25(kb_fts) AS score FROM kb_fts f
             JOIN kb_chunks c ON c.id = f.rowid JOIN kb_documents d ON d.id = c.document_id
             WHERE kb_fts MATCH ? AND d.status = 'ready'"""
    params: list = [match]
    if collection_id is not None:
        sql += " AND d.collection_id = ?"
        params.append(collection_id)
    sql += " ORDER BY score LIMIT ?"  # в bm25 чем меньше число, тем лучше совпадение
    params.append(limit)
    with get_conn() as conn:
        try:
            rows = conn.execute(sql, params).fetchall()
        except Exception:  # noqa: BLE001 — странный запрос не должен ронять чат
            return []
    return [(r["rowid"], -r["score"]) for r in rows]


def stats() -> dict:
    with get_conn() as conn:
        row = conn.execute(
            """SELECT COUNT(*) AS documents,
                      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
                      SUM(CASE WHEN status IN ('pending', 'indexing') THEN 1 ELSE 0 END) AS in_progress,
                      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
               FROM kb_documents"""
        ).fetchone()
        chunks = conn.execute("SELECT COUNT(*), COUNT(embedding) FROM kb_chunks").fetchone()
    return {"documents": row["documents"] or 0, "ready": row["ready"] or 0,
            "in_progress": row["in_progress"] or 0, "errors": row["errors"] or 0,
            "chunks": chunks[0], "chunks_with_vectors": chunks[1]}


# ---------- векторный индекс ----------


class VectorIndex:
    """Матрица всех векторов в памяти. Пересобирается лениво после изменений."""

    def __init__(self):
        self._lock = threading.Lock()
        self._dirty = True
        self._ids = np.zeros(0, dtype=np.int64)
        self._collections = np.zeros(0, dtype=np.int64)
        self._matrix = np.zeros((0, 0), dtype=np.float32)
        self._model: str | None = None

    def invalidate(self) -> None:
        self._dirty = True

    def _load(self, model: str) -> None:
        with get_conn() as conn:
            rows = conn.execute(
                """SELECT c.id, c.embedding, d.collection_id FROM kb_chunks c
                   JOIN kb_documents d ON d.id = c.document_id
                   WHERE c.embedding IS NOT NULL AND c.embedding_model = ? AND d.status = 'ready'""",
                (model,),
            ).fetchall()
        if rows:
            self._matrix = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
        else:
            self._matrix = np.zeros((0, 0), dtype=np.float32)
        self._ids = np.array([r["id"] for r in rows], dtype=np.int64)
        self._collections = np.array([r["collection_id"] for r in rows], dtype=np.int64)
        self._model = model
        self._dirty = False

    def search(self, query_vec: list[float], *, model: str, collection_id: int | None,
               limit: int) -> list[tuple[int, float]]:
        """[(id фрагмента, косинусная близость)], самые похожие первыми."""
        with self._lock:
            if self._dirty or self._model != model:
                self._load(model)
            if not len(self._ids):
                return []
            q = np.asarray(query_vec, dtype=np.float32)
            norm = float(np.linalg.norm(q))
            if not norm or q.shape[0] != self._matrix.shape[1]:
                return []
            scores = self._matrix @ (q / norm)  # близость с каждым фрагментом за одну операцию
            if collection_id is not None:
                scores = np.where(self._collections == collection_id, scores, -1.0)
            top = np.argsort(-scores)[:limit]
            return [(int(self._ids[i]), float(scores[i])) for i in top if scores[i] > -1.0]


vector_index = VectorIndex()
