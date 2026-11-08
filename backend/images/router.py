"""
HTTP API рисования.

  GET    /api/images/status            — установлен ли движок, модели, прогресс установки/скачивания/рисования
  POST   /api/images/install           — установить движок (PyTorch + diffusers): {reinstall?}
  POST   /api/images/download          — скачать модель: {model, mirror?}
  DELETE /api/images/models/{id}       — удалить скачанную модель
  POST   /api/images/generate          — нарисовать: {prompt, translate?, negative?, orientation?, count?, seed?, conversation_id?}
  POST   /api/images/cancel            — остановить рисование
  GET    /api/images/gallery           — все нарисованные картинки
  DELETE /api/images/{file_id}         — удалить картинку
"""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..chat import repository as chat_repo
from ..files import store as files_store
from ..settings import store as settings_store
from . import engine, service
from .catalog import MODELS
from .installer import installer

router = APIRouter(prefix="/api/images", tags=["images"])


class InstallBody(BaseModel):
    reinstall: bool = False


class DownloadBody(BaseModel):
    model: str
    mirror: str = "huggingface"


class GenerateBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=1500)
    translate: bool = True  # русский текст сначала переводится в английский промпт
    negative: str | None = Field(default=None, max_length=800)
    orientation: Literal["square", "portrait", "landscape"] = "square"
    count: int = Field(default=1, ge=1, le=4)
    seed: int | None = Field(default=None, ge=0, le=2 ** 32 - 1)
    conversation_id: str | None = None
    message_id: int | None = None  # «Ещё вариант» в чате: дописать картинки в карточку этого ответа
    tool_id: str | None = None


@router.get("/status")
def status():
    model = settings_store.get("image_model")
    return {
        "installed": engine.is_installed(),
        "fake": engine.FAKE,
        "cuda": engine.engine.cuda,
        "model": model,
        "models": [{"id": mid, **{k: v for k, v in info.items() if k in ("title", "size_gb", "recommended", "kind", "note")},
                    "downloaded": engine.is_downloaded(mid)} for mid, info in MODELS.items()],
        "install": installer.state,
        "download": engine.downloader.state,
        "progress": engine.engine.progress,
        "busy": engine.engine.busy(),
        "folder": str(engine.models_dir()),
    }


@router.post("/install", status_code=202)
def install(body: InstallBody):
    return installer.start(reinstall=body.reinstall)


@router.post("/download", status_code=202)
def download(body: DownloadBody):
    try:
        return engine.downloader.start(body.model, body.mirror)
    except engine.ImageError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.delete("/models/{model_id}", status_code=204)
def delete_model(model_id: str):
    if model_id not in MODELS or not engine.delete_model(model_id):
        raise HTTPException(status_code=404, detail="Модель не скачана")


@router.post("/generate")
async def generate(body: GenerateBody):
    if body.conversation_id and chat_repo.get_conversation(body.conversation_id) is None:
        raise HTTPException(status_code=404, detail="Диалог не найден")
    if engine.engine.busy():
        raise HTTPException(status_code=409, detail="Уже рисую другую картинку — подождите")
    prompt = await service.to_english(body.prompt) if body.translate else body.prompt
    try:
        result = await service.create(prompt, negative=body.negative, orientation=body.orientation, count=body.count,
                                      seed=body.seed, conversation_id=body.conversation_id, request=body.prompt)
        if body.message_id and body.tool_id:
            service.append_to_message(body.message_id, body.tool_id, result["images"])
        return result
    except engine.Cancelled as e:
        raise HTTPException(status_code=409, detail="Рисование остановлено") from e
    except engine.ImageError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.post("/cancel")
def cancel():
    engine.engine.cancel()
    return {"ok": True}


@router.get("/gallery")
def gallery():
    return {"items": service.gallery()}


@router.delete("/{file_id}", status_code=204)
def delete_image(file_id: str):
    record = files_store.get_file(file_id)
    if record is None or record["mime"] != "image/png" or record["kind"] != "generated":
        raise HTTPException(status_code=404, detail="Картинка не найдена")
    files_store.delete_file(file_id)
