"""
Как Джарвис учится на ваших исправлениях и 👎 — без дообучения модели.

Веса модели от этого не меняются (это делает этап 7, дообучение в Colab). Но модель
отлично следует инструкциям, поэтому из каждого исправления мы просим её сформулировать
ПРАВИЛО на будущее и кладём его в системный промпт. Эффект — со следующего же ответа.

Не каждое исправление — урок. «Столица Австралии — Канберра, а не Сидней» — это разовая
ошибка факта, правилом она не становится. А «переписал код с JavaScript на TypeScript» —
это предпочтение, которое стоит помнить. Отличать одно от другого просим саму модель
(ответ строго по JSON-схеме, как при извлечении фактов памяти).
"""

import json
import re

from ..llm import LLMBackend, LLMError
from ..memory.extraction import is_sensitive
from . import repository as repo

SYSTEM_PROMPT = """\
Ты — модуль уроков личного ассистента. Пользователь недоволен ответом ассистента: исправил его \
или объяснил, что не так. Сформулируй ОДНО общее правило на будущее — как отвечать этому \
пользователю, чтобы такого больше не было.

Правило:
- короткое повелительное предложение (до 20 слов): «Код пиши на TypeScript», «Отвечай короче, сначала главное»;
- о форме, стиле, языке, длине, оформлении, уровне объяснений, выборе технологий — то, что пригодится \
в РАЗНЫХ будущих вопросах;
- без пересказа конкретного вопроса.

Если исправление — разовая правка факта, опечатки или ошибки в этом конкретном ответе, общего \
правила нет: верни general = false.
Если новое правило уточняет или противоречит одному из уже известных уроков — укажи его id в replaces, \
иначе replaces = 0."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "general": {"type": "boolean"},
        "lesson": {"type": "string"},
        "replaces": {"type": "integer"},  # id заменяемого урока; 0 — новый урок
    },
    "required": ["general", "lesson", "replaces"],
}

TEXT_CHARS = 1500  # сколько текста ответа показывать модели

# Причины 👎 без пояснения превращаются в урок сразу, без запроса к модели
QUICK_REASONS = {
    "long": ("Слишком длинно", "Отвечай короче: сначала главное, без лишних вступлений и повторов."),
    "short": ("Слишком коротко", "Отвечай подробнее: объясняй шаги и приводи пример."),
    "complex": ("Сложно объяснено", "Объясняй проще: простыми словами, на примерах, без лишних терминов."),
    "wrong": ("Ошибка в ответе", None),  # ошибка факта — правилом не становится
    "offtopic": ("Не по теме", None),
}


def _cut(text: str) -> str:
    text = text or ""
    return text[:TEXT_CHARS] + ("…" if len(text) > TEXT_CHARS else "")


def build_messages(*, question: str, answer: str, corrected: str | None, reason: str | None,
                   known: list[dict]) -> list[dict]:
    known_text = "\n".join(f"[id={k['id']}] {k['content']}" for k in known) or "(пока нет)"
    parts = [f"Уже известные уроки:\n{known_text}", f"Вопрос пользователя:\n{_cut(question)}",
             f"Ответ ассистента:\n{_cut(answer)}"]
    if corrected:
        parts.append(f"Как пользователь исправил ответ:\n{_cut(corrected)}")
    if reason:
        parts.append(f"Что пользователю не понравилось:\n{reason[:500]}")
    parts.append("Верни JSON с полями general, lesson, replaces.")
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": "\n\n".join(parts)}]


def parse_response(raw: str) -> dict | None:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw or "", re.DOTALL)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    return data if isinstance(data, dict) else None


def save(content: str, *, source: str, replaces: int | None = None, message_id: int | None = None,
         conversation_id: str | None = None) -> dict:
    """Добавляет урок или обновляет похожий / заменяемый. Возвращает {action, lesson, previous}."""
    target = repo.get_lesson(replaces) if replaces else None
    target = target or repo.find_similar(content)
    if target:
        previous = target["content"]
        lesson = repo.update_lesson(target["id"], content=content, enabled=True)
        return {"action": "updated", "lesson": lesson, "previous": previous}
    lesson = repo.add_lesson(content, source, message_id=message_id, conversation_id=conversation_id)
    return {"action": "added", "lesson": lesson, "previous": None}


async def learn(
    backend: LLMBackend, *, model: str, think_supported: bool, num_ctx: int,
    question: str, answer: str, corrected: str | None = None, reason: str | None = None,
    quick: list[str] | None = None, message_id: int | None = None, conversation_id: str | None = None,
) -> dict:
    """Выводит и сохраняет урок. Возвращает {action: added|updated|none, lesson, previous, note}."""
    quick = [q for q in (quick or []) if q in QUICK_REASONS]
    source = "correction" if corrected else "feedback"
    ctx = {"message_id": message_id, "conversation_id": conversation_id}

    # 👎 с готовой причиной и без пояснения — правило известно заранее, модель не нужна
    if not corrected and not (reason or "").strip():
        rules = [QUICK_REASONS[q][1] for q in quick if QUICK_REASONS[q][1]]
        if not rules:
            return {"action": "none", "lesson": None, "previous": None,
                    "note": "Ошибку запомнил в датасете — правилом на будущее она не станет."}
        return save(rules[0], source=source, **ctx) | {"note": None}

    reason_text = "; ".join([QUICK_REASONS[q][0] for q in quick] + ([reason.strip()] if reason and reason.strip() else []))
    known = repo.list_lessons()
    try:
        raw = await backend.complete(
            model,
            build_messages(question=question, answer=answer, corrected=corrected, reason=reason_text or None, known=known),
            think=False if think_supported else None,  # служебная задача — без «размышлений»
            options={"num_ctx": num_ctx, "temperature": 0.1},  # тот же num_ctx — без перезагрузки модели
            format=RESPONSE_SCHEMA,
        )
    except LLMError as e:
        return {"action": "none", "lesson": None, "previous": None, "note": f"Не удалось вывести урок: {e}"}

    data = parse_response(raw)
    if not data or not data.get("general") or not str(data.get("lesson") or "").strip():
        return {"action": "none", "lesson": None, "previous": None,
                "note": "Это разовая правка — общего правила из неё нет. Исправление сохранено в датасете."}
    content = str(data["lesson"]).strip()
    if is_sensitive(content):
        return {"action": "none", "lesson": None, "previous": None, "note": "Урок не сохранён: в нём личные данные."}
    replaces = data.get("replaces") if isinstance(data.get("replaces"), int) and data.get("replaces") > 0 else None
    try:
        return save(content[: repo.MAX_CHARS], source=source, replaces=replaces, **ctx) | {"note": None}
    except repo.LessonError as e:
        return {"action": "none", "lesson": None, "previous": None, "note": str(e)}


def format_for_prompt(lessons: list[dict], budget_tokens: int = 400) -> str:
    """Блок для системного промпта. Свежие уроки — первыми; что не влезло в бюджет — не берём."""
    lines, spent = [], 0
    for lesson in lessons:
        cost = len(lesson["content"]) // 3 + 3
        if spent + cost > budget_tokens:
            break
        lines.append(f"- {lesson['content']}")
        spent += cost
    if not lines:
        return ""
    return ("Уроки — как этот пользователь просил отвечать (выведены из его исправлений и оценок). "
            "Соблюдай их, если текущая просьба прямо не требует другого:\n" + "\n".join(lines))
