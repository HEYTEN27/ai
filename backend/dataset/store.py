"""
Датасет для дообучения: примеры из ответов с 👍/👎 и исправлениями.

Пример — это снимок того, что модель должна уметь:
  системный промпт + предыдущие сообщения + вопрос → ответ.
Снимок делается в момент первой оценки и дальше не зависит от диалога.

Что попадает в обучающую выборку (SFT):
  * ответ с 👍 — как есть;
  * любой исправленный ответ — исправленная версия (это лучший сигнал: «вот как надо»);
  * ответы с 👎 без исправления — НЕ попадают (учить на плохих ответах нельзя);
  * ответы, где работали инструменты, — по умолчанию не попадают: в снимке нет шагов
    калькулятора/поиска, и модель научилась бы выдумывать их результаты.

Для DPO (обучение на предпочтениях) из исправлений получаются пары:
  тот же вопрос, chosen = исправленный ответ, rejected = исходный.
"""

import json
import re
from datetime import datetime, timezone

from ..chat import repository as chat_repo
from ..chat.prompts import build_system_prompt, today_text
from ..config import settings as env
from ..db import get_conn
from ..knowledge import store as kb_store
from ..knowledge.search import augment_question
from ..settings import personas as personas_repo
from ..settings import store as settings_store

HISTORY_MESSAGES = 10  # сколько предыдущих сообщений диалога сохранять в примере
TARGET_EXAMPLES = 200  # ориентир для интерфейса: столько хороших примеров желательно для дообучения


class DatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _to_dict(row) -> dict:
    data = dict(row)
    data["history"] = json.loads(data["history"] or "[]")
    for key in ("used_tools", "strip_citations", "included"):
        data[key] = bool(data[key])
    data["in_sft"] = in_sft(data, include_tools=False)
    return data


def in_sft(example: dict, *, include_tools: bool) -> bool:
    """Попадает ли пример в обучающую выборку."""
    if not example["included"]:
        return False
    if example["used_tools"] and not include_tools:
        return False
    return example["rating"] == 1 or bool(example["corrected"])


# ---------- снимок ----------


