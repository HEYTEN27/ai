"""
Сборка контекста — того, что реально уходит в модель.

Модель «помнит» только то, что мы ей передали в запросе. Окно контекста
ограничено (по умолчанию 8192 токена), поэтому длинную историю приходится
обрезать: оставляем самые свежие сообщения, старые отбрасываем.

На следующих этапах сюда добавятся системный промпт (этап 2), факты
из памяти (этап 3) и найденные фрагменты документов (этап 4).
"""


def estimate_tokens(text: str) -> int:
    """Грубая оценка числа токенов без загрузки токенизатора.

    У Qwen3 в среднем ~3 символа русского текста на токен (английского ~4).
    Берём 3 — с запасом. Плюс 4 токена на служебную разметку сообщения.
    """
    return len(text) // 3 + 4


def build_messages(
    history: list[dict],
    *,
    num_ctx: int,
    system_prompt: str | None = None,
    reserve_for_answer: int | None = None,
) -> list[dict]:
    """Превращает историю из базы в список сообщений для модели, укладываясь в окно.

    history — сообщения из базы (старые → новые), последним должен быть вопрос пользователя.
    reserve_for_answer — сколько токенов оставить на ответ модели.
    """
    if reserve_for_answer is None:
        reserve_for_answer = max(1024, num_ctx // 4)
    budget = num_ctx - reserve_for_answer

    system_messages = []
    if system_prompt:
        system_messages.append({"role": "system", "content": system_prompt})
        budget -= estimate_tokens(system_prompt)

    # Идём с конца истории и набираем сообщения, пока помещаются в бюджет
    selected: list[dict] = []
    for message in reversed(history):
        if message["role"] not in ("user", "assistant"):
            continue
        cost = estimate_tokens(message["content"])
        # Последний вопрос пользователя берём всегда, даже если он один не влезает:
        # Ollama сама обрежет начало, а без вопроса отвечать не на что.
        if selected and cost > budget:
            break
        selected.append({"role": message["role"], "content": message["content"]})
        budget -= cost

    selected.reverse()
    return system_messages + selected
