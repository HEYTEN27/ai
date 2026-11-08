"""
HTTP API голосового ввода.

  GET  /api/voice/status       — установлен ли Whisper, скачана ли модель
  POST /api/voice/transcribe   — распознать запись (multipart, поле audio) → {"text": ...}

Нейроголос (этап 12):
  GET    /api/voice/tts                — установлен ли Piper, какие голоса скачаны, прогресс скачивания
  POST   /api/voice/tts                — текст → WAV: {text, voice?, rate?}
  POST   /api/voice/tts/download       — скачать голос: {voice, mirror?}
  DELETE /api/voice/tts/voices/{voice} — удалить скачанный голос
"""

import asyncio
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..settings import store as settings_store
from . import tts
from .transcriber import MODELS, VoiceError, get_transcriber, is_downloaded, is_installed

router = APIRouter(prefix="/api/voice", tags=["voice"])

MAX_AUDIO_BYTES = 25 * 1024 * 1024  # ~25 минут opus — с большим запасом


@router.get("/status")
def status():
    s = settings_store.get_all()
    size = s["whisper_model"]
    return {
        "enabled": s["voice_enabled"],
        "installed": is_installed(),
        "model": size,
        "models": MODELS,
        "downloaded": is_downloaded(size),
        "loaded": get_transcriber().loaded_size == size,
        "language": s["voice_language"],
    }


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    s = settings_store.get_all()
    if not s["voice_enabled"]:
        raise HTTPException(status_code=400, detail="Голосовой ввод выключен в настройках")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=422, detail="Пустая запись")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=422, detail="Слишком длинная запись")
    suffix = Path(audio.filename or "voice.webm").suffix or ".webm"
    # Записываем во временный файл: декодеру нужен файл, а не байты в памяти
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = Path(tmp.name)
    try:
        language = None if s["voice_language"] == "auto" else s["voice_language"]
        return await asyncio.to_thread(get_transcriber().transcribe, path, size=s["whisper_model"], language=language)
    except VoiceError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    finally:
        path.unlink(missing_ok=True)


# ---------- нейроголос ----------


class SpeakBody(BaseModel):
    text: str = Field(min_length=1, max_length=tts.MAX_TEXT_CHARS)
    voice: str | None = None  # не указан — из настроек
    rate: float | None = Field(default=None, ge=0.5, le=2.0)


class DownloadBody(BaseModel):
    voice: str
    mirror: str = "huggingface"


@router.get("/tts")
def tts_status():
    s = settings_store.get_all()
    return {
        "installed": tts.is_installed(),
        "voice": s["tts_neural_voice"],
        "voices": [{"id": vid, **info, "downloaded": tts.is_downloaded(vid)} for vid, info in tts.VOICES.items()],
        "download": tts.downloader.state,
        "mirrors": list(tts.MIRRORS),
        "folder": str(tts.voices_dir()),
    }


@router.post("/tts")
async def tts_speak(body: SpeakBody):
    s = settings_store.get_all()
    voice = body.voice or s["tts_neural_voice"]
    if voice not in tts.VOICES:
        raise HTTPException(status_code=422, detail="Такого голоса нет")
    try:
        # Синтез занимает десятки миллисекунд процессора — в потоке, чтобы не тормозить стриминг ответа
        wav = await asyncio.to_thread(tts.engine.synthesize, body.text, voice, body.rate or s["tts_rate"])
    except tts.TTSError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return Response(wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.post("/tts/download", status_code=202)
async def tts_download(body: DownloadBody):
    # async — фоновое скачивание запускается в цикле событий сервера (в синхронном обработчике его нет)
    if body.mirror not in tts.MIRRORS:
        raise HTTPException(status_code=422, detail="Неизвестное зеркало")
    try:
        return tts.downloader.start(body.voice, tts.MIRRORS[body.mirror])
    except tts.TTSError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.delete("/tts/voices/{voice}", status_code=204)
def tts_delete(voice: str):
    if voice not in tts.VOICES or not tts.delete_voice(voice):
        raise HTTPException(status_code=404, detail="Голос не скачан")
