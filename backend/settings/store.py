"""
Глобальные настройки ассистента, которые меняются в интерфейсе.

Как устроено хранение. В коде (DEFAULTS) лежат значения по умолчанию,
а в таблице app_settings — только то, что пользователь изменил. Плюсы:
  * если в новой версии появится новая настройка, у старой базы она сразу
    получит значение по умолчанию — ничего мигрировать не надо;
  * «Сбросить» = просто удалить строку из таблицы.

Значения по умолчанию для имени, модели и контекста берутся из .env (config.py),
поэтому старая настройка ASSISTANT_NAME=... продолжает работать.
"""

import json

from ..config import settings as env
from ..db import get_conn

DEFAULT_SYSTEM_PROMPT = """\
Тебя зовут {name}. Ты — личный ИИ-ассистент пользователя и работаешь локально \
на его компьютере, поэтому всё, что он пишет, остаётся у него.

Ты помогаешь с учёбой, программированием, текстами и повседневными задачами.

Правила:
- Отвечай на языке пользователя (по умолчанию — на русском).
- Пиши по делу, без воды. Сложное объясняй простыми словами и на примерах.
- Код оформляй в markdown-блоках с указанием языка.
- Если не знаешь ответа или не уверен — честно скажи об этом, не выдумывай.
- Представляйся как {name}. Если спросят, на какой модели ты работаешь, \
честно ответь: на открытой модели {model}, запущенной локально.

Сегодня {date}."""

# Допустимые размеры контекста (шаги ползунка в интерфейсе)
CONTEXT_STEPS = [2048, 4096, 8192, 12288, 16384, 24576, 32768]

# Тип KV-кэша — как настроена Ollama (переменная OLLAMA_KV_CACHE_TYPE).
# Мы не можем прочитать её из Ollama, поэтому пользователь указывает её сам,
# а мы используем это только для оценки видеопамяти.
KV_CACHE_TYPES = ["f16", "q8_0", "q4_0"]


def defaults() -> dict:
    """Значения по умолчанию. Функция, а не константа: часть значений берётся из .env."""
    return {
        "assistant_name": env.assistant_name,
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
        "default_model": env.default_model,
        "default_persona_id": None,  # None = первая встроенная персона («Универсальный»)
        "num_ctx": env.num_ctx,
        "kv_cache_type": "f16",
        # Для оценки VRAM: сколько всего видеопамяти и сколько съедают другие программы.
        # 0.8 ГиБ — замер на ПК пользователя (Chrome, Telegram, Wallpaper Engine).
        "vram_total_gb": 8.0,
        "vram_reserved_gb": 0.8,
    }


class SettingsError(ValueError):
    """Недопустимое значение настройки (текст показывается пользователю)."""


def _validate(key: str, value):
    """Проверяет одно значение и возвращает его в нормальном виде."""
    if key == "assistant_name":
        value = str(value).strip()
        if not 1 <= len(value) <= 40:
            raise SettingsError("Имя ассистента: от 1 до 40 символов")
    elif key == "system_prompt":
        value = str(value)
        if len(value) > 20_000:
            raise SettingsError("Системный промпт слишком длинный (максимум 20 000 символов)")
    elif key == "default_model":
        value = str(value).strip()
        if not value:
            raise SettingsError("Модель по умолчанию не может быть пустой")
    elif key == "default_persona_id":
        value = None if value in (None, "") else int(value)
    elif key == "num_ctx":
        value = int(value)
        if not 2048 <= value <= 131072:
            raise SettingsError("Контекст: от 2048 до 131072 токенов")
    elif key == "kv_cache_type":
        if value not in KV_CACHE_TYPES:
            raise SettingsError(f"Тип KV-кэша: один из {', '.join(KV_CACHE_TYPES)}")
    elif key == "vram_total_gb":
        value = float(value)
        if not 1 <= value <= 128:
            raise SettingsError("Объём видеопамяти: от 1 до 128 ГиБ")
    elif key == "vram_reserved_gb":
        value = float(value)
        if not 0 <= value <= 16:
            raise SettingsError("Занято другими программами: от 0 до 16 ГиБ")
    else:
        raise SettingsError(f"Неизвестная настройка: {key}")
    return value


def get_all() -> dict:
    """Все настройки: значения по умолчанию, поверх них — сохранённые пользователем."""
    result = defaults()
    with get_conn() as conn:
        for row in conn.execute("SELECT key, value FROM app_settings"):
            if row["key"] in result:  # устаревшие ключи просто игнорируем
                result[row["key"]] = json.loads(row["value"])
    return result


def get(key: str):
    return get_all()[key]


def update(changes: dict) -> dict:
    """Сохраняет изменения. Если значение совпадает с умолчанием — удаляет строку (= сброс)."""
    clean = {key: _validate(key, value) for key, value in changes.items()}
    base = defaults()
    with get_conn() as conn:
        for key, value in clean.items():
            if value == base[key]:
                conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
            else:
                conn.execute(
                    "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, json.dumps(value, ensure_ascii=False)),
                )
    return get_all()


def reset(keys: list[str] | None = None) -> dict:
    """Сбрасывает указанные настройки (или все) к значениям по умолчанию."""
    with get_conn() as conn:
        if keys is None:
            conn.execute("DELETE FROM app_settings")
        else:
            conn.executemany("DELETE FROM app_settings WHERE key = ?", [(k,) for k in keys])
    return get_all()
