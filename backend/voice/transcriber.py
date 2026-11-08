"""
Распознавание речи — faster-whisper на процессоре.

Почему так:
  * Whisper — открытая модель распознавания речи от OpenAI, хорошо понимает русский.
  * faster-whisper — та же модель, но в 4 раза быстрее (движок CTranslate2) и в формате int8.
  * Считаем на ПРОЦЕССОРЕ: видеопамять занята Qwen3 (её там впритык). На Ryzen 5 2600
    модель «small» распознаёт 10 секунд речи примерно за 3–5 секунд.
  * Не используем распознавание браузера (Web Speech API): Chrome отправляет звук в Google,
    а у нас всё должно работать офлайн.

Модель скачивается один раз при первом использовании (small ≈ 480 МБ) в data/models/whisper
и дальше работает без интернета. Звук из браузера (webm/opus) декодирует библиотека PyAV,
которая ставится вместе с faster-whisper, — отдельный ffmpeg не нужен.
"""

import os
import threading
import time
from pathlib import Path

from ..config import settings as env

MODELS = {  # размер скачивания — для подсказки в интерфейсе
    "tiny": "≈ 75 МБ, очень быстро, но с ошибками",
    "base": "≈ 145 МБ, быстро",
    "small": "≈ 480 МБ, оптимально для русского",
    "medium": "≈ 1,5 ГБ, точнее, но в 3 раза медленнее",
}


class VoiceError(Exception):
    pass


def decode_audio(path: Path, sampling_rate: int = 16000):
    """Звук из файла → массив чисел 16 кГц моно (такой ждёт Whisper).

    Делаем сами, а не через faster_whisper.decode_audio: в faster-whisper 1.2 он передаёт
    в PyAV параметр metadata_errors, которого нет в PyAV 14+, и падает. Наш вариант
    работает с любой версией PyAV.
    """
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=sampling_rate)
    parts = []
    with av.open(str(path), mode="r") as container:
        for frame in container.decode(audio=0):
            frame.pts = None  # иначе ресемплер может ругаться на метки времени из webm
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # «дослить» остаток из ресемплера
            parts.append(out.to_ndarray().reshape(-1))
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts).astype(np.float32) / 32768.0


def models_dir() -> Path:
    return env.data_dir / "models" / "whisper"


def is_installed() -> bool:
    """Установлен ли faster-whisper — БЕЗ импорта: он тянет CTranslate2 и onnxruntime и импортируется
    1–2 секунды, а статус запрашивается при каждой загрузке страницы."""
    import importlib.util

    return importlib.util.find_spec("faster_whisper") is not None


def is_downloaded(size: str) -> bool:
    """Скачана ли модель (huggingface_hub кладёт её в models--Systran--faster-whisper-<size>)."""
    folder = models_dir() / f"models--Systran--faster-whisper-{size}"
    return any(folder.rglob("model.bin")) if folder.exists() else False


class WhisperTranscriber:
    """Держит загруженную модель в памяти (~0,5 ГБ RAM для small) и распознаёт по одному файлу за раз."""

    def __init__(self):
        self._model = None
        self._size: str | None = None
        self._lock = threading.Lock()

    @property
    def loaded_size(self) -> str | None:
        return self._size if self._model is not None else None

    def _load(self, size: str):
        if self._model is not None and self._size == size:
            return self._model
        if not is_installed():
            raise VoiceError("Не установлен faster-whisper: pip install -r requirements.txt")
        from faster_whisper import WhisperModel

        try:
            self._model = WhisperModel(
                size, device="cpu", compute_type="int8",  # int8 — быстро и мало памяти на CPU
                cpu_threads=max(1, (os.cpu_count() or 4) // 2),  # половина потоков: остальное — чату
                download_root=str(models_dir()),
            )
        except Exception as e:  # noqa: BLE001 — чаще всего нет интернета при первом скачивании
            raise VoiceError(
                f"Не удалось загрузить модель распознавания «{size}»: {e}. "
                "При первом использовании нужен интернет — модель скачивается один раз."
            ) from e
        self._size = size
        return self._model

    def transcribe(self, path: Path, *, size: str, language: str | None) -> dict:
        """Блокирующая функция — вызывать через asyncio.to_thread."""
        with self._lock:  # одна запись за раз: две параллельные съели бы весь процессор
            try:
                audio = decode_audio(path)
            except Exception as e:  # noqa: BLE001 — битый или неподдерживаемый файл
                raise VoiceError(f"Не удалось прочитать запись: {e}") from e
            if len(audio) < 1600:  # меньше 0,1 секунды
                raise VoiceError("Запись слишком короткая — нажмите микрофон, скажите фразу и нажмите ещё раз")
            model = self._load(size)
            started = time.monotonic()
            try:
                segments, info = model.transcribe(
                    audio, language=language, beam_size=1,  # beam 1 — заметно быстрее, качество почти то же
                    vad_filter=True,  # отрезаем тишину в начале и конце — меньше «галлюцинаций» на паузах
                    condition_on_previous_text=False,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
            except Exception as e:  # noqa: BLE001 — битый или пустой файл
                raise VoiceError(f"Не удалось распознать запись: {e}") from e
            return {"text": text, "language": info.language, "duration": round(info.duration, 1),
                    "seconds": round(time.monotonic() - started, 1)}


_transcriber = None


def get_transcriber():
    global _transcriber
    if _transcriber is None:
        _transcriber = WhisperTranscriber()
    return _transcriber


def set_transcriber(t) -> None:
    """Подменить распознаватель (в тестах — заглушка без скачивания модели)."""
    global _transcriber
    _transcriber = t
