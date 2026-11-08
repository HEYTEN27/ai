"""
Точка входа веб-сервера.

Собирает приложение FastAPI из модулей-роутеров и раздаёт файлы интерфейса
из папки frontend/. Каждый новый модуль (память, RAG, инструменты...)
подключается здесь одной строкой app.include_router(...).

Запуск:  python -m backend      (или uvicorn backend.main:app --reload для разработки)
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .chat.router import router as chat_router
from .config import PROJECT_ROOT
from .dataset.router import router as dataset_router
from .db import init_db
from .knowledge.indexer import indexer
from .knowledge.router import router as knowledge_router
from .llm import get_backend
from .memory.router import router as memory_router
from .tools.router import router as tools_router
from .training.router import router as training_router
from .export.router import router as export_router
from .files import store as files_store
from .files.router import router as files_router
from .voice.router import router as voice_router
from .settings.personas import ensure_builtin as ensure_builtin_personas
from .settings.router import router as settings_router
from .system.router import router as system_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- при старте сервера ---
    init_db()
    ensure_builtin_personas()  # учитель, программист, редактор... — если их ещё нет в базе
    indexer.start()  # фоновая очередь индексации документов базы знаний
    files_store.cleanup()  # брошенные вложения и файлы удалённых диалогов
    yield
    # --- при остановке сервера ---
    await indexer.stop()
    await get_backend().close()


app = FastAPI(title="Локальный ИИ-ассистент", lifespan=lifespan)

app.include_router(system_router)
app.include_router(chat_router)
app.include_router(settings_router)
app.include_router(memory_router)
app.include_router(knowledge_router)
app.include_router(tools_router)
app.include_router(dataset_router)
app.include_router(training_router)
app.include_router(voice_router)
app.include_router(export_router)
app.include_router(files_router)

# Статика монтируется ПОСЛЕДНЕЙ: всё, что не /api/..., отдаётся как файлы интерфейса.
# html=True — по адресу "/" отдаётся index.html.
app.mount("/", StaticFiles(directory=PROJECT_ROOT / "frontend", html=True), name="frontend")
