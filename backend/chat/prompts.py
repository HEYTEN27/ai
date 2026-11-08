"""
Сборка системного промпта — «инструкции-характера», которая уходит в модель
первым сообщением (роль system) перед всей историей диалога.

Итоговый промпт = общий промпт из настроек (имя, правила)
                 + инструкция выбранной персоны (учитель, программист...).

В тексте можно использовать подстановки:
  {name}  — имя ассистента (Джарвис)
  {model} — модель, которая сейчас отвечает (qwen3:8b)
  {date}  — сегодняшняя дата словами (модель сама не знает, какой сегодня день)
  {address} — как обращаться к пользователю («сэр» — настраивается)
"""

import re
from datetime import datetime

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря"]
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]

PLACEHOLDERS = ("name", "model", "date", "address")


def today_text(now: datetime | None = None) -> str:
    """«7 ноября 2026 года, суббота» — по часам компьютера пользователя."""
    now = now or datetime.now()
    return f"{now.day} {MONTHS[now.month - 1]} {now.year} года, {WEEKDAYS[now.weekday()]}"


def render(template: str, values: dict) -> str:
    """Подставляет {name}, {model}, {date}.

    Не используем str.format: пользователь может написать в промпте фигурные скобки
    (например, пример кода на JS), и format упал бы с ошибкой. Здесь заменяются
    только известные подстановки, всё остальное остаётся как есть.
    """
    pattern = r"\{(" + "|".join(PLACEHOLDERS) + r")\}"
    return re.sub(pattern, lambda m: str(values.get(m.group(1), m.group(0))), template)


def build_system_prompt(settings: dict, persona: dict | None, model: str, memory_block: str = "",
                        tools_block: str = "") -> str:
    """Общий промпт + инструкция персоны + правила инструментов + факты из долговременной памяти."""
    values = {"name": settings["assistant_name"], "model": model, "date": today_text(),
              "address": settings.get("address", "сэр")}
    parts = [render(settings["system_prompt"], values).strip()]
    if persona and persona.get("prompt", "").strip():
        parts.append(render(persona["prompt"], values).strip())
    if tools_block:
        parts.append(tools_block)
    if memory_block:
        parts.append(memory_block)
    return "\n\n".join(p for p in parts if p)


def generation_options(settings: dict, persona: dict) -> dict:
    """Параметры генерации для Ollama: из персоны + размер контекста из общих настроек."""
    options = {
        "num_ctx": settings["num_ctx"],
        "temperature": persona["temperature"],
        "top_p": persona["top_p"],
        "top_k": persona["top_k"],
        "repeat_penalty": persona["repeat_penalty"],
    }
    if persona.get("num_predict"):
        options["num_predict"] = persona["num_predict"]
    return options
