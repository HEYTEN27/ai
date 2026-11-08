"""
Сервер ассистента для браузерных проверок голосового ввода.

Модель Whisper в тестах не скачиваем, поэтому распознаватель — заглушка. Но запись из
браузера она декодирует НАСТОЯЩИМ decode_audio: так проверяется весь путь
«MediaRecorder в Chrome → webm/opus → сервер → массив 16 кГц для Whisper».

Запуск: DATA_DIR=/tmp/e2e python tests/e2e/serve_fake_voice.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import uvicorn  # noqa: E402

from backend.voice import transcriber as voice  # noqa: E402


class DecodingFakeTranscriber:
    loaded_size = None

    def transcribe(self, path, *, size, language):
        audio = voice.decode_audio(Path(path))  # настоящее декодирование записи из браузера
        seconds = len(audio) / 16000
        if seconds < 0.1:
            raise voice.VoiceError("Запись слишком короткая")
        self.loaded_size = size
        return {"text": f"Проверка голоса ({seconds:.1f} с)", "language": language or "ru",
                "duration": round(seconds, 1), "seconds": 0.1}


voice.set_transcriber(DecodingFakeTranscriber())

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, log_level="warning")
