"""
Общий интерфейс «движка» языковой модели.

Зачем он нужен: остальной код (чат, память, RAG...) работает с абстрактным
LLMBackend и не знает, кто на самом деле отвечает — Ollama или llama.cpp.
Чтобы добавить новый движок, достаточно написать ещё один класс-наследник
с теми же методами. Это паттерн «адаптер».
"""

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import AsyncIterator, Literal

# Модели больше этого размера (в миллиардах параметров) не помещаются в 8 ГБ VRAM
# целиком, поэтому в интерфейсе помечаются как «медленно, частично на CPU».
LARGE_MODEL_THRESHOLD_B = 9.0


class LLMError(Exception):
    """Ошибка движка с понятным пользователю текстом (показывается в чате)."""


@dataclass
class ModelInfo:
    """Описание скачанной модели."""

    name: str  # имя, как его понимает движок, например "qwen3:8b"
    family: str | None = None  # семейство: qwen3, llama, bert...
    parameter_size: str | None = None  # как пишет движок: "8.2B"
    parameters_b: float | None = None  # то же числом: 8.2
    quantization: str | None = None  # например "Q4_K_M"
    size_bytes: int | None = None  # размер файла модели на диске
    capabilities: list[str] = field(default_factory=list)  # completion, tools, thinking, embedding, vision
    # Сколько байт видеопамяти занимает ОДИН токен контекста (KV-кэш в fp16).
    # Нужно для оценки VRAM в настройках. None — движок не сообщил устройство модели.
    kv_bytes_per_token: int | None = None

    @property
    def is_embedding(self) -> bool:
        """Модель эмбеддингов (bge-m3 и т.п.) — для чата не годится."""
        return "embedding" in self.capabilities and "completion" not in self.capabilities

    @property
    def supports_thinking(self) -> bool:
        return "thinking" in self.capabilities

    @property
    def supports_tools(self) -> bool:
        return "tools" in self.capabilities

    @property
    def supports_vision(self) -> bool:
        """Модель видит картинки (qwen3-vl, gemma3, llava…)."""
        return "vision" in self.capabilities

    @property
    def is_large(self) -> bool:
        return self.parameters_b is not None and self.parameters_b > LARGE_MODEL_THRESHOLD_B

    def to_dict(self) -> dict:
        data = asdict(self)
        data.update(
            is_embedding=self.is_embedding,
            supports_thinking=self.supports_thinking,
            supports_tools=self.supports_tools,
            supports_vision=self.supports_vision,
            is_large=self.is_large,
        )
        return data


@dataclass
class LoadedModel:
    """Модель, которая сейчас загружена в память (для индикатора VRAM)."""

    name: str
    size_bytes: int  # сколько всего памяти занимает модель
    vram_bytes: int  # сколько из этого лежит в видеопамяти
    context_length: int | None = None

    @property
    def gpu_percent(self) -> float:
        if self.size_bytes <= 0:
            return 0.0
        return round(min(self.vram_bytes / self.size_bytes, 1.0) * 100, 1)

    @property
    def fully_on_gpu(self) -> bool:
        # Небольшой допуск: Ollama иногда показывает size_vram на пару байт меньше size
        return self.gpu_percent >= 99.5

    def to_dict(self) -> dict:
        data = asdict(self)
        data.update(gpu_percent=self.gpu_percent, fully_on_gpu=self.fully_on_gpu)
        return data


@dataclass
class ChatChunk:
    """Кусочек потокового ответа.

    kind:
      "thinking" — фрагмент «размышлений» модели (показываем в свёрнутом блоке)
      "content"  — фрагмент самого ответа
      "tool_call" — модель просит вызвать инструмент (данные в tool_call)
      "done"     — генерация закончена, в stats лежит статистика
    """

    kind: Literal["thinking", "content", "tool_call", "done"]
    text: str = ""
    stats: dict | None = None
    # Для kind="tool_call": модель просит вызвать инструмент {"name": "calculator", "arguments": {...}}
    tool_call: dict | None = None


def normalize_tool_call(raw: dict) -> dict:
    """Приводит вызов инструмента к виду {"name": ..., "arguments": {...}}.

    Ollama присылает аргументы объектом, OpenAI-совместимые серверы — строкой JSON.
    """
    import json

    function = raw.get("function") or raw
    args = function.get("arguments") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except json.JSONDecodeError:
            args = {"_raw": args}  # модель прислала кривой JSON — покажем как есть
    return {"name": function.get("name", ""), "arguments": args if isinstance(args, dict) else {"value": args}}


