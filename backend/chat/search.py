"""
Поиск по всем диалогам (этап 15а): GET /api/search?q=…

Ищем полнотекстовым индексом SQLite FTS5 (таблица messages_fts, обновляется триггерами
при каждом новом сообщении). Каждое слово запроса ищется по началу («замык*» найдёт
«замыкание», «замыкания»), все слова должны встретиться в сообщении. Отдельно ищем
по названиям диалогов.
"""

import re

from fastapi import APIRouter

from ..db import get_conn

router = APIRouter(prefix="/api/search", tags=["search"])

MARK_START, MARK_END = "\u0001", "\u0002"  # метки подсветки — интерфейс превращает их в <mark>


def fts_query(text: str) -> str | None:
    words = [w for w in re.findall(r"[\wёЁ]+", text.lower()) if len(w) >= 2][:8]
    if not words:
        return None
    # Слово в кавычках + звёздочка = «начинается с»; кавычки защищают от операторов FTS (AND, NEAR…)
    return " ".join(f'"{w}"*' for w in words)


@router.get("")
def search(q: str, limit: int = 30):
    query = fts_query(q)
    if not query:
        return {"query": q, "messages": [], "conversations": []}
    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT m.id AS message_id, m.conversation_id, m.role, m.created_at, c.title,
                       snippet(messages_fts, 0, '{MARK_START}', '{MARK_END}', '…', 14) AS snippet
                FROM messages_fts
                JOIN messages m ON m.id = messages_fts.rowid
                JOIN conversations c ON c.id = m.conversation_id
                WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?""",
            (query, max(1, min(100, limit))),
        ).fetchall()
        titles = conn.execute("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC").fetchall()
    needle = q.strip().lower().replace("ё", "е")
    conversations = [dict(t) for t in titles if needle and needle in t["title"].lower().replace("ё", "е")][:10]
    return {"query": q, "messages": [dict(r) for r in rows], "conversations": conversations}
