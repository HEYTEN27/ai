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
from .db import init_db
from .llm import get_backend
from .system.router import router as system_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- при старте сервера ---
    init_db()
    yield
    # --- при остановке сервера ---
    await get_backend().close()


app = FastAPI(title="Локальный ИИ-ассистент", lifespan=lifespan)

app.include_router(system_router)
app.include_router(chat_router)

# Статика монтируется ПОСЛЕДНЕЙ: всё, что не /api/..., отдаётся как файлы интерфейса.
# html=True — по адресу "/" отдаётся index.html.
app.mount("/", StaticFiles(directory=PROJECT_ROOT / "frontend", html=True), name="frontend")
