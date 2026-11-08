"""
Извлечение фактов: после ответа ассистента модель смотрит на последний обмен
сообщениями и решает, есть ли там что-то, что стоит запомнить о пользователе.

Как сделано надёжно:
  * Ответ модели ограничен JSON-схемой (параметр format у Ollama) — модель физически
    не может ответить «Конечно! Вот факты: ...», только JSON нужной структуры.
  * Изменять и удалять можно только факты из переданного модели списка (по id) —
    модель не может «забыть» что-то, чего не видела.
  * Фильтр чувствительных данных: пароли, номера карт и т.п. не сохраняются, даже
    если модель решит их запомнить.
  * Дубликаты отбрасываются.
  * Запрос идёт с тем же num_ctx, что и чат, — иначе Ollama перезагрузила бы модель
    в видеопамяти (это 10–30 секунд).
"""

import json
import re

from ..llm import LLMBackend, LLMError
from . import repository as repo
from .retrieval import lexical_score, stems

SYSTEM_PROMPT = """\
Ты — модуль долговременной памяти личного ассистента. Твоя задача — найти в последнем \
обмене сообщениями устойчивые факты о ПОЛЬЗОВАТЕЛЕ, которые пригодятся в будущих разговорах.

Что сохранять: имя, учёба (вуз, курс, предметы), работа, навыки и уровень, проекты, цели, \
интересы, предпочтения в общении и оформлении ответов, важные постоянные обстоятельства.

Что НЕ сохранять:
- разовые вопросы и задачи («просит объяснить замыкания» — это не факт о человеке);
- содержание ответов ассистента и общие знания;
- временное (настроение сейчас, планы на вечер);
- догадки — только то, что пользователь сказал сам;
- пароли, номера карт, паспортов, телефонов, точные адреса и другие чувствительные данные — НИКОГДА.

Правила:
- Факт — одно короткое предложение от третьего лица, без слова «пользователь»: \
«Учится на 3 курсе», «Предпочитает примеры на JavaScript».
- Если новое сообщение уточняет или противоречит известному факту — верни update с его id.
- Если пользователь просит что-то забыть — верни delete с id этого факта.
- Не дублируй то, что уже известно.
- В большинстве сообщений новых фактов НЕТ — тогда верни пустые списки."""

# JSON-схема ответа: Ollama заставит модель вернуть ровно такую структуру
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "add": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "category": {"type": "string", "enum": repo.CATEGORIES},
                },
                "required": ["content", "category"],
            },
        },
        "update": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "content": {"type": "string"}},
                "required": ["id", "content"],
            },
        },
        "delete": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["add", "update", "delete"],
}

# Сколько текста ответа ассистента показывать модели (нужен только для контекста)
ANSWER_CHARS = 1200

# Чувствительные данные, которые нельзя сохранять ни при каких условиях
SENSITIVE_PATTERNS = [
    r"\b(?:\d[ -]?){13,19}\b",  # номер банковской карты
    r"парол|password|pin[- ]?код|пин[- ]?код|cvv|cvc",
    r"паспорт\w*\s*(серии|номер|№)?\s*\d",
    r"\+?\d[\d\s()-]{9,}\d",  # номер телефона
    r"api[_ -]?key|токен\s+\S{10,}|secret",
]


def is_sensitive(text: str) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in SENSITIVE_PATTERNS)


def worth_checking(user_text: str) -> bool:
    """Стоит ли вообще тратить запрос к модели. «Спасибо», «ок», «продолжай» — не стоит."""
    text = user_text.strip().lower()
    if re.search(r"запомни|забудь|меня зовут|я учусь|я работаю|я живу|мне \d+", text):
        return True
    return len(text) >= 20


def is_duplicate(content: str, existing: list[dict]) -> bool:
    """Почти такой же факт уже есть? Сравниваем по корням слов."""
    norm = content.lower().strip(" .")
    for fact in existing:
        if fact["content"].lower().strip(" .") == norm:
            return True
        if stems(content) and lexical_score(content, fact["content"]) >= 0.85:
            return True
    return False


def build_messages(user_text: str, answer_text: str, known: list[dict]) -> list[dict]:
    known_text = "\n".join(f"[id={f['id']}] {f['content']}" for f in known) or "(пока ничего)"
    answer = answer_text[:ANSWER_CHARS] + ("…" if len(answer_text) > ANSWER_CHARS else "")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Уже известно о пользователе:\n{known_text}\n\n"
                f"Последний обмен сообщениями:\n"
                f"Пользователь: {user_text}\n"
                f"Ассистент: {answer}\n\n"
                "Верни JSON с полями add, update, delete."
            ),
        },
    ]


def parse_response(raw: str) -> dict:
    """Разбирает JSON модели. При мусоре возвращает пустой результат, а не падает."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Запасной вариант: вдруг модель обернула JSON в текст
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            return {"add": [], "update": [], "delete": []}
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {"add": [], "update": [], "delete": []}
    if not isinstance(data, dict):
        return {"add": [], "update": [], "delete": []}
    return {
        "add": [x for x in data.get("add") or [] if isinstance(x, dict) and x.get("content")],
        "update": [x for x in data.get("update") or [] if isinstance(x, dict) and x.get("content")],
        "delete": [x for x in data.get("delete") or [] if isinstance(x, int)],
    }


async def extract_and_apply(
    backend: LLMBackend,
    *,
    model: str,
    think_supported: bool,
    num_ctx: int,
    user_text: str,
    answer_text: str,
    known: list[dict],
    conversation_id: str,
    message_id: int | None,
) -> list[dict]:
    """Спрашивает модель и применяет изменения. Возвращает список событий журнала для показа в чате."""
    if not worth_checking(user_text):
        return []
    try:
        raw = await backend.complete(
            model,
            build_messages(user_text, answer_text, known),
            # «Размышления» тут не нужны: это быстрая служебная задача
            think=False if think_supported else None,
            options={"num_ctx": num_ctx, "temperature": 0.0},
            format=RESPONSE_SCHEMA,
        )
    except LLMError:
        return []  # память — дополнительная функция, её сбой не должен ломать чат

    result = parse_response(raw)
    known_ids = {f["id"] for f in known}
    all_facts = repo.list_memories()
    event_ids: list[int] = []
    ctx = {"source": "auto", "conversation_id": conversation_id, "message_id": message_id}

    for item in result["delete"]:
        if item in known_ids:
            event_id = repo.delete_memory(item, **ctx)
            if event_id:
                event_ids.append(event_id)

    for item in result["update"]:
        if item.get("id") in known_ids and not is_sensitive(item["content"]):
            try:
                _, event_id = repo.update_memory(item["id"], content=item["content"], **ctx)
            except repo.FactError:
                continue
            if event_id:
                event_ids.append(event_id)

    for item in result["add"][:5]:  # больше 5 фактов за раз — скорее всего, модель увлеклась
        content = item["content"]
        if is_sensitive(content) or is_duplicate(content, all_facts):
            continue
        try:
            fact, event_id = repo.add_memory(content, category=item.get("category"), **ctx)
        except repo.FactError:
            continue
        all_facts.append(fact)
        event_ids.append(event_id)

    return [repo.get_event(e) for e in event_ids]
