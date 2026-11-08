"""
Хранилище фактов о пользователе и журнал изменений памяти.

Каждое изменение (запомнил / изменил / забыл) записывается в memory_events.
Благодаря журналу любое изменение можно отменить — и автоматическое, и ручное.
"""

import array
import re
from datetime import datetime, timezone

from ..db import get_conn

CATEGORIES = ["личное", "учёба", "работа", "навыки", "интересы", "предпочтения", "другое"]
MAX_FACT_CHARS = 300


class FactError(ValueError):
    """Ошибка с понятным пользователю текстом."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _to_dict(row) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    data.pop("embedding", None)  # вектор из 1024 чисел интерфейсу не нужен
    data["pinned"] = bool(data["pinned"])
    return data


def clean_content(text: str) -> str:
    """Приводит факт к аккуратному виду: одна строка, без лишних пробелов, с большой буквы."""
    text = re.sub(r"\s+", " ", str(text)).strip().strip("-•*").strip()
    if not text:
        raise FactError("Факт не может быть пустым")
    if len(text) > MAX_FACT_CHARS:
        raise FactError(f"Факт слишком длинный (максимум {MAX_FACT_CHARS} символов)")
    return text[0].upper() + text[1:]


def clean_category(category: str | None) -> str:
    return category if category in CATEGORIES else "другое"


# ---------- векторы смысла (эмбеддинги) ----------
# Храним как BLOB из float32 — это в 4 раза компактнее, чем JSON-список чисел.


def pack_vector(vector: list[float]) -> bytes:
    return array.array("f", vector).tobytes()


def unpack_vector(blob: bytes) -> list[float]:
    vec = array.array("f")
    vec.frombytes(blob)
    return vec.tolist()


# ---------- чтение ----------


def list_memories(query: str | None = None) -> list[dict]:
    """Все факты: закреплённые сверху, затем по категориям и дате. query — фильтр по подстроке."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM memories ORDER BY pinned DESC, category, created_at DESC").fetchall()
        result = [_to_dict(r) for r in rows]
        # Название диалога, из которого пришёл факт — чтобы показать «из диалога «…»»
        titles = dict(conn.execute("SELECT id, title FROM conversations").fetchall())
    for item in result:
        item["conversation_title"] = titles.get(item["conversation_id"])
    if query:
        # Фильтруем в Python, а не через SQL LIKE: LIKE в SQLite игнорирует регистр
        # только у латиницы, и «КАЗАН» не нашёл бы «Казани». Фактов немного — это быстро.
        q = query.lower()
        result = [m for m in result if q in m["content"].lower()]
    return result


def get_memory(memory_id: int) -> dict | None:
    with get_conn() as conn:
        return _to_dict(conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone())


def all_with_embeddings() -> list[dict]:
    """Факты вместе с векторами — для поиска по смыслу."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM memories ORDER BY id").fetchall()
    result = []
    for r in rows:
        item = _to_dict(r)
        item["vector"] = unpack_vector(r["embedding"]) if r["embedding"] else None
        result.append(item)
    return result


def save_embeddings(items: list[tuple[int, list[float]]], model: str) -> None:
    with get_conn() as conn:
        conn.executemany(
            "UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?",
            [(pack_vector(vec), model, mid) for mid, vec in items],
        )


def mark_used(memory_ids: list[int]) -> None:
    """Отмечает, что факты попали в контекст (счётчик виден на странице «Память»)."""
    if not memory_ids:
        return
    now = _now()
    with get_conn() as conn:
        conn.executemany(
            "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
            [(now, mid) for mid in memory_ids],
        )


# ---------- изменения (каждое пишется в журнал) ----------


def _log(conn, *, memory_id, action, old=None, new=None, category=None, source="auto",
         conversation_id=None, message_id=None) -> int:
    cur = conn.execute(
        """INSERT INTO memory_events
           (memory_id, action, old_content, new_content, category, source, conversation_id, message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (memory_id, action, old, new, category, source, conversation_id, message_id, _now()),
    )
    return cur.lastrowid


def add_memory(content: str, *, category: str | None = None, pinned: bool = False, source: str = "auto",
               conversation_id: str | None = None, message_id: int | None = None) -> tuple[dict, int]:
    """Добавляет факт. Возвращает (факт, id события в журнале)."""
    content, category = clean_content(content), clean_category(category)
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO memories (content, category, pinned, source, conversation_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (content, category, int(pinned), source, conversation_id, now, now),
        )
        event_id = _log(conn, memory_id=cur.lastrowid, action="add", new=content, category=category,
                        source=source, conversation_id=conversation_id, message_id=message_id)
    return get_memory(cur.lastrowid), event_id


