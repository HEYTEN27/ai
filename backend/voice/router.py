"""
HTTP API голосового ввода.

  GET  /api/voice/status       — установлен ли Whisper, скачана ли модель
  POST /api/voice/transcribe   — распознать запись (multipart, поле audio) → {"text": ...}
"""

import asyncio
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..settings import store as settings_store
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
