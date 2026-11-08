"""
HTTP API датасета.

  POST   /api/dataset/feedback        — 👍/👎 под ответом: {message_id, rating: 1 | -1 | 0}
  POST   /api/dataset/correct         — «Исправить ответ»: {message_id, corrected}
  GET    /api/dataset?filter=         — примеры и сводка
  PATCH  /api/dataset/{id}            — исключить/включить, поправить ответ или вопрос
  DELETE /api/dataset/{id}            — удалить пример
  GET    /api/dataset/export?format=  — скачать JSONL (sft | dpo)
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import store

router = APIRouter(prefix="/api/dataset", tags=["dataset"])


class FeedbackBody(BaseModel):
    message_id: int
    rating: int


class CorrectBody(BaseModel):
    message_id: int
    corrected: str | None = Field(default=None, max_length=50_000)


class ExampleUpdate(BaseModel):
    included: bool | None = None
    corrected: str | None = Field(default=None, max_length=50_000)
    question: str | None = Field(default=None, max_length=50_000)


def _call(fn, *args):
    try:
        return fn(*args)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except store.DatasetError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/feedback")
def feedback(body: FeedbackBody):
    example = _call(store.set_rating, body.message_id, body.rating)
    return {"example": example, "stats": store.stats()}


@router.post("/correct")
def correct(body: CorrectBody):
    example = _call(store.set_correction, body.message_id, body.corrected)
    return {"example": example, "stats": store.stats()}


@router.get("")
def list_examples(filter: str = "all"):
    files = {"sft": str(store.dataset_dir() / "train_sft.jsonl"), "dpo": str(store.dataset_dir() / "train_dpo.jsonl")}
    return {"items": store.list_examples(filter), "stats": store.stats(), "files": files}


@router.patch("/{example_id}")
def update_example(example_id: int, body: ExampleUpdate):
    example = _call(lambda: store.update_example(
        example_id, included=body.included, corrected=body.corrected, question=body.question))
    if example is None:
        raise HTTPException(status_code=404, detail="Пример не найден")
    return example


@router.delete("/{example_id}", status_code=204)
def delete_example(example_id: int):
    if not store.delete_example(example_id):
        raise HTTPException(status_code=404, detail="Пример не найден")


@router.get("/export")
def export(format: str = "sft", system: bool = True, tools: bool = False):
    if format not in ("sft", "dpo"):
        raise HTTPException(status_code=422, detail="Формат: sft или dpo")
    rows = (store.export_sft if format == "sft" else store.export_dpo)(include_system=system, include_tools=tools)
    return Response(
        store.to_jsonl(rows),
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="jarvis_{format}.jsonl"'},
    )
