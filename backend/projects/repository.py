"""
Хранение проектов.

Проект — как папка в Claude/ChatGPT: «Курсовая по БД», «Подготовка к сессии». У проекта
есть инструкции (добавляются к системному промпту во всех его чатах) и файлы (Джарвис
учитывает их в каждом чате проекта — так же, как вложения, целиком или выдержками).
"""

from datetime import datetime, timezone

from ..db import get_conn

MAX_NAME = 80
MAX_INSTRUCTIONS = 4000


class ProjectError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _check(name: str | None, instructions: str | None) -> None:
    if name is not None and not 1 <= len(name.strip()) <= MAX_NAME:
        raise ProjectError(f"Название проекта: от 1 до {MAX_NAME} символов")
    if instructions is not None and len(instructions) > MAX_INSTRUCTIONS:
        raise ProjectError(f"Инструкции проекта — не длиннее {MAX_INSTRUCTIONS} символов (они занимают контекст)")


def list_projects() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT p.*,
                      (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS chats,
                      (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS files
               FROM projects p ORDER BY p.updated_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def get_project(project_id: int | None) -> dict | None:
    if project_id is None:
        return None
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return dict(row) if row else None


def create_project(name: str, icon: str = "📁", instructions: str = "") -> dict:
    _check(name, instructions)
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO projects (name, icon, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (name.strip(), (icon or "📁")[:4], instructions.strip(), now, now),
        )
    return get_project(cur.lastrowid)


def update_project(project_id: int, *, name: str | None = None, icon: str | None = None,
                   instructions: str | None = None) -> dict | None:
    _check(name, instructions)
    fields, values = [], []
    for column, value in (("name", name and name.strip()), ("icon", icon and icon[:4]),
                          ("instructions", instructions if instructions is None else instructions.strip())):
        if value is not None:
            fields.append(f"{column} = ?")
            values.append(value)
    fields.append("updated_at = ?")
    values.append(_now())
    with get_conn() as conn:
        conn.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", (*values, project_id))
    return get_project(project_id)


def touch(project_id: int) -> None:
    """Проект поднимается вверх списка, когда в нём что-то происходит."""
    with get_conn() as conn:
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (_now(), project_id))


def delete_project(project_id: int) -> bool:
    """Чаты проекта остаются (просто без проекта), файлы проекта удаляются."""
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    return cur.rowcount > 0


def project_conversations(project_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, title, model, updated_at FROM conversations WHERE project_id = ? ORDER BY updated_at DESC",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def format_for_prompt(project: dict | None) -> str:
    if not project:
        return ""
    text = f"Этот чат — в проекте «{project['name']}»."
    if project["instructions"].strip():
        text += f" Инструкции проекта (соблюдай их):\n{project['instructions'].strip()}"
    return text
