"""
Общие настройки тестов (pytest подхватывает этот файл автоматически).

Тесты работают с временной базой и с эмулятором Ollama, поэтому
ни настоящая модель, ни видеокарта, ни ваши данные для них не нужны.
"""

import json
import os
import tempfile
from pathlib import Path

# Важно: переменные окружения задаём ДО импорта backend, чтобы настройки их подхватили
_TMP = tempfile.mkdtemp(prefix="assistant-tests-")
os.environ["DATA_DIR"] = _TMP
os.environ["FAKE_DELAY"] = "0"
os.environ["IMAGE_ENGINE"] = "fake"  # рисование — заглушкой (без видеокарты и PyTorch)
os.environ["FAKE_IMAGE_STEP"] = "0.002"

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.config import settings  # noqa: E402
from backend.llm import set_backend  # noqa: E402
from backend.llm.ollama import OllamaBackend  # noqa: E402
from tests import fake_ollama  # noqa: E402


@pytest.fixture
def fresh_db():
    """Каждый тест начинается с пустой базы."""
    for suffix in ("", "-wal", "-shm"):
        Path(str(settings.db_path) + suffix).unlink(missing_ok=True)
    yield settings.db_path


@pytest.fixture
def client(fresh_db):
    """HTTP-клиент к нашему приложению, подключённому к эмулятору Ollama."""
    from backend.main import app

    fake_ollama.reset_state()
    fake_ollama.remove_created_models()  # модели, «подключённые» в прошлых тестах
    set_backend(OllamaBackend("http://fake-ollama", transport=httpx.ASGITransport(app=fake_ollama.app)))
    with TestClient(app) as c:
        yield c
    set_backend(None)


def parse_sse(text: str) -> list[tuple[str, dict]]:
    """Разбирает поток SSE в список (событие, данные)."""
    events = []
    for block in text.strip().split("\n\n"):
        event, data = "message", None
        for line in block.splitlines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:].strip())
        if data is not None:
            events.append((event, data))
    return events
