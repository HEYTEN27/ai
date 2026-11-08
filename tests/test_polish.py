"""Тесты этапа 8: голосовой ввод, экспорт диалогов, запуск одной командой."""

import importlib.util
import io
import json
import time
import zipfile
from pathlib import Path
from urllib.parse import unquote

import pytest

from backend.config import PROJECT_ROOT
from backend.voice import transcriber as voice
from tests import fake_ollama
from tests.conftest import parse_sse

# ---------- голос ----------


class FakeTranscriber:
    """Заглушка вместо Whisper: модель в тестах не скачиваем."""

    def __init__(self, text="Привет, Джарвис", error=None):
        self.text, self.error, self.calls = text, error, []

    loaded_size = None

    def transcribe(self, path, *, size, language):
        self.calls.append({"size": size, "language": language, "bytes": Path(path).read_bytes()})
        if self.error:
            raise voice.VoiceError(self.error)
        return {"text": self.text, "language": language or "ru", "duration": 1.0, "seconds": 0.2}


@pytest.fixture
def fake_whisper():
    fake = FakeTranscriber()
    voice.set_transcriber(fake)
    yield fake
    voice.set_transcriber(None)


def test_voice_transcribe(client, fake_whisper):
    r = client.post("/api/voice/transcribe", files={"audio": ("voice.webm", b"\x1aE\xdf\xa3webm", "audio/webm")})
    assert r.status_code == 200 and r.json()["text"] == "Привет, Джарвис"
    assert fake_whisper.calls[0] == {"size": "small", "language": "ru", "bytes": b"\x1aE\xdf\xa3webm"}

    client.put("/api/settings", json={"voice_language": "auto", "whisper_model": "base"})
    client.post("/api/voice/transcribe", files={"audio": ("v.webm", b"x", "audio/webm")})
    assert fake_whisper.calls[-1]["language"] is None and fake_whisper.calls[-1]["size"] == "base"


def test_voice_errors(client, fake_whisper):
    assert client.post("/api/voice/transcribe", files={"audio": ("v.webm", b"", "audio/webm")}).status_code == 422
    fake_whisper.error = "Не удалось загрузить модель"
    r = client.post("/api/voice/transcribe", files={"audio": ("v.webm", b"x", "audio/webm")})
    assert r.status_code == 503 and "модель" in r.json()["detail"]
    client.put("/api/settings", json={"voice_enabled": False})
    assert client.post("/api/voice/transcribe", files={"audio": ("v.webm", b"x", "audio/webm")}).status_code == 400
    assert client.put("/api/settings", json={"whisper_model": "large"}).status_code == 422


def test_voice_status(client, fake_whisper):
    s = client.get("/api/voice/status").json()
    assert s["installed"] is True and s["model"] == "small" and s["downloaded"] is False
    assert set(s["models"]) == {"tiny", "base", "small", "medium"}


def _browser_like_recording(path: Path, seconds: float = 1.0):
    """Запись как из браузера: контейнер webm, кодек opus (как у MediaRecorder в Chrome)."""
    import math

    import av
    import numpy as np

    with av.open(str(path), "w", format="webm") as container:
        stream = container.add_stream("libopus", rate=48000)
        stream.layout = "mono"
        samples = (np.sin(2 * math.pi * 440 * np.arange(int(48000 * seconds)) / 48000) * 0.3).astype(np.float32)
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="flt", layout="mono")
        frame.rate = 48000
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)


def test_browser_audio_decodes_without_ffmpeg(tmp_path):
    """webm/opus из браузера декодируется библиотекой PyAV — отдельный ffmpeg не нужен."""
    path = tmp_path / "voice.webm"
    _browser_like_recording(path)
    audio = voice.decode_audio(path)  # Whisper ждёт 16 кГц моно, значения от -1 до 1
    assert 15000 < len(audio) < 17500 and 0.1 < abs(audio).max() <= 1.0


def test_transcriber_reports_missing_model(tmp_path, monkeypatch):
    """Без интернета и без скачанной модели — понятная ошибка, а не падение сервера."""
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setattr(voice, "models_dir", lambda: tmp_path / "whisper")
    audio = tmp_path / "v.webm"
    _browser_like_recording(audio, 0.3)
    with pytest.raises(voice.VoiceError, match="интернет"):
        voice.WhisperTranscriber().transcribe(audio, size="tiny", language="ru")


# ---------- экспорт ----------


def _rich_conversation(client) -> str:
    """Диалог с «размышлениями», инструментом, исправлением."""
    conv = client.post("/api/conversations", json={}).json()["id"]
    client.post(f"/api/conversations/{conv}/messages", json={"content": "Подумай и ответь", "think": True})
    client.post(f"/api/conversations/{conv}/messages", json={"content": "Посчитай 6*7"})
    first = [m for m in client.get(f"/api/conversations/{conv}").json()["messages"] if m["role"] == "assistant"][0]
    client.post("/api/dataset/correct", json={"message_id": first["id"], "corrected": "Исправленный ответ."})
    client.patch(f"/api/conversations/{conv}", json={"title": "Тест: экспорт/проверка"})
    return conv


