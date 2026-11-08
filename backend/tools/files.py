"""
Чтение файлов из выбранной пользователем папки.

Главное правило безопасности: модель может читать ТОЛЬКО внутри выбранной папки.
Путь, который прислала модель, мы превращаем в абсолютный (resolve раскрывает «..»
и символические ссылки) и проверяем, что он всё ещё внутри папки. Поэтому
«../../Windows/System32» или ссылка-ярлык, ведущая наружу, не сработают.

Плюс каждое чтение пользователь подтверждает в интерфейсе (см. registry.py).
"""

from pathlib import Path

from ..knowledge.parsers import ParseError, decode_text, file_type, parse_file

MAX_READ_CHARS = 12_000  # больше модели всё равно не прочитать с контекстом 8K
MAX_LIST_ENTRIES = 200
MAX_FILE_BYTES = 20 * 1024 * 1024
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".obsidian", ".idea", ".vscode"}


class FileToolError(Exception):
    pass


def root_path(files_root: str) -> Path:
    if not files_root:
        raise FileToolError("Папка для чтения файлов не выбрана (Настройки → Инструменты)")
    root = Path(files_root).expanduser()
    if not root.is_dir():
        raise FileToolError(f"Папка не найдена: {root}")
    return root.resolve()


def safe_path(files_root: str, relative: str) -> Path:
    """Путь внутри разрешённой папки или исключение."""
    root = root_path(files_root)
    relative = (relative or ".").strip().strip('"').replace("\\", "/")
    candidate = Path(relative)
    target = (candidate if candidate.is_absolute() else root / candidate).resolve()
    if target != root and not target.is_relative_to(root):
        raise FileToolError("Доступ запрещён: путь ведёт за пределы разрешённой папки")
    return target


def list_files(files_root: str, path: str = ".", recursive: bool = False) -> dict:
    root = root_path(files_root)
    target = safe_path(files_root, path)
    if not target.is_dir():
        raise FileToolError(f"Это не папка: {path}")
    entries, truncated = [], False
    iterator = target.rglob("*") if recursive else target.iterdir()
    for item in sorted(iterator, key=lambda p: (not p.is_dir(), str(p).lower())):
        rel = item.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if len(entries) >= MAX_LIST_ENTRIES:
            truncated = True
            break
        is_dir = item.is_dir()
        entries.append({"path": rel.as_posix() + ("/" if is_dir else ""), "type": "dir" if is_dir else "file",
                        "size": None if is_dir else item.stat().st_size})
    return {"path": target.relative_to(root).as_posix() or ".", "entries": entries, "truncated": truncated}


def read_file(files_root: str, path: str) -> dict:
    root = root_path(files_root)
    target = safe_path(files_root, path)
    if not target.is_file():
        raise FileToolError(f"Файл не найден: {path}")
    size = target.stat().st_size
    if size > MAX_FILE_BYTES:
        raise FileToolError("Файл больше 20 МБ — слишком большой для чтения целиком")

    if file_type(target) in ("pdf", "docx"):  # переиспользуем парсеры базы знаний
        try:
            doc = parse_file(target)
        except ParseError as e:
            raise FileToolError(str(e)) from e
        text = "\n\n".join((f"[стр. {b.page}] " if b.page else "") + b.text for b in doc.blocks)
    else:
        raw = target.read_bytes()
        if b"\x00" in raw[:8192]:
            raise FileToolError("Это двоичный файл (картинка, программа, архив) — прочитать его как текст нельзя")
        text = decode_text(raw)

    truncated = len(text) > MAX_READ_CHARS
    return {"path": target.relative_to(root).as_posix(), "size": size, "chars": len(text),
            "truncated": truncated, "content": text[:MAX_READ_CHARS]}
