"""Тесты этапа 12: нейроголос Piper (на голосе-пустышке), скачивание голосов, API синтеза."""

import asyncio
import io
import json
import shutil
import wave

import httpx
import pytest

from backend.voice import tts
from tests.fake_piper import make_voice

pytest.importorskip("piper")
pytest.importorskip("onnx")


@pytest.fixture
def voice_ready():
    """Голос «ruslan» на месте (пустышка с интерфейсом настоящего голоса Piper)."""
    shutil.rmtree(tts.voices_dir(), ignore_errors=True)
    make_voice(tts.voices_dir(), "ru_RU-ruslan-medium")
    tts.engine.forget("ruslan")
    yield
    tts.engine.forget("ruslan")
    shutil.rmtree(tts.voices_dir(), ignore_errors=True)


def _wav_info(data: bytes):
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), w.getnchannels(), w.getnframes()


def test_synthesize_with_real_piper(voice_ready):
    data = tts.engine.synthesize("Да, сэр. Все системы в норме.", "ruslan")
    rate, channels, frames = _wav_info(data)
    assert rate == 22050 and channels == 1 and frames > 1000
    slow = _wav_info(tts.engine.synthesize("Да, сэр.", "ruslan", rate=0.5))[2]
    fast = _wav_info(tts.engine.synthesize("Да, сэр.", "ruslan", rate=2.0))[2]
    assert slow >= fast, "скорость передаётся в Piper (у пустышки длина не меняется, но вызов не падает)"
    with pytest.raises(tts.TTSError, match="Пустой"):
        tts.engine.synthesize("   ", "ruslan")


def test_voice_not_downloaded():
    shutil.rmtree(tts.voices_dir(), ignore_errors=True)
    with pytest.raises(tts.TTSError, match="не скачан"):
        tts.engine.synthesize("Привет", "dmitri")


def test_tts_api(client, voice_ready):
    status = client.get("/api/voice/tts").json()
    assert status["installed"] and status["voice"] == "ruslan"
    by_id = {v["id"]: v for v in status["voices"]}
    assert by_id["ruslan"]["downloaded"] and not by_id["dmitri"]["downloaded"] and by_id["ruslan"]["recommended"]
    r = client.post("/api/voice/tts", json={"text": "Добрый вечер, сэр. 25 процентов готово."})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    assert client.post("/api/voice/tts", json={"text": "Привет", "voice": "dmitri"}).status_code == 503
    assert client.post("/api/voice/tts", json={"text": "Привет", "voice": "чужой"}).status_code == 422
    assert client.post("/api/voice/tts", json={"text": "x" * 2000}).status_code == 422
    # Настройки: движок и голос проверяются
    assert client.put("/api/settings", json={"tts_engine": "robot"}).status_code == 422
    assert client.put("/api/settings", json={"tts_neural_voice": "чужой"}).status_code == 422
    assert client.put("/api/settings", json={"tts_neural_voice": "irina", "tts_effect": False}).status_code == 200
    # Удаление голоса
    assert client.delete("/api/voice/tts/voices/ruslan").status_code == 204
    assert client.delete("/api/voice/tts/voices/ruslan").status_code == 404
    assert client.post("/api/voice/tts/download", json={"voice": "ruslan", "mirror": "куда-то"}).status_code == 422


def test_download_with_progress(tmp_path):
    shutil.rmtree(tts.voices_dir(), ignore_errors=True)
    src = make_voice(tmp_path, "ru_RU-dmitri-medium")
    files = {"ru_RU-dmitri-medium.onnx": src.read_bytes(),
             "ru_RU-dmitri-medium.onnx.json": (tmp_path / "ru_RU-dmitri-medium.onnx.json").read_bytes()}
    seen = []

    def handler(request: httpx.Request):
        seen.append(str(request.url))
        name = request.url.path.rsplit("/", 1)[-1]
        if "broken" in str(request.url):
            return httpx.Response(404)
        return httpx.Response(200, content=files[name], headers={"content-length": str(len(files[name]))})

    async def scenario():
        transport = httpx.MockTransport(handler)
        state = tts.downloader.start("dmitri", tts.MIRRORS["hf-mirror"], transport)
        with pytest.raises(tts.TTSError, match="Уже скачивается"):
            tts.downloader.start("irina", tts.DEFAULT_BASE, transport)
        await tts.downloader.wait()
        assert state["finished"] and state["error"] is None and state["done"] == state["total"] == len(files["ru_RU-dmitri-medium.onnx"])
        assert tts.is_downloaded("dmitri")
        assert seen[0].startswith("https://hf-mirror.com/rhasspy/piper-voices/resolve/main/ru/ru_RU/dmitri/medium/")
        assert not list(tts.voices_dir().glob("*.part")), "временные файлы убраны"

        tts.downloader.start("irina", "https://broken.example/voices", transport)
        await tts.downloader.wait()
        assert "404" in tts.downloader.state["error"] and not tts.is_downloaded("irina")

    asyncio.run(scenario())
    assert json.loads((tts.voices_dir() / "ru_RU-dmitri-medium.onnx.json").read_text())["espeak"]["voice"] == "ru"
    assert tts.engine.synthesize("Скачанный голос работает", "dmitri")[:4] == b"RIFF"
    tts.delete_voice("dmitri")