def test_export_markdown(client):
    conv = _rich_conversation(client)
    r = client.get(f"/api/export/conversations/{conv}", params={"format": "md"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    disposition = r.headers["content-disposition"]
    assert disposition.startswith("attachment;") and "filename*=UTF-8''" in disposition
    assert unquote(disposition.split("''", 1)[1]).endswith("Тест- экспорт-проверка.md"), "символы : и / заменены"
    md = r.text
    assert md.startswith("# Тест: экспорт/проверка\n")
    assert "### 🧑 Вы" in md and "### 🤖 Джарвис · qwen3:8b" in md
    assert "<details><summary>Размышления</summary>" in md
    assert "Исправленный ответ.\n\n> ✏️ Ответ исправлен вами." in md
    assert "<details><summary>Исходный ответ модели</summary>" in md
    assert "🧮 Калькулятор: `6*7` = 42" in md


def test_export_json_and_all(client):
    conv = _rich_conversation(client)
    data = client.get(f"/api/export/conversations/{conv}", params={"format": "json"}).json()
    assert data["conversation"]["title"] == "Тест: экспорт/проверка"
    roles = [m["role"] for m in data["messages"]]
    assert roles == ["user", "assistant", "user", "assistant"]
    assert data["messages"][1]["corrected"] == "Исправленный ответ." and data["messages"][1]["thinking"]
    assert data["messages"][3]["extras"]["tools"][0]["name"] == "calculator"

    # Второй диалог с тем же названием — в архиве не должен затереть первый
    conv2 = client.post("/api/conversations", json={}).json()["id"]
    client.post(f"/api/conversations/{conv2}/messages", json={"content": "Привет"})
    client.patch(f"/api/conversations/{conv2}", json={"title": "Тест: экспорт/проверка"})
    r = client.get("/api/export/all")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    md_files = sorted(n for n in z.namelist() if n.startswith("markdown/"))
    assert len(md_files) == 2 and any(n.endswith("(2).md") for n in md_files)
    assert len(json.loads(z.read("conversations.json"))) == 2

    assert client.get("/api/export/conversations/nope").status_code == 404
    assert client.get(f"/api/export/conversations/{conv}", params={"format": "pdf"}).status_code == 422


# ---------- запуск одной командой ----------


def _launcher():
    spec = importlib.util.spec_from_file_location("launcher", PROJECT_ROOT / "scripts" / "launcher.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_launcher_requirements_stamp(tmp_path):
    lx = _launcher()
    req = tmp_path / "requirements.txt"
    req.write_text("fastapi\n")
    stamp = tmp_path / ".stamp"
    assert lx.needs_install(stamp, req), "метки нет — ставим"
    stamp.write_text(lx.requirements_hash(req))
    assert not lx.needs_install(stamp, req), "файл не менялся — pip не запускаем"
    req.write_text("fastapi\nnumpy\n")
    assert lx.needs_install(stamp, req), "файл изменился — ставим снова"


def test_launcher_models_and_questions(monkeypatch):
    lx = _launcher()
    installed = {"qwen3:8b", "bge-m3:latest", "bge-m3"}
    assert lx.missing(["qwen3:8b", "llama3.1:8b", "bge-m3"], installed) == ["llama3.1:8b"]
    assert lx.ask("?", default=False, assume_yes=True) is True
    monkeypatch.setattr("sys.stdin", io.StringIO(""))  # не терминал (двойной клик без консоли) — ответ по умолчанию
    assert lx.ask("?", default=True, assume_yes=False) is True and lx.ask("?", default=False, assume_yes=False) is False


def test_launcher_against_live_servers(live_servers, monkeypatch, tmp_path):  # noqa: F811
    """Проверки Ollama и «уже запущен» — на живом эмуляторе Ollama и живом сервере ассистента."""
    lx = _launcher()
    base = live_servers
    assert lx.app_running(base) is True
    host, port = base.removeprefix("http://").split(":")
    assert lx.port_in_use(host, int(port)) is True

    from backend.llm import get_backend

    ollama_url = get_backend().base_url
    assert lx.ollama_version(ollama_url) == "0.34.4-fake"
    assert lx.app_running(ollama_url) is False, "на этом порту не наш ассистент"
    assert {"qwen3:8b", "bge-m3"} <= lx.installed_models(ollama_url)

    # Нет основной модели → предлагаем скачать; от bge-m3 отказались → больше не спрашиваем
    pulled = []
    monkeypatch.setattr(lx, "pull", lambda m: pulled.append(m) or True)
    monkeypatch.setattr(lx, "preferences_path", lambda: tmp_path / "launcher.json")
    monkeypatch.setattr(lx, "installed_models", lambda url: {"llama3.1:8b"})
    answers = iter([True, False])
    monkeypatch.setattr(lx, "ask", lambda q, default, assume_yes: next(answers))

    class S:
        ollama_url = get_backend().base_url
        default_model = "qwen3:8b"

    lx.check_ollama_and_models(S, lx.parse_args([]))
    assert pulled == ["qwen3:8b"]
    assert json.loads((tmp_path / "launcher.json").read_text())["skipped_models"] == ["bge-m3"]
    monkeypatch.setattr(lx, "ask", lambda *a: pytest.fail("про bge-m3 спрашивать второй раз не надо"))
    monkeypatch.setattr(lx, "installed_models", lambda url: {"qwen3:8b"})
    lx.check_ollama_and_models(S, lx.parse_args([]))


def test_launcher_without_ollama(monkeypatch):
    lx = _launcher()
    monkeypatch.setattr(lx.shutil, "which", lambda name: None)
    monkeypatch.setattr(lx.os, "name", "posix")
    assert lx.find_ollama() is None
    assert lx.start_ollama("http://127.0.0.1:1", wait_seconds=0.1) is False
    assert lx.ollama_version("http://127.0.0.1:1") is None


from tests.test_stop import live_servers  # noqa: E402,F401 — фикстура живых серверов
