"""
Запуск ассистента одной командой (его вызывают start.bat и start.sh).

Что делает по порядку:
  1. Ставит/обновляет Python-пакеты — только если изменился requirements.txt
     (запоминаем его контрольную сумму, чтобы не ждать pip при каждом запуске).
  2. Если ассистент уже запущен — просто открывает браузер.
  3. Проверяет Ollama: не запущена — запускает сама; не установлена — подсказывает, где взять.
  4. Проверяет модели: нет qwen3:8b — предлагает скачать (ollama pull), bge-m3 — по желанию.
  5. Запускает сервер и открывает интерфейс в браузере.

До шага 5 используется только стандартная библиотека Python — скрипт работает ещё до
установки пакетов. Флаги: --yes (со всем соглашаться), --no-browser, --skip-checks.
"""

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "requirements.txt"
OLLAMA_DOWNLOAD = "https://ollama.com/download"
OPTIONAL_MODELS = {"bge-m3": "≈ 1,2 ГБ — поиск по смыслу в памяти и базе знаний (работает на процессоре)"}
MODEL_SIZES = {"qwen3:8b": "≈ 5,2 ГБ", "llama3.1:8b": "≈ 4,9 ГБ"}


def say(text: str = "") -> None:
    print(text, flush=True)


# ---------- 1. пакеты Python ----------


def requirements_hash(path: Path = REQUIREMENTS) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp_path() -> Path:
    # Метка живёт внутри виртуального окружения: новое окружение — пакеты поставятся заново
    return Path(sys.prefix) / ".requirements.sha256"


def needs_install(stamp: Path | None = None, req: Path = REQUIREMENTS) -> bool:
    stamp = stamp or stamp_path()
    return not stamp.exists() or stamp.read_text().strip() != requirements_hash(req)


def ensure_pip() -> bool:
    """В некоторых окружениях pip нет (например, создано через uv) — ставим встроенным ensurepip."""
    import importlib.util

    if importlib.util.find_spec("pip") is not None:
        return True
    say("   pip не найден — устанавливаю встроенным ensurepip…")
    return subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"], stdout=subprocess.DEVNULL).returncode == 0


def install_requirements(stamp: Path | None = None) -> bool:
    say("📦 Устанавливаю пакеты Python (первый раз — несколько минут)…")
    if not ensure_pip():
        say("❌ Не удалось установить pip. Пересоздайте окружение: удалите папку .venv и запустите start ещё раз.")
        return False
    result = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check",
                             "-r", str(REQUIREMENTS)])
    if result.returncode != 0:
        say("❌ Не удалось установить пакеты. Проверьте интернет и запустите ещё раз.")
        return False
    (stamp or stamp_path()).write_text(requirements_hash())
    return True


# ---------- HTTP без сторонних библиотек ----------


