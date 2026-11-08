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
from pathlib import Path

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
        # --- Память (этап 3) ---
        "memory_enabled": True,  # подставлять факты о пользователе в контекст
        "memory_autosave": True,  # запоминать новые факты автоматически после ответов
        "memory_budget_tokens": 400,  # сколько контекста можно отдать под факты (~25 коротких фактов)
        # Модель эмбеддингов для поиска по смыслу (память, позже — база знаний).
        # Считается на CPU, чтобы не отнимать видеопамять у основной модели.
        "embedding_model": "bge-m3",
        # --- База знаний (этап 4) ---
        "rag_top_k": 6,  # сколько фрагментов подставлять в ответ (максимум)
        "rag_budget_tokens": 2500,  # сколько контекста можно отдать под фрагменты
        "rag_min_score": 0.45,  # порог похожести по смыслу: ниже — фрагмент считается нерелевантным
        "chunk_size": 1200,  # размер фрагмента в символах (~400 токенов)
        "chunk_overlap": 200,  # перекрытие соседних фрагментов, чтобы мысль не обрывалась на границе
        # Считать эмбеддинги документов на видеокарте: в разы быстрее, но на время
        # индексации Ollama выгрузит основную модель из видеопамяти.
        "embedding_on_gpu": False,
        # --- Инструменты (этап 5) ---
        "tools_enabled": True,  # главный выключатель
        "tool_calculator": True,
        "tool_web": True,  # поиск и чтение страниц — единственное, что выходит в интернет
        "tool_files": True,  # работает, только когда выбрана папка files_root
        "tool_python": True,
        "lessons_enabled": True,  # учиться на исправлениях и 👎: правила в системном промпте (этап 11)
        "auto_think": True,  # на сложных вопросах «размышления» включаются сами
        "auto_check_code": False,  # сам запускать Python-код из ответа в песочнице (проверка)
        "artifacts_enabled": True,  # игры, страницы, схемы в панели рядом с чатом (этап 10)
        "tool_documents": True,  # создание Word, PowerPoint, Excel (файлы остаются внутри приложения)
        "files_root": "",  # папка, из которой модели можно читать файлы (с подтверждением)
        "python_timeout": 10,  # секунд на выполнение кода
        "confirm_python": True,  # спрашивать перед запуском кода
        "confirm_web": False,  # спрашивать перед поиском / открытием страницы
        "web_provider": "duckduckgo",  # duckduckgo | searxng
        "searxng_url": "",
        # --- Голосовой ввод (этап 8) ---
        "voice_enabled": True,
        "whisper_model": "small",  # tiny | base | small | medium
        "voice_language": "ru",  # ru | en | auto (определять самостоятельно)
        # --- Оформление и «характер» ---
        "ui_theme": "hud",  # hud — голографический интерфейс, classic — простая тёмная тема
        "address": "сэр",  # как ассистент обращается к пользователю (подстановка {address})
        "tts_enabled": True,  # озвучивать ответы встроенным голосом Windows (офлайн)
        "tts_voice": "",  # имя голоса; пусто — выбрать русский мужской автоматически
        "tts_rate": 1.0,  # скорость речи
        "ui_sounds": True,  # тихие звуки интерфейса
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
    elif key in ("memory_enabled", "memory_autosave", "embedding_on_gpu", "tools_enabled", "tool_calculator",
                 "tool_web", "tool_files", "tool_python", "tool_documents", "artifacts_enabled", "lessons_enabled", "auto_think", "auto_check_code", "confirm_python", "confirm_web", "voice_enabled",
                 "tts_enabled", "ui_sounds"):
        if not isinstance(value, bool):
            raise SettingsError("Ожидается да/нет (true/false)")
    elif key == "memory_budget_tokens":
        value = int(value)
        if not 50 <= value <= 4000:
            raise SettingsError("Бюджет памяти: от 50 до 4000 токенов")
    elif key == "rag_top_k":
        value = int(value)
        if not 1 <= value <= 20:
            raise SettingsError("Фрагментов в ответе: от 1 до 20")
    elif key == "rag_budget_tokens":
        value = int(value)
        if not 300 <= value <= 30000:
            raise SettingsError("Место под фрагменты: от 300 до 30000 токенов")
    elif key == "rag_min_score":
        value = float(value)
        if not 0 <= value <= 1:
            raise SettingsError("Порог похожести: от 0 до 1")
    elif key == "chunk_size":
        value = int(value)
        if not 300 <= value <= 6000:
            raise SettingsError("Размер фрагмента: от 300 до 6000 символов")
    elif key == "chunk_overlap":
        value = int(value)
        if not 0 <= value <= 1000:
            raise SettingsError("Перекрытие: от 0 до 1000 символов")
    elif key == "files_root":
        value = str(value).strip().strip('"')
        if value and not Path(value).expanduser().is_dir():
            raise SettingsError(f"Папка не найдена: {value}")
    elif key == "python_timeout":
        value = int(value)
        if not 1 <= value <= 120:
            raise SettingsError("Время на выполнение кода: от 1 до 120 секунд")
    elif key == "web_provider":
        if value not in ("duckduckgo", "searxng"):
            raise SettingsError("Поисковик: duckduckgo или searxng")
    elif key == "searxng_url":
        value = str(value).strip().rstrip("/")
        if value and not value.startswith(("http://", "https://")):
            raise SettingsError("Адрес SearXNG должен начинаться с http:// или https://")
    elif key == "ui_theme":
        if value not in ("hud", "classic"):
            raise SettingsError("Тема: hud или classic")
    elif key == "address":
        value = str(value).strip()
        if not 1 <= len(value) <= 30:
            raise SettingsError("Обращение: от 1 до 30 символов (например, «сэр», «мисс», «босс»)")
    elif key == "tts_voice":
        value = str(value).strip()[:200]
    elif key == "tts_rate":
        value = float(value)
        if not 0.5 <= value <= 2.0:
            raise SettingsError("Скорость речи: от 0.5 до 2")
    elif key == "whisper_model":
        if value not in ("tiny", "base", "small", "medium"):
            raise SettingsError("Модель распознавания: tiny, base, small или medium")
    elif key == "voice_language":
        if value not in ("ru", "en", "auto"):
            raise SettingsError("Язык распознавания: ru, en или auto")
    elif key == "embedding_model":
        value = str(value).strip()
        if not value:
            raise SettingsError("Укажите модель эмбеддингов")
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