def kv_bytes_per_token(model_info: dict) -> int | None:
    """Считает размер KV-кэша на один токен по описанию модели из Ollama (/api/show → model_info).

    Модель хранит для каждого прочитанного токена «ключ» и «значение» (K и V)
    в каждом слое. Размер = слои × KV-головы × (длина K + длина V) × 2 байта (fp16).
    Для Qwen3 8B: 36 × 8 × (128 + 128) × 2 = 147 456 байт ≈ 144 КиБ на токен.
    """
    arch = model_info.get("general.architecture")
    if not arch:
        return None
    get = lambda key: model_info.get(f"{arch}.{key}")  # noqa: E731
    blocks, kv_heads = get("block_count"), get("attention.head_count_kv")
    key_len, value_len = get("attention.key_length"), get("attention.value_length")
    if not key_len or not value_len:
        # Не у всех моделей указаны длины явно — тогда считаем «размер эмбеддинга / число голов»
        emb, heads = get("embedding_length"), get("attention.head_count")
        if emb and heads:
            key_len = value_len = emb // heads
    if not (blocks and kv_heads and key_len and value_len):
        return None
    return int(blocks * kv_heads * (key_len + value_len) * 2)


def parse_parameter_size(value: str | None) -> float | None:
    """Превращает строку вида "8.2B" или "567.75M" в миллиарды параметров (8.2, 0.57)."""
    if not value:
        return None
    value = value.strip().upper()
    multipliers = {"B": 1.0, "M": 0.001, "K": 0.000001}
    try:
        if value[-1] in multipliers:
            return round(float(value[:-1]) * multipliers[value[-1]], 3)
        return round(float(value) / 1e9, 3)  # просто число параметров
    except ValueError:
        return None


class LLMBackend(ABC):
    """Абстрактный движок. Все методы асинхронные, чтобы не блокировать сервер."""

    name: str = "base"

    @abstractmethod
    async def health(self) -> dict:
        """Проверка связи. Возвращает {"ok": bool, "version": str | None, "error": str | None}."""

    @abstractmethod
    async def list_models(self) -> list[ModelInfo]:
        """Список скачанных моделей."""

    @abstractmethod
    def chat_stream(
        self,
        model: str,
        messages: list[dict],
        *,
        think: bool | None = None,
        options: dict | None = None,
        format: dict | None = None,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[ChatChunk]:
        """Потоковая генерация ответа.

        messages — список {"role": "user"|"assistant"|"system", "content": "..."}.
        think    — включить «размышления» (только для моделей, которые это умеют).
        options  — параметры генерации: num_ctx, temperature и т.д.
        format   — JSON-схема: модель обязана ответить JSON-объектом такой структуры
                   (используется памятью, чтобы надёжно разбирать ответ программой).
        tools    — описания инструментов (калькулятор, поиск...). Если модель решит вызвать
                   инструмент, в потоке придёт ChatChunk(kind="tool_call").
        """

    async def complete(
        self,
        model: str,
        messages: list[dict],
        *,
        think: bool | None = None,
        options: dict | None = None,
        format: dict | None = None,
    ) -> str:
        """То же, что chat_stream, но возвращает весь ответ одной строкой (для служебных запросов)."""
        parts = []
        async for chunk in self.chat_stream(model, messages, think=think, options=options, format=format):
            if chunk.kind == "content":
                parts.append(chunk.text)
        return "".join(parts)

    async def embed(self, model: str, texts: list[str], *, on_gpu: bool = False) -> list[list[float]]:
        """Эмбеддинги — превращает тексты в векторы чисел, похожие по смыслу тексты дают близкие векторы.

        on_gpu=False — считать на процессоре, чтобы не отнимать видеопамять у основной модели.
        """
        raise LLMError("Этот движок не умеет считать эмбеддинги — используется поиск по словам.")

    async def loaded_models(self) -> list[LoadedModel] | None:
        """Какие модели сейчас в памяти. None = движок не умеет об этом сообщать."""
        return None

    async def pull(self, name: str):
        """Скачать модель: асинхронный генератор словарей прогресса {status, completed, total}."""
        raise LLMError("Этот движок не умеет скачивать модели — скачайте файл модели вручную.")
        yield {}  # pragma: no cover — делает функцию генератором

    async def unload_all(self) -> list[str]:
        """Освободить видеопамять от языковых моделей. По умолчанию движок этого не умеет."""
        return []

    async def close(self) -> None:
        """Освободить ресурсы (HTTP-соединения) при остановке сервера."""
