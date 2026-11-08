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
    # --- Миграция 2 (этап 2): настройки и персоны ---
    """
    -- Настройки «ключ → значение». Значение хранится как JSON, поэтому подходит
    -- для чисел, строк и списков. Храним только то, что пользователь изменил,
    -- остальное берётся из значений по умолчанию в коде.
    CREATE TABLE app_settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );

    -- Персоны: роль (дополнение к системному промпту) + параметры генерации
    CREATE TABLE personas (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        slug            TEXT UNIQUE,          -- код встроенной персоны ("teacher"), у своих — NULL
        name            TEXT NOT NULL,
        icon            TEXT NOT NULL DEFAULT '🤖',
        description     TEXT NOT NULL DEFAULT '',
        prompt          TEXT NOT NULL DEFAULT '',  -- добавляется к общему системному промпту
        temperature     REAL NOT NULL,
        top_p           REAL NOT NULL,
        top_k           INTEGER NOT NULL,
        repeat_penalty  REAL NOT NULL,
        num_predict     INTEGER NOT NULL DEFAULT 0,  -- макс. длина ответа в токенах, 0 = без лимита
        builtin         INTEGER NOT NULL DEFAULT 0,
        sort_order      INTEGER NOT NULL DEFAULT 100,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );

    -- Какая персона выбрана в диалоге и какой персоной написан каждый ответ.
    -- Если персону удалят, в диалоге будет NULL и включится персона по умолчанию.
    ALTER TABLE conversations ADD COLUMN persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL;
    ALTER TABLE messages ADD COLUMN persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL;
    """,
    # --- Миграция 3 (этап 3): долговременная память ---
    """
    -- Факты о пользователе. Память — про человека, а не про диалог, поэтому
    -- при удалении диалога факты остаются (conversation_id становится NULL).
    CREATE TABLE memories (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        content          TEXT NOT NULL,             -- «Учится на 3 курсе»
        category         TEXT NOT NULL DEFAULT 'другое',
        pinned           INTEGER NOT NULL DEFAULT 0,  -- 1 = подставлять в контекст всегда
        source           TEXT NOT NULL DEFAULT 'auto',  -- auto (запомнил сам) | manual (добавлен вручную)
        conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        embedding        BLOB,                      -- вектор смысла (float32), считается лениво
        embedding_model  TEXT,                      -- какой моделью посчитан вектор
        use_count        INTEGER NOT NULL DEFAULT 0,  -- сколько раз факт попал в контекст
        last_used_at     TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
    );

    -- Журнал изменений памяти: что запомнено, изменено, забыто. Нужен, чтобы
    -- показать это в чате и дать кнопку «Отменить».
    CREATE TABLE memory_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id        INTEGER,                   -- без внешнего ключа: факт может быть уже удалён
        action           TEXT NOT NULL CHECK (action IN ('add', 'update', 'delete')),
        old_content      TEXT,
        new_content      TEXT,
        category         TEXT,
        source           TEXT NOT NULL DEFAULT 'auto',  -- auto | manual
        conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        message_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        undone           INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
    );
    CREATE INDEX idx_memory_events_conv ON memory_events(conversation_id);

    -- Доп. сведения об ответе (JSON): какие факты из памяти были в контексте,
    -- позже — какие документы использовались (этап 4)
    ALTER TABLE messages ADD COLUMN extras TEXT;
    """,
    # --- Миграция 4 (этап 4): база знаний (RAG) ---
    """
    -- Коллекции: «Мои файлы» (загруженные), «Obsidian» (подключённая папка) и т.п.
    CREATE TABLE kb_collections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('upload', 'folder')),
        path        TEXT,                 -- для папки: путь на диске
        synced_at   TEXT,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE kb_documents (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id  INTEGER NOT NULL REFERENCES kb_collections(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        rel_path       TEXT NOT NULL,     -- имя файла или путь внутри папки
        file_path      TEXT NOT NULL,     -- где лежит оригинал (для «Открыть документ»)
        file_type      TEXT NOT NULL,     -- pdf | docx | txt | md
        size_bytes     INTEGER NOT NULL DEFAULT 0,
        mtime          REAL,              -- время изменения файла — чтобы синхронизация видела правки
        sha256         TEXT,
        status         TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'indexing', 'ready', 'error')),
        error          TEXT,
        progress       INTEGER NOT NULL DEFAULT 0,   -- сколько фрагментов уже обработано
        chunk_count    INTEGER NOT NULL DEFAULT 0,
        page_count     INTEGER,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (collection_id, rel_path)
    );

    -- Фрагменты документов. Вектор смысла — float32, нормированный (длина 1),
    -- поэтому близость считается простым скалярным произведением.
    CREATE TABLE kb_chunks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id      INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        ord              INTEGER NOT NULL,      -- номер фрагмента в документе
        text             TEXT NOT NULL,
        section          TEXT,                  -- «Глава 2 › Замыкания»
        page_start       INTEGER,
        page_end         INTEGER,
        embedding        BLOB,
        embedding_model  TEXT
    );
    CREATE INDEX idx_kb_chunks_doc ON kb_chunks(document_id, ord);

    -- Полнотекстовый индекс SQLite (FTS5) для поиска по словам. rowid = id фрагмента.
    CREATE VIRTUAL TABLE kb_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');

    -- Какую часть базы знаний использовать в диалоге: all | off | <id коллекции>
    ALTER TABLE conversations ADD COLUMN kb_scope TEXT NOT NULL DEFAULT 'all';
    """,
    # --- Миграция 5 (этап 6): датасет для дообучения ---
    """
    -- Пример для обучения — СНИМОК: системный промпт, предыдущие сообщения, вопрос, ответ.
    -- Снимок не зависит от диалога: удалите диалог — пример останется в датасете.
    CREATE TABLE dataset_examples (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id       INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,  -- ответ в чате
        conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        rating           INTEGER NOT NULL DEFAULT 0 CHECK (rating IN (-1, 0, 1)),  -- 👎 / нет / 👍
        system_prompt    TEXT NOT NULL DEFAULT '',
        history          TEXT NOT NULL DEFAULT '[]',  -- JSON: предыдущие сообщения [{role, content}]
        question         TEXT NOT NULL,               -- вопрос (с фрагментами базы знаний, если были)
        answer           TEXT NOT NULL,               -- исходный ответ модели
        corrected        TEXT,                        -- ответ, исправленный пользователем
        used_tools       INTEGER NOT NULL DEFAULT 0,  -- в ответе участвовали инструменты
        strip_citations  INTEGER NOT NULL DEFAULT 0,  -- ссылки [1] вести некуда — вырезать при экспорте
        included         INTEGER NOT NULL DEFAULT 1,  -- пользователь может исключить пример вручную
        model            TEXT,
        persona          TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_dataset_rating ON dataset_examples(rating);
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
