"""
Хранилище файлов: запись в таблице files + сам файл на диске в data/files/<id>/<имя>.

Два вида файлов:
  * upload — пользователь прикрепил к сообщению (храним извлечённый текст);
  * generated — Джарвис создал документ инструментом (храним исходник: markdown,
    слайды или листы — по нему строится предпросмотр и продолжается правка).

Пока сообщение не отправлено, вложение «висит» без message_id. Такие брошенные
вложения старше суток удаляются при запуске сервера.
"""

import json
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import settings
from ..db import get_conn

MAX_NAME_CHARS = 120
CONTEXT_FILES_LIMIT = 5  # сколько последних файлов диалога модель видит в контексте


def files_dir() -> Path:
    return settings.data_dir / "files"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_name(name: str, default: str = "файл") -> str:
    """Имя файла без путей и запрещённых в Windows символов: <>:"/\\|?* и управляющих."""
    name = Path(str(name).replace("\\", "/")).name
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    if not name:
        return default
    if len(name) > MAX_NAME_CHARS:
        stem, ext = Path(name).stem, Path(name).suffix[:10]
        name = stem[: MAX_NAME_CHARS - len(ext)].rstrip() + ext
    # Зарезервированные имена Windows (CON, NUL, COM1...) — файл с таким именем не сохранить
    if re.fullmatch(r"(con|prn|aux|nul|com\d|lpt\d)(\..*)?", name, re.IGNORECASE):
        name = "_" + name
    return name


def with_extension(name: str, ext: str) -> str:
    """«Отчёт» → «Отчёт.docx»; «отчёт.txt» → «отчёт.docx»."""
    name = safe_name(name, default="документ")
    stem = Path(name).stem if Path(name).suffix.lower() in (".docx", ".pptx", ".xlsx", ".txt", ".md", ".doc") else name
    return safe_name(f"{stem or 'документ'}{ext}")


def _to_dict(row, with_text: bool = False) -> dict:
    data = dict(row)
    data["meta"] = json.loads(data["meta"]) if data.get("meta") else {}
    if not with_text:
        data.pop("text", None)
    data["url"] = f"/api/files/{data['id']}/download"
    return data


def path_of(record: dict) -> Path:
    return files_dir() / record["id"] / record["name"]


def write_extra(record: dict, name: str, data: bytes) -> Path:
    """Дополнительный файл рядом с основным (уменьшенная копия картинки, страница скана)."""
    path = files_dir() / record["id"] / name
    path.write_bytes(data)
    return path


def create_file(
    *, kind: str, name: str, data: bytes, mime: str, conversation_id: str | None = None,
    text: str | None = None, meta: dict | None = None, project_id: int | None = None,
) -> dict:
    file_id = uuid.uuid4().hex
    name = safe_name(name)
    folder = files_dir() / file_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(data)
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO files (id, conversation_id, kind, name, mime, size, text, meta, created_at, project_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (file_id, conversation_id, kind, name, mime, len(data), text,
                 json.dumps(meta or {}, ensure_ascii=False), _now(), project_id),
            )
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)  # запись в базу не удалась — не оставляем мусор на диске
        raise
    return get_file(file_id)


def get_file(file_id: str, with_text: bool = False) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    return _to_dict(row, with_text) if row else None