def get_json(url: str, timeout: float = 2.0):
    """GET → JSON, или None, если сервер не отвечает."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def port_in_use(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def app_running(base_url: str) -> bool:
    """Отвечает ли на этом адресе именно наш ассистент."""
    data = get_json(f"{base_url}/api/health")
    return isinstance(data, dict) and "backend" in data


# ---------- 3. Ollama ----------


def ollama_version(url: str) -> str | None:
    data = get_json(f"{url}/api/version")
    return data.get("version") if isinstance(data, dict) else None


def find_ollama() -> list[str] | None:
    """Команда запуска Ollama. На Windows лучше запустить приложение (значок в трее)."""
    if os.name == "nt":
        app = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama app.exe"
        if app.exists():
            return [str(app)]
    exe = shutil.which("ollama")
    if exe:
        return [exe, "serve"]
    if os.name == "nt":
        exe_path = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
        if exe_path.exists():
            return [str(exe_path), "serve"]
    return None


def start_ollama(url: str, wait_seconds: float = 20) -> bool:
    command = find_ollama()
    if command is None:
        return False
    kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True  # Ollama продолжит работать после закрытия терминала
    subprocess.Popen(command, **kwargs)
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if ollama_version(url):
            return True
        time.sleep(0.5)
    return False


def installed_models(url: str) -> set[str]:
    data = get_json(f"{url}/api/tags") or {}
    names = set()
    for m in data.get("models", []):
        names.add(m["name"])
        if m["name"].endswith(":latest"):
            names.add(m["name"][: -len(":latest")])  # «bge-m3:latest» = «bge-m3»
    return names


def missing(models: list[str], installed: set[str]) -> list[str]:
    return [m for m in models if m not in installed and f"{m}:latest" not in installed]


def ask(question: str, default: bool, assume_yes: bool) -> bool:
    if assume_yes:
        return True
    if not sys.stdin or not sys.stdin.isatty():
        return default
    hint = "[Д/н]" if default else "[д/Н]"
    answer = input(f"{question} {hint} ").strip().lower()
    if not answer:
        return default
    return answer[0] in ("д", "y", "l")  # «l» — если забыли переключить раскладку («д» на английской)


def pull(model: str) -> bool:
    exe = shutil.which("ollama")
    if not exe:
        say(f"   Скачайте вручную: ollama pull {model}")
        return False
    return subprocess.run([exe, "pull", model]).returncode == 0


# ---------- запуск ----------


def preferences_path() -> Path:
    from backend.config import settings

    return settings.data_dir / "launcher.json"


def load_prefs() -> dict:
    try:
        return json.loads(preferences_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_prefs(prefs: dict) -> None:
    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(prefs, ensure_ascii=False, indent=2), encoding="utf-8")


def check_ollama_and_models(settings, args) -> None:
    url = settings.ollama_url
    version = ollama_version(url)
    if version:
        say(f"✅ Ollama {version} работает")
    else:
        say("⏳ Ollama не запущена — запускаю…")
        if start_ollama(url):
            say(f"✅ Ollama {ollama_version(url)} запущена")
        elif find_ollama() is None:
            say(f"⚠️  Ollama не найдена. Установите её: {OLLAMA_DOWNLOAD} — и запустите start ещё раз.")
            say("   Интерфейс откроется, но отвечать будет некому.")
            return
        else:
            say("⚠️  Ollama не ответила за 20 секунд. Запустите её вручную (значок в трее) — интерфейс подхватит.")
            return

    installed = installed_models(url)
    prefs = load_prefs()
    skipped = set(prefs.get("skipped_models", []))
    for model in missing([settings.default_model], installed):
        size = MODEL_SIZES.get(model, "несколько гигабайт")
        if ask(f"📥 Нет основной модели {model} ({size}). Скачать сейчас?", True, args.yes):
            pull(model)
        else:
            say(f"   Без модели чат работать не будет. Позже: ollama pull {model}")
    for model, why in OPTIONAL_MODELS.items():
        if model in skipped or not missing([model], installed):
            continue
        if ask(f"📥 Скачать {model}? ({why})", False, args.yes):
            pull(model)
        else:
            skipped.add(model)  # больше не спрашиваем
            say(f"   Хорошо, не буду спрашивать. Скачать позже: ollama pull {model}")
    prefs["skipped_models"] = sorted(skipped)
    save_prefs(prefs)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Запуск локального ассистента")
    p.add_argument("--yes", action="store_true", help="соглашаться на установку и скачивание без вопросов")
    p.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    p.add_argument("--skip-checks", action="store_true", help="не проверять Ollama и модели")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    say("🤖 Запуск локального ассистента")
    if sys.version_info < (3, 11):
        say(f"❌ Нужен Python 3.11 или 3.12, а у вас {sys.version.split()[0]}. Установите с python.org.")
        return 1

    if needs_install() and not install_requirements():
        return 1

    from backend.config import settings  # только стандартная библиотека — можно до uvicorn

    base_url = f"http://{settings.host}:{settings.port}"
    if app_running(base_url):
        say(f"✅ Ассистент уже запущен: {base_url}")
        if not args.no_browser:
            webbrowser.open(base_url)
        return 0
    if port_in_use(settings.host, settings.port):
        say(f"❌ Порт {settings.port} занят другой программой. Укажите другой в файле .env: PORT=8001")
        return 1

    if not args.skip_checks and settings.llm_backend == "ollama":
        check_ollama_and_models(settings, args)

    import uvicorn

    say(f"\n🚀 Ассистент работает: {base_url}  (остановить — Ctrl+C или закрыть это окно)\n")
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, args=(base_url,)).start()
    uvicorn.run("backend.main:app", host=settings.host, port=settings.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
