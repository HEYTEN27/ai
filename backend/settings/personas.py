"""
Персоны — «режимы» ассистента: учитель, программист, редактор...

Персона = дополнительная инструкция к системному промпту + свои параметры генерации.
Имя (Джарвис) и общие правила остаются из основного промпта, персона лишь
уточняет роль. Например, «Программист» отвечает строже (низкая температура),
а «Учитель» объясняет по шагам и задаёт проверочные вопросы.

Встроенные персоны создаются при запуске, если их ещё нет в базе.
Их можно редактировать (и вернуть к исходным), но нельзя удалить.
Свои персоны можно создавать и удалять.

Параметры генерации простыми словами:
  temperature    — «смелость»: 0.1–0.3 точно и однообразно, 0.7 — живо, >1 — фантазирует
  top_p          — из какой доли самых вероятных слов выбирать (0.8 = из верхних 80%)
  top_k          — из скольких самых вероятных слов выбирать (20 = из 20 лучших)
  repeat_penalty — штраф за повторы (1.0 = без штрафа, 1.1 — заметно меньше повторов)
  num_predict    — максимальная длина ответа в токенах (0 = без ограничения)
"""

from datetime import datetime, timezone

from ..db import get_conn

# Рекомендации авторов Qwen3 для режима без «размышлений»:
# temperature 0.7, top_p 0.8, top_k 20. Повторы у Qwen3 штрафовать не нужно.
BUILTIN_PERSONAS = [
    {
        "slug": "universal",
        "name": "Универсальный",
        "icon": "🤖",
        "description": "Обычный режим на все случаи жизни",
        "prompt": "",
        "temperature": 0.7, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.0, "num_predict": 0,
    },
    {
        "slug": "teacher",
        "name": "Учитель",
        "icon": "🎓",
        "description": "Объясняет по шагам и проверяет понимание",
        "prompt": (
            "Сейчас ты в роли терпеливого преподавателя.\n"
            "- Объясняй шаг за шагом, от простого к сложному, с аналогиями из жизни и примерами.\n"
            "- В конце задай 1–2 коротких вопроса, чтобы проверить, понял ли пользователь.\n"
            "- Если просят решить задачу — сначала дай подсказку и предложи попробовать самому. "
            "Полное решение — только если попросят ещё раз.\n"
            "- Хвали за правильные шаги, ошибки разбирай спокойно и объясняй, почему так."
        ),
        "temperature": 0.7, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.0, "num_predict": 0,
    },
    {
        "slug": "programmer",
        "name": "Программист",
        "icon": "💻",
        "description": "Точный код, разбор ошибок, ревью",
        "prompt": (
            "Сейчас ты в роли опытного разработчика — старшего коллеги.\n"
            "- Давай рабочий, простой и читаемый код с короткими комментариями.\n"
            "- Объясняй ключевые решения и типичные ошибки, которые здесь можно допустить.\n"
            "- При поиске багов сначала назови причину, потом покажи исправление.\n"
            "- Если важна версия языка или библиотеки — укажи её.\n"
            "- Если задача неоднозначна — задай уточняющий вопрос, а не угадывай."
        ),
        "temperature": 0.3, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.0, "num_predict": 0,
    },
    {
        "slug": "editor",
        "name": "Редактор",
        "icon": "✍️",
        "description": "Исправляет и улучшает тексты",
        "prompt": (
            "Сейчас ты в роли литературного редактора и корректора.\n"
            "- Исправляй орфографию, пунктуацию и стиль; делай текст ясным и живым.\n"
            "- Сохраняй смысл и голос автора, не добавляй новых фактов.\n"
            "- Сначала дай исправленный текст целиком, затем коротким списком — "
            "главные правки и почему они нужны."
        ),
        "temperature": 0.4, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.0, "num_predict": 0,
    },
    {
        # Персона по умолчанию (sort_order -1 — первая в списке): вежливый ИИ-дворецкий
        "slug": "jarvis",
        "name": "Джарвис",
        "icon": "🤵",
        "description": "Вежливый ИИ-дворецкий: «Да, сэр», спокойствие и лёгкая ирония",
        "prompt": (
            "Твой характер — безупречно вежливый ИИ-дворецкий: спокойный, собранный, с лёгкой сухой иронией.\n"
            "- Обращайся к пользователю «{address}».\n"
            "- Начинай ответ коротким подтверждением в своём стиле: «Да, {address}.», «Конечно, {address}.», "
            "«Сию минуту, {address}.», «Разумеется.» — но меняй фразы и не вставляй их в каждое предложение.\n"
            "- На приветствие отвечай по-дворецки: «К вашим услугам, {address}. Чем могу помочь?».\n"
            "- Суть ответа — по делу и точно, как обычно; характер — в тоне, а не в многословии.\n"
            "- Иногда, к месту, можно деликатно пошутить или заметить что-то полезное, о чём не спрашивали."
        ),
        "temperature": 0.7, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.0, "num_predict": 0,
        "sort_order": -1,
    },
]

