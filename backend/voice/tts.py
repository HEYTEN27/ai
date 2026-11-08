"""
Нейроголос (этап 12) — Piper, офлайн на процессоре.

Почему Piper:
  * Звучит заметно естественнее голосов Windows, а работает полностью без интернета.
  * Лёгкий: движок onnxruntime и голос ≈ 63 МБ; на Ryzen 5 2600 фраза синтезируется
    в 10–20 раз быстрее, чем звучит, — видеокарта не нужна (она занята Qwen3).
  * Русские голоса: Руслан, Дмитрий, Денис (мужские), Ирина (женский).

Чего Piper НЕ умеет и почему мы этого не делаем: клонировать чужой голос. Голос актёра
из фильма скопировать нельзя — это голос реального человека. «Дворецкого» делаем манерой:
спокойный мужской голос, чуть медленнее обычного, плюс лёгкий эффект в браузере.

Голос скачивается один раз (из HuggingFace или зеркала) в data/models/piper.
"""

import asyncio
import importlib.util
import io
import json
import os
import threading
import wave
from pathlib import Path

import httpx

from ..config import settings as env

DEFAULT_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
MIRRORS = {
    # PIPER_VOICES_URL в .env — свой адрес с голосами (например, папка на локальном сервере)
    "huggingface": os.getenv("PIPER_VOICES_URL") or DEFAULT_BASE,
    "hf-mirror": "https://hf-mirror.com/rhasspy/piper-voices/resolve/main",  # если HuggingFace не открывается
}

VOICES = {
    "ruslan": {"title": "Руслан — мужской, спокойный", "gender": "male", "size_mb": 63, "recommended": True},
    "dmitri": {"title": "Дмитрий — мужской", "gender": "male", "size_mb": 63},
    "denis": {"title": "Денис — мужской, выше", "gender": "male", "size_mb": 63},
    "irina": {"title": "Ирина — женский", "gender": "female", "size_mb": 63},
}
QUALITY = "medium"
BUTLER_PACE = 1.08  # чуть медленнее обычной речи — размеренно, «по-дворецки»
MAX_TEXT_CHARS = 1000  # одна-две фразы за запрос: браузер шлёт ответ по предложениям


class TTSError(Exception):
    """Понятная ошибка для интерфейса."""


def voices_dir() -> Path:
    return env.data_dir / "models" / "piper"


def file_name(voice: str) -> str:
    return f"ru_RU-{voice}-{QUALITY}.onnx"


def model_path(voice: str) -> Path:
    return voices_dir() / file_name(voice)


def is_installed() -> bool:
    # find_spec, а не import: импорт onnxruntime занимает время, а статус спрашивают часто
    return importlib.util.find_spec("piper") is not None


def is_downloaded(voice: str) -> bool:
    path = model_path(voice)
    return path.is_file() and Path(f"{path}.json").is_file()


def remote_urls(voice: str, base: str) -> list[tuple[str, Path]]:
    path = f"ru/ru_RU/{voice}/{QUALITY}/{file_name(voice)}"
    target = model_path(voice)
    return [(f"{base.rstrip('/')}/{path}.json", Path(f"{target}.json")), (f"{base.rstrip('/')}/{path}", target)]


# ---------- скачивание голоса (фоновое, с прогрессом) ----------