def delete_file(file_id: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
    shutil.rmtree(files_dir() / file_id, ignore_errors=True)
    return cur.rowcount > 0


def attach_to_message(file_ids: list[str], conversation_id: str, message_id: int) -> None:
    with get_conn() as conn:
        conn.executemany(
            "UPDATE files SET conversation_id = ?, message_id = ? WHERE id = ?",
            [(conversation_id, message_id, fid) for fid in file_ids],
        )


def pending_uploads(file_ids: list[str], conversation_id: str) -> list[dict]:
    """Вложения, которые можно прикрепить к новому сообщению: загружены, ещё ни к чему не привязаны,
    и не из другого диалога. Порядок — как прислал браузер."""
    result = []
    for fid in dict.fromkeys(file_ids):
        record = get_file(fid)
        if (record is None or record["kind"] != "upload" or record["message_id"] is not None
                or record.get("project_id") is not None or record["conversation_id"] not in (None, conversation_id)):
            raise ValueError("Вложение не найдено или уже отправлено — прикрепите файл заново")
        result.append(record)
    return result


def files_for_context(conversation_id: str, limit: int = CONTEXT_FILES_LIMIT) -> list[dict]:
    """Файлы диалога, которые модель должна «видеть»: отправленные вложения и созданные документы.
    Свежие первыми — если файлов много, в контекст попадут последние."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM files WHERE conversation_id = ?
                 AND ((kind = 'upload' AND message_id IS NOT NULL) OR kind = 'generated')
               ORDER BY created_at DESC, rowid DESC LIMIT ?""",
            (conversation_id, limit),
        ).fetchall()
    return [_to_dict(r, with_text=True) for r in rows]


def vision_inputs(conversation_id: str, message_ids: list[int]) -> list[dict]:
    """Картинки (и сканы PDF) самого свежего сообщения из message_ids, где они есть.

    Так уточняющий вопрос («а что в правом углу?») всё ещё видит картинку, а старые
    картинки из начала диалога не съедают контекст."""
    if not message_ids:
        return []
    marks = ",".join("?" * len(message_ids))
    with get_conn() as conn:
        rows = conn.execute(
            f"""SELECT * FROM files WHERE conversation_id = ? AND kind = 'upload' AND message_id IN ({marks})
                ORDER BY message_id DESC, created_at, rowid""",
            (conversation_id, *message_ids),
        ).fetchall()
    records = [_to_dict(r) for r in rows if json.loads(r["meta"] or "{}").get("type") in ("image", "scan")]
    if not records:
        return []
    latest = records[0]["message_id"]
    return [r for r in records if r["message_id"] == latest]


def project_files(project_id: int, with_text: bool = True) -> list[dict]:
    """Файлы проекта (этап 15а): Джарвис учитывает их в каждом чате проекта."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM files WHERE project_id = ? ORDER BY created_at DESC, rowid DESC",
                            (project_id,)).fetchall()
    return [_to_dict(r, with_text) for r in rows]


def find_in_conversation(conversation_id: str, ref: str, extension: str) -> dict | None:
    """Файл диалога по id или имени (без учёта регистра и расширения) — для инструмента правки."""
    ref = str(ref or "").strip().lower()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM files WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC", (conversation_id,),
        ).fetchall()
    candidates = [_to_dict(r) for r in rows if r["name"].lower().endswith(extension)]
    for record in candidates:
        if ref in (record["id"], record["name"].lower(), Path(record["name"]).stem.lower()):
            return record
    # Модель могла написать имя чуть иначе — берём единственный подходящий или самый свежий по вхождению
    partial = [r for r in candidates if ref and (ref in r["name"].lower() or Path(r["name"]).stem.lower() in ref)]
    if partial:
        return partial[0]
    return candidates[0] if len(candidates) == 1 or not ref else None


def cleanup() -> int:
    """Удаляет брошенные вложения (старше суток, так и не отправленные) и папки без записи в базе."""
    removed = 0
    border = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
    with get_conn() as conn:
        stale = [r["id"] for r in conn.execute(
            "SELECT id FROM files WHERE kind = 'upload' AND message_id IS NULL AND project_id IS NULL AND created_at < ?",
            (border,))]
        known = {r["id"] for r in conn.execute("SELECT id FROM files")}
    for fid in stale:
        removed += delete_file(fid)
    root = files_dir()
    if root.is_dir():
        for folder in root.iterdir():
            # Папка без записи: диалог удалили (записи стёрлись каскадом) — убираем и файлы
            if folder.is_dir() and folder.name not in known:
                shutil.rmtree(folder, ignore_errors=True)
                removed += 1
    return removed


def total_size() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COALESCE(SUM(size), 0) FROM files").fetchone()[0]
