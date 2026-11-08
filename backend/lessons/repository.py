"""
Хранение уроков в SQLite.

Урок — короткое правило, КАК отвечать этому пользователю: «Код пиши на TypeScript»,
«Объясняй короче, сначала главное». Факты памяти (этап 3) — о том, КТО пользователь;
уроки — о том, как ему отвечать. Оба вида подставляются в системный промпт.
"""

from datetime import datetime, timezone

from ..db import get_conn
from ..memory.retrieval import lexical_score, stems

MAX_CHARS = 300
SIMILAR = 0.6  # похожесть по корням слов, начиная с которой новый урок заменяет старый


class LessonError(ValueError):
    """Неверный текст урока (показывается пользователю)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _to_dict(row) -> dict:
    data = dict(row)
    data["enabled"] = bool(data["enabled"])
    return data


def clean(content: str) -> str:
    text = " ".join(str(content or "").split()).strip(" -•")
    if not text:
        raise LessonError("Пустой урок")
    if len(text) > MAX_CHARS:
        raise LessonError(f"Урок длиннее {MAX_CHARS} символов — сформулируйте короче")
    return text[0].upper() + text[1:]


def list_lessons() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM lessons ORDER BY updated_at DESC, id DESC").fetchall()
    return [_to_dict(r) for r in rows]


def enabled_lessons() -> list[dict]:
    return [lesson for lesson in list_lessons() if lesson["enabled"]]


def get_lesson(lesson_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
    return _to_dict(row) if row else None


def add_lesson(content: str, source: str, *, message_id: int | None = None,
               conversation_id: str | None = None) -> dict:
    content = clean(content)
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO lessons (content, source, message_id, conversation_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (content, source, message_id, conversation_id, now, now),
        )
    return get_lesson(cur.lastrowid)


def update_lesson(lesson_id: int, *, content: str | None = None, enabled: bool | None = None) -> dict | None:
    fields, values = [], []
    if content is not None:
        fields.append("content = ?")
        values.append(clean(content))
    if enabled is not None:
        fields.append("enabled = ?")
        values.append(int(enabled))
    if not fields:
        return get_lesson(lesson_id)
    fields.append("updated_at = ?")
    values.append(_now())
    with get_conn() as conn:
        conn.execute(f"UPDATE lessons SET {', '.join(fields)} WHERE id = ?", (*values, lesson_id))
    return get_lesson(lesson_id)


def delete_lesson(lesson_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM lessons WHERE id = ?", (lesson_id,))
    return cur.rowcount > 0


def find_similar(content: str) -> dict | None:
    """Самый похожий урок, если похожесть выше порога (тогда новый урок его заменит)."""
    if not stems(content):
        return None
    best = max(list_lessons(), key=lambda lesson: lexical_score(content, lesson["content"]), default=None)
    if best and lexical_score(content, best["content"]) >= SIMILAR:
        return best
    return None