class Downloader:
    """Одно скачивание за раз. Прогресс читает интерфейс через GET /api/voice/tts."""

    def __init__(self):
        self.state: dict | None = None  # {voice, done, total, error, finished}
        self._task: asyncio.Task | None = None

    def start(self, voice: str, base: str, transport: httpx.AsyncBaseTransport | None = None) -> dict:
        if voice not in VOICES:
            raise TTSError("Такого голоса нет в списке")
        if self._task and not self._task.done():
            raise TTSError(f"Уже скачивается голос «{self.state['voice']}» — дождитесь окончания")
        state = {"voice": voice, "done": 0, "total": VOICES[voice]["size_mb"] * 1024 * 1024,
                 "error": None, "finished": False}
        self._task = asyncio.create_task(self._run(voice, base, transport))
        self.state = state  # только если задача запустилась — иначе не оставляем «вечное скачивание»
        return state

    async def wait(self) -> None:
        if self._task:
            await self._task

    async def _run(self, voice: str, base: str, transport) -> None:
        voices_dir().mkdir(parents=True, exist_ok=True)
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=60, transport=transport) as client:
                for url, target in remote_urls(voice, base):
                    part = target.with_name(target.name + ".part")  # недокачанный файл не примем за голос
                    async with client.stream("GET", url) as r:
                        if r.status_code != 200:
                            raise TTSError(f"Сервер ответил {r.status_code} на {url}")
                        if target.suffix == ".onnx" and r.headers.get("content-length"):
                            self.state["total"] = int(r.headers["content-length"])
                        with part.open("wb") as f:
                            async for chunk in r.aiter_bytes(256 * 1024):
                                f.write(chunk)
                                if target.suffix == ".onnx":
                                    self.state["done"] += len(chunk)
                    part.replace(target)
            json.loads(Path(f"{model_path(voice)}.json").read_text(encoding="utf-8"))  # проверка: настройки голоса читаются
        except (httpx.HTTPError, TTSError, OSError, json.JSONDecodeError) as e:
            for _, target in remote_urls(voice, base):
                target.unlink(missing_ok=True)
                target.with_name(target.name + ".part").unlink(missing_ok=True)
            hint = "" if isinstance(e, TTSError) else " Проверьте интернет или выберите зеркало hf-mirror."
            self.state["error"] = f"Не удалось скачать голос: {e}.{hint}"
        finally:
            self.state["finished"] = True


downloader = Downloader()


def delete_voice(voice: str) -> bool:
    found = False
    for path in (model_path(voice), Path(f"{model_path(voice)}.json")):
        if path.exists():
            path.unlink()
            found = True
    engine.forget(voice)
    return found


# ---------- синтез ----------


class Engine:
    """Держит в памяти один загруженный голос (≈ 100 МБ ОЗУ). Синтез — в потоке, под замком."""

    def __init__(self):
        self._lock = threading.Lock()
        self._voice = None
        self._name: str | None = None

    def forget(self, voice: str) -> None:
        with self._lock:
            if self._name == voice:
                self._voice, self._name = None, None

    def _load(self, voice: str):
        if self._name == voice and self._voice is not None:
            return self._voice
        if not is_installed():
            raise TTSError("Нейроголос не установлен. Перезапустите start.bat — он доустановит пакет piper-tts.")
        if not is_downloaded(voice):
            raise TTSError(f"Голос «{voice}» не скачан. ⚙ → «Голос и данные» → «Скачать».")
        from piper import PiperVoice

        self._voice = PiperVoice.load(model_path(voice))
        self._name = voice
        return self._voice

    def synthesize(self, text: str, voice: str, rate: float = 1.0) -> bytes:
        """Текст → WAV (16 бит, моно). rate — скорость из настроек (1.0 — обычная)."""
        text = " ".join(str(text or "").split())[:MAX_TEXT_CHARS]
        if not text:
            raise TTSError("Пустой текст")
        from piper import SynthesisConfig

        with self._lock:
            piper_voice = self._load(voice)
            # length_scale > 1 — медленнее. Скорость 1.0 у нас = размеренная речь дворецкого
            config = SynthesisConfig(length_scale=BUTLER_PACE / max(0.5, min(2.0, rate)))
            buf = io.BytesIO()
            try:
                with wave.open(buf, "wb") as wav:
                    piper_voice.synthesize_wav(text, wav, syn_config=config)
            except wave.Error as e:  # в тексте не нашлось ни одного звука — формат WAV так и не задан
                raise TTSError("Нечего произнести") from e
        data = buf.getvalue()
        if len(data) <= 44:  # только заголовок WAV — нечего произносить (например, одни знаки)
            raise TTSError("Нечего произнести")
        return data


engine = Engine()