def update_memory(memory_id: int, *, content: str | None = None, category: str | None = None,
                  pinned: bool | None = None, source: str = "manual",
                  conversation_id: str | None = None, message_id: int | None = None) -> tuple[dict | None, int | None]:
    """Меняет факт. В журнал пишется только изменение текста (закрепление — не событие)."""
    old = get_memory(memory_id)
    if old is None:
        return None, None
    fields, values = [], []
    new_content = clean_content(content) if content is not None else None
    if new_content is not None and new_content != old["content"]:
        # Текст поменялся — старый вектор смысла больше не подходит
        fields += ["content = ?", "embedding = NULL", "embedding_model = NULL"]
        values.append(new_content)
    if category is not None:
        fields.append("category = ?")
        values.append(clean_category(category))
    if pinned is not None:
        fields.append("pinned = ?")
        values.append(int(pinned))
    if not fields:
        return old, None
    event_id = None
    with get_conn() as conn:
        conn.execute(f"UPDATE memories SET {', '.join(fields)}, updated_at = ? WHERE id = ?",
                     (*values, _now(), memory_id))
        if new_content is not None and new_content != old["content"]:
            event_id = _log(conn, memory_id=memory_id, action="update", old=old["content"], new=new_content,
                            category=old["category"], source=source, conversation_id=conversation_id,
                            message_id=message_id)
    return get_memory(memory_id), event_id


def delete_memory(memory_id: int, *, source: str = "manual", conversation_id: str | None = None,
                  message_id: int | None = None) -> int | None:
    """Удаляет факт. Возвращает id события (None, если факта не было)."""
    old = get_memory(memory_id)
    if old is None:
        return None
    with get_conn() as conn:
        conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        return _log(conn, memory_id=memory_id, action="delete", old=old["content"], category=old["category"],
                    source=source, conversation_id=conversation_id, message_id=message_id)


def delete_all() -> int:
    """Стирает всю память и журнал. Возвращает число удалённых фактов."""
    with get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        conn.execute("DELETE FROM memories")
        conn.execute("DELETE FROM memory_events")
    return count


# ---------- журнал и отмена ----------


def list_events(*, conversation_id: str | None = None, limit: int = 50) -> list[dict]:
    sql = "SELECT * FROM memory_events"
    params: tuple = ()
    if conversation_id:
        sql += " WHERE conversation_id = ?"
        params = (conversation_id,)
    sql += " ORDER BY id DESC LIMIT ?"
    with get_conn() as conn:
        rows = conn.execute(sql, (*params, limit)).fetchall()
    return [{**dict(r), "undone": bool(r["undone"])} for r in rows]


def get_event(event_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM memory_events WHERE id = ?", (event_id,)).fetchone()
    return {**dict(row), "undone": bool(row["undone"])} if row else None


def undo_event(event_id: int) -> dict:
    """Отменяет изменение памяти:
    запомнил → удаляем факт; изменил → возвращаем старый текст; забыл → восстанавливаем факт.
    """
    event = get_event(event_id)
    if event is None:
        raise FactError("Событие не найдено")
    if event["undone"]:
        raise FactError("Это изменение уже отменено")

    now = _now()
    with get_conn() as conn:
        if event["action"] == "add":
            conn.execute("DELETE FROM memories WHERE id = ?", (event["memory_id"],))
        elif event["action"] == "update":
            exists = conn.execute("SELECT 1 FROM memories WHERE id = ?", (event["memory_id"],)).fetchone()
            if not exists:
                raise FactError("Факт уже удалён — отменять нечего")
            conn.execute(
                "UPDATE memories SET content = ?, embedding = NULL, embedding_model = NULL, updated_at = ? WHERE id = ?",
                (event["old_content"], now, event["memory_id"]),
            )
        elif event["action"] == "delete":
            cur = conn.execute(
                """INSERT INTO memories (content, category, source, conversation_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (event["old_content"], event["category"] or "другое", event["source"],
                 event["conversation_id"], now, now),
            )
            # Факт вернулся с новым id — обновляем ссылку, чтобы повторные действия работали
            conn.execute("UPDATE memory_events SET memory_id = ? WHERE id = ?", (cur.lastrowid, event_id))
        conn.execute("UPDATE memory_events SET undone = 1 WHERE id = ?", (event_id,))
    return get_event(event_id)
