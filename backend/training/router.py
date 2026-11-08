"""
HTTP API страницы «Обучение».

  GET  /api/training/status    — готов ли датасет, рекомендуемые настройки, есть ли qwen3:8b
  GET  /api/training/package   — скачать zip для Google Colab
  POST /api/training/import    — подключить обученную модель к Ollama (прогресс потоком SSE)
"""

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from ..llm import get_backend
from ..llm.ollama import OllamaBackend
from . import package
from .ollama_import import ImportError_, import_model, validate

router = APIRouter(prefix="/api/training", tags=["training"])


class ImportBody(BaseModel):
    path: str
    name: str = "jarvis-qwen3"
    kind: str = "gguf"  # gguf | adapter
    base_model: str = "qwen3:8b"
    quantize: bool = False  # сжать несжатый (f16) GGUF до Q4_K_M


def _ollama() -> OllamaBackend:
    backend = get_backend()
    if not isinstance(backend, OllamaBackend):
        raise HTTPException(status_code=400, detail="Подключение моделей работает только с Ollama")
    return backend


@router.get("/status")
async def status(system: bool = True):
    info = package.analyze(include_system=system)
    try:
        names = {m.name for m in await get_backend().list_models()}
    except Exception:  # noqa: BLE001 — Ollama выключена
        names = set()
    info["base_installed"] = "qwen3:8b" in names
    info["models"] = sorted(n for n in names if "jarvis" in n)  # уже подключённые дообученные модели
    return info


@router.get("/package")
def download_package(system: bool = True):
    data, info = package.build_zip(include_system=system)
    if not info["examples"]:
        raise HTTPException(status_code=400, detail="Датасет пуст — нечего обучать")
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="jarvis_colab_package.zip"'})


@router.post("/import")
async def import_endpoint(body: ImportBody):
    backend = _ollama()
    try:
        validate(body.path, body.name, body.kind)  # ошибки ввода — сразу, обычным ответом 422
    except ImportError_ as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    async def events():
        try:
            async for event in import_model(backend.client, path=body.path, name=body.name, kind=body.kind,
                                            base_model=body.base_model,
                                            quantize="q4_K_M" if body.quantize else None):
                yield f"event: progress\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
        except ImportError_ as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})
