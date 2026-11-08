"""
Нарисовать и сохранить: общее для инструмента в чате, кнопки «Ещё вариант» и страницы «Изображения».

Картинки сохраняются как файлы (этап 9, kind = generated, mime image/png) — поэтому они
скачиваются по той же ссылке /api/files/<id>/download и удаляются вместе с диалогом.
"""

import json
import re

from ..chat import repository as chat_repo
from ..db import get_conn
from ..files import store as files_store
from ..llm import LLMError, get_backend
from ..settings import store as settings_store
from . import engine
from .catalog import MODELS, NEGATIVE_DEFAULT

TRANSLATE_PROMPT = """\
Ты пишешь промпты для генератора изображений Stable Diffusion. Переведи просьбу пользователя \
в один подробный промпт НА АНГЛИЙСКОМ: что изображено, детали, стиль (photo, digital art, \
watercolor…), освещение, ракурс, качество (highly detailed, sharp focus). Только промпт, без кавычек и пояснений."""


def public(record: dict) -> dict:
    return {k: record[k] for k in ("id", "name", "size", "mime", "url", "meta", "created_at", "conversation_id")}


def _slug(prompt: str) -> str:
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", prompt)[:5]
    return "-".join(words).lower() or "image"


async def to_english(text: str) -> str:
    """Русская просьба → английский промпт силами языковой модели (SD понимает английский лучше)."""
    if not re.search(r"[А-Яа-яЁё]", text):
        return text
    settings = settings_store.get_all()
    backend = get_backend()
    try:
        info = {m.name: m for m in await backend.list_models()}.get(settings["default_model"])
        raw = await backend.complete(
            settings["default_model"],
            [{"role": "system", "content": TRANSLATE_PROMPT}, {"role": "user", "content": text}],
            think=False if (info and info.supports_thinking) else None,
            options={"num_ctx": settings["num_ctx"], "temperature": 0.4, "num_predict": 200},
        )
    except LLMError:
        return text  # модель недоступна — рисуем по-русски, как есть
    prompt = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip().strip('"«»')
    return prompt or text


async def create(prompt: str, *, negative: str | None = None, orientation: str = "square", count: int = 1,
                 seed: int | None = None, conversation_id: str | None = None, model_id: str | None = None,
                 request: str | None = None) -> dict:
    """Рисует и сохраняет. Возвращает {images: [файлы], prompt, seed, model, seconds}."""
    model_id = model_id or settings_store.get("image_model")
    if model_id not in MODELS:
        raise engine.ImageError("Неизвестная модель изображений")
    negative = NEGATIVE_DEFAULT if negative is None else negative
    result = await engine.generate(model_id, prompt, negative=negative, orientation=orientation, count=count, seed=seed)
    files = []
    for png, used_seed in zip(result["images"], result["seeds"]):
        meta = {"type": "image", "prompt": prompt, "negative": negative, "seed": used_seed, "model": model_id,
                "orientation": orientation, "width": result["width"], "height": result["height"],
                "steps": result["steps"], "seconds": result["seconds"], "request": request}
        record = files_store.create_file(
            kind="generated", name=f"{_slug(prompt)}-{used_seed}.png", data=png, mime="image/png",
            conversation_id=conversation_id, meta=meta,
        )
        files.append(public(record))
    return {"images": files, "prompt": prompt, "seed": result["seeds"][0], "model": model_id, "seconds": result["seconds"]}


def append_to_message(message_id: int, tool_id: str, images: list[dict]) -> bool:
    """«Ещё вариант» под картинкой в чате: новые картинки дописываем в ту же карточку ответа,
    чтобы после перезагрузки они остались на месте."""
    message = chat_repo.get_message(message_id)
    if not message or message["role"] != "assistant":
        return False
    extras = message.get("extras") or {}
    entry = next((t for t in extras.get("tools", []) if t.get("id") == tool_id), None)
    if not entry or not isinstance(entry.get("display"), dict):
        return False
    entry["display"].setdefault("images", []).extend(images)
    chat_repo.update_extras(message_id, extras)
    files_store.attach_to_message([i["id"] for i in images], message["conversation_id"], message_id)
    return True


def gallery(limit: int = 200) -> list[dict]:
    """Все нарисованные картинки, свежие первыми, с названием диалога."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT f.*, c.title AS conversation_title FROM files f
               LEFT JOIN conversations c ON c.id = f.conversation_id
               WHERE f.kind = 'generated' AND f.mime = 'image/png'
               ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    items = []
    for r in rows:
        data = dict(r)
        data["meta"] = json.loads(data["meta"] or "{}")
        data["url"] = f"/api/files/{data['id']}/download"
        data.pop("text", None)
        items.append(data)
    return items