def build_snapshot(message_id: int) -> dict:
    """Собирает пример из ответа в чате: системный промпт, история, вопрос, ответ."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if row is None:
        raise LookupError("Сообщение не найдено")
    if row["role"] != "assistant":
        raise DatasetError("Оценивать и исправлять можно только ответы ассистента")
    conv_id = row["conversation_id"]
    messages = chat_repo.list_messages(conv_id)
    idx = next(i for i, m in enumerate(messages) if m["id"] == message_id)
    before = [m for m in messages[:idx] if m["role"] in ("user", "assistant")]
    if not before or before[-1]["role"] != "user":
        raise DatasetError("Не найден вопрос, на который дан этот ответ")
    question_msg = before[-1]
    # В истории — исправленные версии прошлых ответов, если пользователь их правил
    history = [{"role": m["role"], "content": m.get("corrected") or m["content"]} for m in before[:-1]][-HISTORY_MESSAGES:]

    settings = settings_store.get_all()
    persona = personas_repo.get_persona(row["persona_id"]) or personas_repo.fallback_persona()
    system = build_system_prompt(settings, persona, row["model"] or settings["default_model"])
    # {date} — дата самого ответа, а не дата экспорта
    created = datetime.fromisoformat(row["created_at"]).astimezone()
    system = system.replace(today_text(), today_text(created))

    extras = json.loads(row["extras"]) if row["extras"] else {}
    question = question_msg["content"]
    strip = False
    sources = extras.get("sources") or []
    if sources:
        chunks = kb_store.get_chunks([s["chunk_id"] for s in sources])
        if len(chunks) == len(sources):  # все фрагменты на месте — кладём их в вопрос, как видела модель
            question = augment_question(question, [chunks[s["chunk_id"]] for s in sources])
        else:
            strip = True  # документы удалены — ссылки [1], [2] из ответа придётся вырезать
    return {
        "conversation_id": conv_id, "system_prompt": system, "history": history, "question": question,
        "answer": row["content"], "used_tools": bool(extras.get("tools")), "strip_citations": strip,
        "model": row["model"], "persona": persona["name"],
    }


# ---------- изменения ----------


def get_by_message(message_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM dataset_examples WHERE message_id = ?", (message_id,)).fetchone()
    return _to_dict(row) if row else None


def get_example(example_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM dataset_examples WHERE id = ?", (example_id,)).fetchone()
    return _to_dict(row) if row else None


def _ensure(message_id: int) -> dict:
    """Пример для ответа — существующий или новый (со снимком)."""
    existing = get_by_message(message_id)
    if existing:
        return existing
    snap = build_snapshot(message_id)
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO dataset_examples
               (message_id, conversation_id, system_prompt, history, question, answer, used_tools,
                strip_citations, model, persona, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (message_id, snap["conversation_id"], snap["system_prompt"], json.dumps(snap["history"], ensure_ascii=False),
             snap["question"], snap["answer"], int(snap["used_tools"]), int(snap["strip_citations"]),
             snap["model"], snap["persona"], now, now),
        )
    return get_example(cur.lastrowid)


def _cleanup(example: dict) -> dict | None:
    """Пример без оценки и без исправления больше не нужен — удаляем."""
    if example["rating"] == 0 and not example["corrected"]:
        delete_example(example["id"])
        return None
    return example


def set_rating(message_id: int, rating: int) -> dict | None:
    if rating not in (-1, 0, 1):
        raise DatasetError("Оценка: -1, 0 или 1")
    if rating == 0 and get_by_message(message_id) is None:
        return None
    example = _ensure(message_id)
    with get_conn() as conn:
        conn.execute("UPDATE dataset_examples SET rating = ?, updated_at = ? WHERE id = ?", (rating, _now(), example["id"]))
    result = _cleanup(get_example(example["id"]))
    export_files()
    return result


def set_correction(message_id: int, corrected: str | None) -> dict | None:
    corrected = (corrected or "").strip() or None
    if corrected is None and get_by_message(message_id) is None:
        return None
    example = _ensure(message_id)
    if corrected and corrected == example["answer"].strip():
        corrected = None  # «исправили» на то же самое — это не исправление
    _update(example["id"], corrected=corrected)
    result = _cleanup(get_example(example["id"]))
    export_files()
    return result


def _update(example_id: int, **fields) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)  # ключи — только наши, из кода
    with get_conn() as conn:
        conn.execute(f"UPDATE dataset_examples SET {sets}, updated_at = ? WHERE id = ?",
                     (*fields.values(), _now(), example_id))


def update_example(example_id: int, *, included: bool | None = None, corrected: str | None = None,
                   question: str | None = None) -> dict | None:
    """Правка со страницы «Датасет»: исключить/включить, поправить ответ или вопрос."""
    if get_example(example_id) is None:
        return None
    fields = {}
    if included is not None:
        fields["included"] = int(included)
    if corrected is not None:
        fields["corrected"] = corrected.strip() or None
    if question is not None:
        if not question.strip():
            raise DatasetError("Вопрос не может быть пустым")
        fields["question"] = question.strip()
    if fields:
        _update(example_id, **fields)
    export_files()
    return get_example(example_id)


def delete_example(example_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM dataset_examples WHERE id = ?", (example_id,))
    export_files()
    return cur.rowcount > 0


# ---------- чтение ----------


def list_examples(filter_: str = "all") -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM dataset_examples ORDER BY updated_at DESC, id DESC").fetchall()
    items = [_to_dict(r) for r in rows]
    filters = {
        "all": lambda e: True,
        "sft": lambda e: e["in_sft"],
        "good": lambda e: e["rating"] == 1,
        "bad": lambda e: e["rating"] == -1,
        "corrected": lambda e: bool(e["corrected"]),
        "excluded": lambda e: not e["in_sft"],
    }
    return [e for e in items if filters.get(filter_, filters["all"])(e)]


def stats() -> dict:
    items = list_examples()
    sft = [e for e in items if e["in_sft"]]
    tokens = sum(len(_target(e)) // 3 + len(e["question"]) // 3 for e in sft)
    return {
        "total": len(items), "in_sft": len(sft), "good": sum(e["rating"] == 1 for e in items),
        "bad": sum(e["rating"] == -1 for e in items), "corrected": sum(bool(e["corrected"]) for e in items),
        "dpo_pairs": sum(1 for e in items if e["corrected"] and e["included"] and not e["used_tools"]),
        "with_tools": sum(e["used_tools"] for e in items), "tokens": tokens, "target": TARGET_EXAMPLES,
    }


# ---------- экспорт ----------

CITATION_RE = re.compile(r"\s?\[\d+\]")


def _clean_answer(text: str, example: dict) -> str:
    return CITATION_RE.sub("", text) if example["strip_citations"] else text


def _target(example: dict) -> str:
    """Ответ, которому учим: исправленный, если есть, иначе исходный."""
    return _clean_answer(example["corrected"] or example["answer"], example)


def _prompt_messages(example: dict, include_system: bool) -> list[dict]:
    msgs = [{"role": "system", "content": example["system_prompt"]}] if include_system and example["system_prompt"] else []
    msgs += [{"role": m["role"], "content": _clean_answer(m["content"], example) if m["role"] == "assistant" else m["content"]}
             for m in example["history"]]
    msgs.append({"role": "user", "content": example["question"]})
    return msgs


def export_sft(*, include_system: bool = True, include_tools: bool = False) -> list[dict]:
    """Формат «messages» (как у OpenAI) — его понимают Unsloth, TRL и большинство инструментов."""
    return [{"messages": _prompt_messages(e, include_system) + [{"role": "assistant", "content": _target(e)}]}
            for e in reversed(list_examples()) if in_sft(e, include_tools=include_tools)]


def export_dpo(*, include_system: bool = True, include_tools: bool = False) -> list[dict]:
    """Пары предпочтений (формат TRL): chosen — исправленный ответ, rejected — исходный."""
    return [
        {"prompt": _prompt_messages(e, include_system),
         "chosen": [{"role": "assistant", "content": _clean_answer(e["corrected"], e)}],
         "rejected": [{"role": "assistant", "content": _clean_answer(e["answer"], e)}]}
        for e in reversed(list_examples())
        if e["corrected"] and e["included"] and (include_tools or not e["used_tools"])
    ]


def to_jsonl(rows: list[dict]) -> str:
    """JSON Lines: одна запись — одна строка. Так устроены почти все датасеты для обучения."""
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def dataset_dir():
    return env.data_dir / "dataset"


def export_files() -> dict:
    """Пересохраняет файлы датасета на диск после каждого изменения."""
    folder = dataset_dir()
    folder.mkdir(parents=True, exist_ok=True)
    paths = {"sft": folder / "train_sft.jsonl", "dpo": folder / "train_dpo.jsonl"}
    paths["sft"].write_text(to_jsonl(export_sft()), encoding="utf-8")
    paths["dpo"].write_text(to_jsonl(export_dpo()), encoding="utf-8")
    return {k: str(v) for k, v in paths.items()}
