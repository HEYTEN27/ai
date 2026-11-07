"""
Работа с SQLite.

SQLite — это база данных в одном файле (data/assistant.db). Сервер не нужен,
модуль sqlite3 встроен в Python.

Схема базы меняется от этапа к этапу (появятся настройки, память, оценки...).
Чтобы старая база пользователя не ломалась, используем простые «миграции»:
список SQL-скриптов по порядку. В самой базе хранится номер последнего
применённого скрипта (PRAGMA user_version). При старте применяем недостающие.
Правило: старые миграции НИКОГДА не меняем, только добавляем новые в конец.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import settings

MIGRATIONS: list[str] = [
    # --- Миграция 1 (этап 1): диалоги и сообщения ---
    """
    CREATE TABLE conversations (
        id          TEXT PRIMARY KEY,          -- UUID диалога
        title       TEXT NOT NULL,
        model       TEXT,                      -- модель, выбранная в диалоге
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    CREATE TABLE messages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role             TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
        content          TEXT NOT NULL,
        thinking         TEXT,                 -- «размышления» модели (Qwen3), если были
        model            TEXT,                 -- какой моделью сгенерирован ответ
        stats            TEXT,                 -- JSON: токены, скорость и т.п.
        stopped          INTEGER NOT NULL DEFAULT 0,  -- 1 = генерацию остановили вручную
        created_at       TEXT NOT NULL
    );

    CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
    CREATE INDEX idx_conversations_updated ON conversations(updated_at);
    """,
]


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI выполняет обычные (не async) функции
    # в разных потоках, а соединение мы всё равно открываем на одну операцию.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row  # строки можно читать как словари: row["title"]
    conn.execute("PRAGMA foreign_keys = ON")  # иначе ON DELETE CASCADE не работает
    return conn


@contextmanager
def get_conn(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """Открывает соединение, а в конце сохраняет изменения (или откатывает при ошибке).

    Использование:
        with get_conn() as conn:
            conn.execute("INSERT ...")
    """
    conn = _connect(path or settings.db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(path: Path | None = None) -> None:
    """Создаёт базу (если её нет) и применяет новые миграции."""
    with get_conn(path) as conn:
        # WAL — режим журнала, при котором чтение не блокируется записью
        conn.execute("PRAGMA journal_mode = WAL")
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        for version, sql in enumerate(MIGRATIONS, start=1):
            if version > current:
                conn.executescript(sql)
                # PRAGMA не поддерживает параметры «?», но version — наше число, это безопасно
                conn.execute(f"PRAGMA user_version = {version}")
