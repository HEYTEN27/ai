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
    kb_scope: str = "all", project_id: int | None = None, style: str = "normal",
) -> dict:
    conv_id = str(uuid.uuid4())
    now = _now()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, model, persona_id, kb_scope, project_id, style, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (conv_id, title, model, persona_id, kb_scope, project_id, style, now, now),
        )
    return get_conversation(conv_id)


def list_conversations() -> list[dict]:
    """Все диалоги, свежие сверху."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, title, model, persona_id, kb_scope, project_id, style, created_at, updated_at FROM conversations "
            "ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conv_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return dict(row) if row else None


def update_conversation(
    conv_id: str, *, title: str | None = None, model: str | None = None, persona_id=_UNSET,
    kb_scope: str | None = None, project_id=_UNSET, style: str | None = None,
) -> dict | None:
    """Меняет только переданные поля."""
    fields, values = [], []
    if project_id is not _UNSET:
        fields.append("project_id = ?")
        values.append(project_id)
    if style is not None:
        fields.append("style = ?")
        values.append(style)
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


def list_messages(conv_id: str, leaf_id: int | None = None) -> list[dict]:
    """Сообщения АКТИВНОЙ ВЕТКИ диалога (или ветки, заканчивающейся на leaf_id).

    Ветки (этап 15а): у сообщения есть родитель — предыдущее сообщение. Если вопрос
    исправили, у его родителя два «ребёнка» — две ветки. Путь строим от последнего
    сообщения ветки к началу. У сообщений с «братьями» добавляем branch: {index, count, ids}
    — для переключателя «‹ 1/2 ›». К ответам добавляем оценку 👍/👎 и исправление из датасета.
    """
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT m.*, d.rating AS rating, d.corrected AS corrected
               FROM messages m LEFT JOIN dataset_examples d ON d.message_id = m.id
               WHERE m.conversation_id = ? ORDER BY m.id""",
            (conv_id,),
        ).fetchall()
        conv = conn.execute("SELECT leaf_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    if not rows:
        return []
    by_id = {}
    for r in rows:
        item = _message_to_dict(r)
        item["rating"] = item.get("rating") or 0
        by_id[item["id"]] = item
    leaf = leaf_id if leaf_id in by_id else (conv["leaf_id"] if conv and conv["leaf_id"] in by_id else max(by_id))
    path, seen = [], set()
    while leaf in by_id and leaf not in seen:  # seen — защита от зацикливания в повреждённой базе
        seen.add(leaf)
        path.append(by_id[leaf])
        leaf = by_id[leaf]["parent_id"]
    path.reverse()
    # «Братья» — сообщения того же автора с тем же родителем (разные версии вопроса)
    children: dict = {}
    for item in by_id.values():
        children.setdefault((item["parent_id"], item["role"]), []).append(item["id"])
    for item in path:
        ids = children[(item["parent_id"], item["role"])]
        if len(ids) > 1:
            item["branch"] = {"index": ids.index(item["id"]) + 1, "count": len(ids), "ids": ids}
    return path


def current_leaf(conv_id: str) -> int | None:
    """Последнее сообщение активной ветки."""
    path = list_messages(conv_id)
    return path[-1]["id"] if path else None


def set_leaf(conv_id: str, message_id: int) -> int:
    """Сделать активной ветку, в которой есть message_id: идём вниз по самым свежим «детям»."""
    with get_conn() as conn:
        leaf = message_id
        while True:
            child = conn.execute("SELECT MAX(id) FROM messages WHERE parent_id = ? AND conversation_id = ?",
                                 (leaf, conv_id)).fetchone()[0]
            if child is None:
                break
            leaf = child
        conn.execute("UPDATE conversations SET leaf_id = ? WHERE id = ?", (leaf, conv_id))
    return leaf


def get_message(message_id: int) -> dict | None:
    """Одно сообщение (с исправлением из датасета, если есть)."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT m.*, d.rating AS rating, d.corrected AS corrected
               FROM messages m LEFT JOIN dataset_examples d ON d.message_id = m.id WHERE m.id = ?""",
            (message_id,),
        ).fetchone()
    return _message_to_dict(row) if row else None


def update_extras(message_id: int, extras: dict) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE messages SET extras = ? WHERE id = ?",
                     (json.dumps(extras, ensure_ascii=False) if extras else None, message_id))


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
    parent_id=_UNSET,
) -> dict:
    """Добавляет сообщение в конец активной ветки (или после parent_id — так появляется новая ветка)."""
    now = _now()
    if parent_id is _UNSET:
        parent_id = current_leaf(conv_id)
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO messages
               (conversation_id, role, content, thinking, model, stats, stopped, persona_id, extras, created_at, parent_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                parent_id,
            ),
        )
        # Диалог с новым сообщением поднимается наверх списка; новое сообщение — конец активной ветки
        conn.execute("UPDATE conversations SET updated_at = ?, leaf_id = ? WHERE id = ?", (now, cur.lastrowid, conv_id))
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _message_to_dict(row)


def delete_last_assistant_message(conv_id: str) -> bool:
    """Удаляет последний ответ активной ветки, если ветка заканчивается им (для «Повторить»)."""
    path = list_messages(conv_id)
    if not path or path[-1]["role"] != "assistant":
        return False
    last = path[-1]
    with get_conn() as conn:
        conn.execute("DELETE FROM messages WHERE id = ?", (last["id"],))
        conn.execute("UPDATE conversations SET leaf_id = ? WHERE id = ?", (last["parent_id"], conv_id))
    return True
