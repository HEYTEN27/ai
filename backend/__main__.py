"""
Запуск сервера командой:  python -m backend
С автоматическим открытием браузера:  python -m backend --open

Адрес и порт берутся из настроек (по умолчанию http://127.0.0.1:8000).
"""

import argparse
import threading
import webbrowser

import uvicorn

from .config import settings

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Локальный ИИ-ассистент")
    parser.add_argument("--open", action="store_true", help="открыть интерфейс в браузере после запуска")
    args = parser.parse_args()

    url = f"http://{settings.host}:{settings.port}"
    print(f"Ассистент запускается: {url}  (остановить — Ctrl+C)")
    if args.open:
        # Открываем браузер через 1,5 секунды — к этому моменту сервер уже слушает порт
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    uvicorn.run("backend.main:app", host=settings.host, port=settings.port)
