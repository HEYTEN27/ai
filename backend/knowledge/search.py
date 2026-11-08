"""
Поиск по базе знаний: какие фрагменты подставить в ответ.

Гибридный поиск — два способа сразу:
  * по смыслу (векторы bge-m3): «как сохранить переменную внутри функции» найдёт
    фрагмент про замыкания, хотя слов «замыкание» в вопросе нет;
  * по словам (FTS5): точные термины, имена, названия функций — `useEffect`, «Кнут».

Результаты объединяются методом RRF (Reciprocal Rank Fusion): фрагмент получает
очки 1/(60 + место) в каждом списке, очки складываются. Фрагмент, который высоко
в обоих списках, побеждает.

Защита от мусора: фрагменты по смыслу берём только с близостью выше порога
(по умолчанию 0.45), а по словам — только если совпали хотя бы два значимых слова
вопроса (или половина, если значимых слов мало). Слова-связки («объясни», «такое»)
не считаются. Поэтому на «спасибо» или «привет» ничего не подставляется.
"""

import re

from ..llm import LLMBackend, LLMError
from . import store

RRF_K = 60


def estimate_tokens(text: str) -> int:
    return len(text) // 3 + 10  # + шапка «[1] Документ, стр. 5»


# Слова-связки из вопросов: «объясни, что такое…» — по ним искать бессмысленно
FILLER_WORDS = {
    "объясни", "объяснить", "расскажи", "рассказать", "покажи", "подскажи", "помоги", "напиши",
    "такое", "такой", "какой", "какая", "какие", "каким", "можно", "нужно", "надо", "почему",
    "зачем", "пожалуйста", "просто", "очень", "вообще", "который", "которые", "если", "чтобы",
    "этот", "этого", "этой", "будет", "есть", "было", "были", "мне", "меня", "тебя", "сейчас",
    "спасибо", "привет", "what", "how", "why", "explain", "please", "about", "with", "this", "that",
}


def query_words(text: str) -> list[str]:
    words = re.findall(r"[\wёЁ]+", text.lower().replace("ё", "е"))
    return list(dict.fromkeys(w for w in words if len(w) > 3 and w not in FILLER_WORDS))


def matched_words(words: list[str], text: str) -> int:
    """Сколько слов вопроса (по началу слова, без окончания) встречается во фрагменте."""
    low = text.lower().replace("ё", "е")
    return sum(1 for w in words if w[:max(4, len(w) - 2)] in low)


def build_query(user_messages: list[str]) -> str:
    """Короткий уточняющий вопрос («а подробнее?») без предыдущего непонятен — добавляем его."""
    last = user_messages[-1] if user_messages else ""
    if len(last) < 60 and len(user_messages) > 1:
        return f"{user_messages[-2]}\n{last}"
    return last


async def search(backend: LLMBackend, query: str, *, collection_id: int | None, settings: dict,
                 top_k: int | None = None, budget_tokens: int | None = None) -> tuple[list[dict], str]:
    """Возвращает (фрагменты, способ: hybrid | words | none)."""
    top_k = top_k or settings["rag_top_k"]
    budget = budget_tokens or settings["rag_budget_tokens"]
    pool = top_k * 4  # кандидатов берём с запасом — часть отсеется

    # --- по смыслу ---
    vector_scores: dict[int, float] = {}
    method = "words"
    try:
        [qvec] = await backend.embed(settings["embedding_model"], [query], on_gpu=settings["embedding_on_gpu"])
        hits = store.vector_index.search(qvec, model=settings["embedding_model"],
                                         collection_id=collection_id, limit=pool)
        if hits:
            method = "hybrid"
        vector_scores = {cid: s for cid, s in hits if s >= settings["rag_min_score"]}
    except (LLMError, ValueError):
        pass  # модели эмбеддингов нет — остаётся поиск по словам

    # --- по словам ---
    words = query_words(query)
    fts_ids = [cid for cid, _ in store.fts_search(" ".join(words), collection_id=collection_id, limit=pool)]
    chunks = store.get_chunks(list(set(fts_ids) | set(vector_scores)))
    need = min(2, max(1, (len(words) + 1) // 2))  # 1 слово → 1, 2–3 слова → 1–2, больше → 2
    fts_ok = [cid for cid in fts_ids
              if cid in chunks and matched_words(words, f"{chunks[cid]['section'] or ''} {chunks[cid]['text']}") >= need]

    # --- объединение (RRF) ---
    fused: dict[int, float] = {}
    for rank, cid in enumerate(sorted(vector_scores, key=vector_scores.get, reverse=True)):
        fused[cid] = fused.get(cid, 0) + 1 / (RRF_K + rank)
    for rank, cid in enumerate(fts_ok):
        fused[cid] = fused.get(cid, 0) + 1 / (RRF_K + rank)

    result, used = [], 0
    for cid in sorted(fused, key=fused.get, reverse=True):
        chunk = chunks.get(cid)
        if chunk is None:
            continue
        cost = estimate_tokens(chunk["text"])
        if result and used + cost > budget:
            continue  # этот не влез — может, влезет следующий, покороче
        result.append({**chunk, "score": round(vector_scores[cid], 3) if cid in vector_scores else None,
                       "by_words": cid in fts_ok})
        used += cost
        if len(result) >= top_k:
            break
    return result, (method if result else "none")


def source_label(chunk: dict) -> str:
    """«Лекция 3 › Замыкания, стр. 5» — подпись источника."""
    label = chunk["title"]
    if chunk.get("section"):
        label += f" › {chunk['section']}"
    if chunk.get("page_start"):
        p1, p2 = chunk["page_start"], chunk.get("page_end") or chunk["page_start"]
        label += f", стр. {p1}" if p1 == p2 else f", стр. {p1}–{p2}"
    return label


def augment_question(question: str, chunks: list[dict]) -> str:
    """Последнее сообщение пользователя вместе с найденными фрагментами.

    Фрагменты кладём в сообщение, а не в системный промпт: так начало запроса
    (системный промпт + история) не меняется от вопроса к вопросу, и Ollama
    переиспользует уже посчитанный кэш — ответ начинается быстрее.
    """
    parts = ["Фрагменты из базы знаний пользователя (могут быть неполными):"]
    for n, c in enumerate(chunks, start=1):
        parts.append(f"[{n}] {source_label(c)}\n{c['text']}")
    parts.append(
        "Правила: отвечай, опираясь на фрагменты, если они относятся к вопросу. После утверждений, "
        "взятых из фрагментов, ставь номер источника в квадратных скобках: [1], [2]. Если во фрагментах "
        "ответа нет — так и скажи и ответь из общих знаний, без ссылок. Не придумывай номера источников."
    )
    parts.append(f"Вопрос пользователя: {question}")
    return "\n\n".join(parts)


def sources_for_message(chunks: list[dict]) -> list[dict]:
    """Краткие сведения об источниках — сохраняются вместе с ответом (для ссылок [1], [2])."""
    return [
        {"n": n, "chunk_id": c["id"], "document_id": c["document_id"], "title": c["title"],
         "section": c.get("section"), "page": c.get("page_start"), "file_type": c["file_type"],
         "collection": c["collection_name"], "label": source_label(c), "score": c.get("score")}
        for n, c in enumerate(chunks, start=1)
    ]
