"""
Хранение диалогов и сообщений в SQLite («репозиторий» = слой доступа к данным).

Здесь только SQL-запросы, никакой логики HTTP или работы с моделью.
Все функции возвращают обычные словари, чтобы их было легко отдать в JSON.
"""

import json
import uuid
from datetime import datetime, timezone

from ..db import get_conn

DEFAULT_TITLE = "Новый чат"

# «Значение не передано». Нужно, чтобы отличать «не менять персону» от «сбросить персону (None)».
_UNSET = object()


def _now() -> str:
    # Время храним в UTC в формате ISO 8601 — так его корректно поймёт JavaScript
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _message_to_dict(row) -> dict:
    data = dict(row)
    data["stats"] = json.loads(data["stats"]) if data.get("stats") else None
    data["extras"] = json.loads(data["extras"]) if data.get("extras") else None
    data["stopped"] = bool(data["stopped"])
    return data


# ---------- диалоги ----------


def create_conversation(
    title: str = DEFAULT_TITLE, model: str | None = None, persona_id: int | None = None,
    kb_scope: str = "all",
) -> dict:
    conv_id = str(uuid.uuid4())
    now = _now()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, model, persona_id, kb_scope, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (conv_id, title, model, persona_id, kb_scope, now, now),
        )
    return get_conversation(conv_id)


def list_conversations() -> list[dict]:
    """Все диалоги, свежие сверху."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, title, model, persona_id, kb_scope, created_at, updated_at FROM conversations "
            "ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conv_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return dict(row) if row else None


def update_conversation(
    conv_id: str, *, title: str | None = None, model: str | None = None, persona_id=_UNSET,
    kb_scope: str | None = None,
) -> dict | None:
    """Меняет только переданные поля."""
    fields, values = [], []
    if kb_scope is not None:
        fields.append("kb_scope = ?")
        values.append(kb_scope)
    if persona_id is not _UNSET:
        fields.append("persona_id = ?")
        values.append(persona_id)
    if title is not None:
        fields.append("title = ?")
        values.append(title)
    if model is not None:
        fields.append("model = ?")
        values.append(model)
    fields.append("updated_at = ?")
    values.append(_now())
    with get_conn() as conn:
        conn.execute(f"UPDATE conversations SET {', '.join(fields)} WHERE id = ?", (*values, conv_id))
    return get_conversation(conv_id)


def delete_conversation(conv_id: str) -> bool:
    """Удаляет диалог вместе с сообщениями (ON DELETE CASCADE). True, если что-то удалили."""
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    return cur.rowcount > 0


# ---------- сообщения ----------


def list_messages(conv_id: str) -> list[dict]:
    """Сообщения диалога. К ответам добавляем оценку 👍/👎 и исправление из датасета."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT m.*, d.rating AS rating, d.corrected AS corrected
               FROM messages m LEFT JOIN dataset_examples d ON d.message_id = m.id
               WHERE m.conversation_id = ? ORDER BY m.id""",
            (conv_id,),
        ).fetchall()
    result = []
    for r in rows:
        item = _message_to_dict(r)
        item["rating"] = item.get("rating") or 0
        result.append(item)
    return result


def add_message(
    conv_id: str,
    role: str,
    content: str,
    *,
    thinking: str | None = None,
    model: str | None = None,
    stats: dict | None = None,
    stopped: bool = False,
    persona_id: int | None = None,
    extras: dict | None = None,
) -> dict:
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO messages
               (conversation_id, role, content, thinking, model, stats, stopped, persona_id, extras, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                conv_id,
                role,
                content,
                thinking or None,
                model,
                json.dumps(stats, ensure_ascii=False) if stats else None,
                int(stopped),
                persona_id,
                json.dumps(extras, ensure_ascii=False) if extras else None,
                now,
            ),
        )
        # Диалог с новым сообщением поднимается наверх списка
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id))
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _message_to_dict(row)


def delete_last_assistant_message(conv_id: str) -> bool:
    """Удаляет последний ответ ассистента, если диалог заканчивается им (для «Повторить»)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
            (conv_id,),
        ).fetchone()
        if row and row["role"] == "assistant":
            conn.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
            return True
    return False
