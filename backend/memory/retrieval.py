"""
Выбор фактов для контекста: какие факты о пользователе подставить в системный промпт.

Алгоритм:
  1. Закреплённые факты (📌) берём всегда.
  2. Если все факты помещаются в бюджет (по умолчанию ~400 токенов) — берём все.
     Пока память небольшая, так надёжнее всего: модель видит всё, что о вас известно.
  3. Если фактов много — сортируем по похожести на вопрос и берём лучшие, пока влезают.

Похожесть считаем двумя способами:
  * по смыслу — эмбеддинги bge-m3: «где я учусь?» найдёт факт «Студент МГТУ»,
    хотя общих слов нет;
  * по словам — запасной вариант, если bge-m3 не скачана: считаем общие корни слов.
"""

import math
import re

from ..llm import LLMBackend, LLMError
from . import repository as repo


def estimate_tokens(text: str) -> int:
    return len(text) // 3 + 2  # та же грубая оценка, что и для истории чата (+ «- » и перенос)


def cosine(a: list[float], b: list[float]) -> float:
    """Косинусная близость векторов: 1 — одинаковый смысл, около 0 — ничего общего."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# Короткие служебные слова не несут смысла — их не учитываем при поиске по словам
STOP_WORDS = {
    "это", "как", "что", "где", "когда", "почему", "зачем", "или", "для", "меня", "мне", "мой",
    "моя", "мои", "твой", "тебя", "есть", "был", "была", "было", "быть", "очень", "можно",
    "нужно", "надо", "пользователь", "пользователя", "the", "and", "for", "with",
}


def stems(text: str) -> set[str]:
    """Грубые «корни» слов: первые 5 букв. «учусь», «учёба», «учебный» → «учус», «учеб»...

    Не настоящий стеммер, но для коротких фактов работает неплохо и не требует библиотек.
    """
    words = re.findall(r"[a-zа-яё0-9]+", text.lower().replace("ё", "е"))
    return {w[:5] for w in words if len(w) > 2 and w not in STOP_WORDS}


def lexical_score(query: str, fact: str) -> float:
    q, f = stems(query), stems(fact)
    if not q or not f:
        return 0.0
    return len(q & f) / math.sqrt(len(q) * len(f))


async def ensure_embeddings(backend: LLMBackend, model: str, facts: list[dict]) -> bool:
    """Досчитывает векторы для фактов, у которых их нет (новые или изменённые).

    Возвращает True, если у всех фактов теперь есть векторы этой модели.
    """
    missing = [f for f in facts if f["vector"] is None or f["embedding_model"] != model]
    if not missing:
        return True
    try:
        vectors = await backend.embed(model, [f["content"] for f in missing])
    except LLMError:
        return False
    if len(vectors) != len(missing):
        return False
    repo.save_embeddings([(f["id"], v) for f, v in zip(missing, vectors)], model)
    for f, v in zip(missing, vectors):
        f["vector"], f["embedding_model"] = v, model
    return True


async def select_facts(backend: LLMBackend, query: str, *, budget_tokens: int,
                       embedding_model: str) -> tuple[list[dict], str]:
    """Возвращает (выбранные факты, способ выбора: all | semantic | lexical | none)."""
    facts = repo.all_with_embeddings()
    if not facts:
        return [], "none"

    total = sum(estimate_tokens(f["content"]) for f in facts)
    if total <= budget_tokens:
        return facts, "all"

    pinned = [f for f in facts if f["pinned"]]
    others = [f for f in facts if not f["pinned"]]

    method = "lexical"
    if await ensure_embeddings(backend, embedding_model, others):
        try:
            [query_vec] = await backend.embed(embedding_model, [query])
            scores = {f["id"]: cosine(query_vec, f["vector"]) for f in others}
            method = "semantic"
        except (LLMError, ValueError):
            scores = {}
    if method == "lexical":
        scores = {f["id"]: lexical_score(query, f["content"]) for f in others}

    # Сначала самые похожие; при равной похожести — чаще использованные
    others.sort(key=lambda f: (scores.get(f["id"], 0), f["use_count"]), reverse=True)

    selected, used = [], 0
    for f in pinned + others:
        cost = estimate_tokens(f["content"])
        if f["pinned"] or used + cost <= budget_tokens:
            selected.append(f)
            used += cost
    return selected, method


def format_for_prompt(facts: list[dict]) -> str:
    """Блок для системного промпта."""
    if not facts:
        return ""
    lines = "\n".join(f"- {f['content']}" for f in facts)
    return (
        "Что ты знаешь о пользователе из долговременной памяти:\n"
        f"{lines}\n"
        "Учитывай эти факты, когда они уместны (например, подбирай примеры под его уровень и интересы), "
        "но не перечисляй их без необходимости и не говори «я помню, что…» в каждом ответе."
    )
