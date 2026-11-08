"""
Установка движка рисования по кнопке: PyTorch с CUDA + diffusers (≈ 3 ГБ).

Почему не в requirements.txt: это самые тяжёлые пакеты проекта. Ставить их всем при каждом
запуске start.bat незачем — только тем, кто хочет рисовать. pip запускается тем же Python,
что и сервер (окружение .venv), в фоне; интерфейс показывает последние строки его вывода.
"""

import importlib
import os
import subprocess
import sys
import threading
import time

from .catalog import PACKAGES, TORCH_INDEX

FAKE = os.getenv("IMAGE_ENGINE") == "fake"
LOG_LINES = 12


class Installer:
    def __init__(self):
        self.state: dict | None = None
        self._thread: threading.Thread | None = None

    def busy(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def commands(self, reinstall: bool = False) -> list[list[str]]:
        pip = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"]
        torch = pip + (["--force-reinstall", "--no-deps"] if reinstall else []) + ["torch", "--index-url", TORCH_INDEX]
        return [torch, pip + PACKAGES]

    def start(self, reinstall: bool = False) -> dict:
        if self.busy():
            return self.state
        self.state = {"running": True, "step": 0, "steps": 2, "log": [], "error": None, "finished": False}
        self._thread = threading.Thread(target=self._run, args=(reinstall,), daemon=True)
        self._thread.start()
        return self.state

    def _log(self, line: str) -> None:
        line = line.rstrip()
        if line:
            self.state["log"] = (self.state["log"] + [line])[-LOG_LINES:]

    def _run(self, reinstall: bool) -> None:
        try:
            for n, cmd in enumerate(self.commands(reinstall), 1):
                self.state["step"] = n
                self._log("$ pip " + " ".join(cmd[4:]))
                if FAKE:  # в тестах ничего не ставим
                    time.sleep(0.2)
                    self._log("Successfully installed (заглушка)")
                    continue
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                        encoding="utf-8", errors="replace")
                for line in proc.stdout:
                    self._log(line)
                if proc.wait() != 0:
                    raise RuntimeError(f"pip завершился с кодом {proc.returncode}")
            importlib.invalidate_caches()  # чтобы find_spec увидел только что поставленные пакеты
        except Exception as e:  # noqa: BLE001
            self.state["error"] = (f"Установка не удалась: {e}. Проверьте интернет и место на диске (нужно ≈ 5 ГБ). "
                                   "Последние строки pip — выше.")
        finally:
            self.state["running"] = False
            self.state["finished"] = True


installer = Installer()
