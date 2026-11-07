"""
Конфигурация приложения.

Все настройки читаются из переменных окружения (можно положить их в файл .env
в корне проекта, см. .env.example). Если переменная не задана, берётся
значение по умолчанию, которое подходит для обычного запуска на своём ПК.

Настройки, которые пользователь меняет в интерфейсе (персоны, температура и т.п.),
сюда НЕ относятся: они появятся на этапе 2 и будут храниться в SQLite.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

# Корень проекта: папка, в которой лежат backend/ и frontend/
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Минимальный загрузчик .env: строки вида КЛЮЧ=значение.

    Свой вместо библиотеки python-dotenv, чтобы не тянуть лишнюю зависимость.
    Уже заданные переменные окружения НЕ перезаписываются.
    """
    if not path.exists():
        return
    # utf-8-sig: Блокнот в Windows любит дописывать в начало невидимый символ BOM,
    # из-за которого первая переменная в файле не распознаётся. Этот режим его отбрасывает.
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    # Имя ассистента: так он представляется и так подписан интерфейс
    assistant_name: str = field(default_factory=lambda: os.getenv("ASSISTANT_NAME", "Джарвис"))

    # Какой движок моделей использовать: "ollama" (основной) или "llamacpp"
    llm_backend: str = field(default_factory=lambda: os.getenv("LLM_BACKEND", "ollama"))

    # Адрес Ollama. По умолчанию Ollama слушает порт 11434.
    ollama_url: str = field(
        default_factory=lambda: os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
    )

    # Адрес llama.cpp сервера (llama-server), если выбран движок llamacpp
    llamacpp_url: str = field(
        default_factory=lambda: os.getenv("LLAMACPP_URL", "http://127.0.0.1:8080")
    )

    # Модель по умолчанию (если она скачана в Ollama)
    default_model: str = field(default_factory=lambda: os.getenv("DEFAULT_MODEL", "qwen3:8b"))

    # Размер контекста в токенах. 8192 — безопасно для 8 ГБ VRAM с моделью 8B.
    num_ctx: int = field(default_factory=lambda: int(os.getenv("NUM_CTX", "8192")))

    # Сколько держать модель в памяти после последнего запроса (формат Ollama)
    keep_alive: str = field(default_factory=lambda: os.getenv("KEEP_ALIVE", "30m"))

    # Папка с данными пользователя (база, векторы, датасет). Не попадает в git.
    data_dir: Path = field(
        default_factory=lambda: Path(os.getenv("DATA_DIR", str(PROJECT_ROOT / "data")))
    )

    # Где запускается наш веб-сервер. 127.0.0.1 = доступен только с этого ПК.
    host: str = field(default_factory=lambda: os.getenv("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8000")))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "assistant.db"


# Один общий объект настроек на всё приложение
settings = Settings()