EDITABLE_FIELDS = ["name", "icon", "description", "prompt", "temperature", "top_p", "top_k", "repeat_penalty", "num_predict"]

# Допустимые диапазоны параметров: (минимум, максимум, тип)
LIMITS = {
    "temperature": (0.0, 2.0, float),
    "top_p": (0.05, 1.0, float),
    "top_k": (1, 200, int),
    "repeat_penalty": (0.8, 2.0, float),
    "num_predict": (0, 32768, int),
}


class PersonaError(ValueError):
    """Ошибка с понятным пользователю текстом."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _to_dict(row) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    data["builtin"] = bool(data["builtin"])
    return data


def _validate(fields: dict, *, partial: bool) -> dict:
    """Проверяет поля персоны. partial=True — можно передать не все поля (для обновления)."""
    clean = {}
    for key in EDITABLE_FIELDS:
        if key not in fields:
            if not partial and key == "name":
                raise PersonaError("У персоны должно быть имя")
            continue
        value = fields[key]
        if key in LIMITS:
            low, high, cast = LIMITS[key]
            try:
                value = cast(value)
            except (TypeError, ValueError):
                raise PersonaError(f"Параметр {key} должен быть числом") from None
            if not low <= value <= high:
                raise PersonaError(f"Параметр {key}: от {low} до {high}")
        else:
            value = str(value).strip() if key != "prompt" else str(value)
            if key == "name" and not 1 <= len(value) <= 40:
                raise PersonaError("Имя персоны: от 1 до 40 символов")
            if key == "icon" and not 1 <= len(value) <= 8:
                raise PersonaError("Иконка: один эмодзи или пара символов")
            if key == "description" and len(value) > 200:
                raise PersonaError("Описание: не длиннее 200 символов")
            if key == "prompt" and len(value) > 10_000:
                raise PersonaError("Инструкция персоны: не длиннее 10 000 символов")
        clean[key] = value
    return clean


def ensure_builtin() -> None:
    """Создаёт встроенные персоны, которых ещё нет в базе (вызывается при запуске)."""
    now = _now()
    with get_conn() as conn:
        for order, p in enumerate(BUILTIN_PERSONAS):
            conn.execute(
                """INSERT OR IGNORE INTO personas
                   (slug, name, icon, description, prompt, temperature, top_p, top_k,
                    repeat_penalty, num_predict, builtin, sort_order, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                (p["slug"], p["name"], p["icon"], p["description"], p["prompt"], p["temperature"],
                 p["top_p"], p["top_k"], p["repeat_penalty"], p["num_predict"], p.get("sort_order", order), now, now),
            )


def list_personas() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM personas ORDER BY sort_order, id").fetchall()
    return [_to_dict(r) for r in rows]


def get_persona(persona_id: int | None) -> dict | None:
    if persona_id is None:
        return None
    with get_conn() as conn:
        return _to_dict(conn.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone())


def fallback_persona() -> dict:
    """Персона, которая используется, если в диалоге никакая не выбрана: «Универсальный»."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM personas ORDER BY sort_order, id LIMIT 1").fetchone()
    if row is None:  # база пустая (не должно случаться — ensure_builtin вызывается при старте)
        ensure_builtin()
        return fallback_persona()
    return _to_dict(row)


def create_persona(fields: dict) -> dict:
    data = {**BUILTIN_PERSONAS[0], "icon": "🙂", "description": ""}  # параметры как у «Универсального»
    data.update(_validate(fields, partial=False))
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO personas
               (name, icon, description, prompt, temperature, top_p, top_k, repeat_penalty,
                num_predict, builtin, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 100, ?, ?)""",
            (data["name"], data["icon"], data["description"], data["prompt"], data["temperature"],
             data["top_p"], data["top_k"], data["repeat_penalty"], data["num_predict"], now, now),
        )
    return get_persona(cur.lastrowid)


def update_persona(persona_id: int, fields: dict) -> dict | None:
    clean = _validate(fields, partial=True)
    if not clean:
        return get_persona(persona_id)
    sets = ", ".join(f"{key} = ?" for key in clean)  # ключи только из EDITABLE_FIELDS — это безопасно
    with get_conn() as conn:
        conn.execute(
            f"UPDATE personas SET {sets}, updated_at = ? WHERE id = ?",
            (*clean.values(), _now(), persona_id),
        )
    return get_persona(persona_id)


def reset_persona(persona_id: int) -> dict | None:
    """Возвращает встроенную персону к исходному виду."""
    persona = get_persona(persona_id)
    if persona is None:
        return None
    original = next((p for p in BUILTIN_PERSONAS if p["slug"] == persona["slug"]), None)
    if original is None:
        raise PersonaError("Сбросить можно только встроенную персону")
    return update_persona(persona_id, {k: original[k] for k in EDITABLE_FIELDS})


def delete_persona(persona_id: int) -> bool:
    persona = get_persona(persona_id)
    if persona is None:
        return False
    if persona["builtin"]:
        raise PersonaError("Встроенную персону удалить нельзя — её можно изменить или сбросить")
    with get_conn() as conn:
        conn.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
    return True
