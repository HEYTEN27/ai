"""
Подтверждения действий пользователем («Разрешить / Отклонить» в чате).

Как это работает:
  1. Модель просит прочитать файл. Сервер создаёт «ожидание» с уникальным id
     и отправляет в браузер событие tool_confirm — там появляется карточка с кнопками.
  2. Генерация ответа ЖДЁТ (await) — модель стоит на паузе.
  3. Пользователь жмёт кнопку → браузер делает POST /api/tools/confirm/{id} →
     ожидание завершается, и генерация продолжается.

Технически «ожидание» — это asyncio.Future: объект, у которого результат появится позже.
"""

import asyncio

CONFIRM_TIMEOUT_SECONDS = 600  # 10 минут: не ответил — считаем, что отклонил

_pending: dict[str, asyncio.Future] = {}


def create(confirm_id: str) -> asyncio.Future:
    future = asyncio.get_running_loop().create_future()
    _pending[confirm_id] = future
    return future


def resolve(confirm_id: str, approved: bool) -> bool:
    """Ответ пользователя. False — такого ожидания нет (уже ответили или истекло)."""
    future = _pending.get(confirm_id)
    if future is None or future.done():
        return False
    future.set_result(approved)
    return True


async def wait(confirm_id: str, timeout: float = CONFIRM_TIMEOUT_SECONDS) -> bool:
    future = _pending.get(confirm_id) or create(confirm_id)
    try:
        return await asyncio.wait_for(future, timeout)
    except asyncio.TimeoutError:
        return False
    finally:
        _pending.pop(confirm_id, None)  # и при отмене («Стоп»), и при ответе — убираем за собой


def pending_ids() -> list[str]:
    return list(_pending)
