"""
Песочница для Python-кода без Docker.

Как устроено:
  1. Код запускается ОТДЕЛЬНЫМ процессом Python во временной папке. Если код зависнет
     или упадёт — сервер ассистента не пострадает, а процесс будет убит по таймауту.
  2. Перед кодом ставится «аудит-хук» (sys.addaudithook). Python сообщает ему о каждом
     опасном действии: открыть файл, подключиться к сети, запустить программу.
     Хук запрещает:
       * сеть (никаких отправок данных в интернет);
       * запуск других программ (subprocess, os.system);
       * чтение и запись файлов вне песочницы (кроме самой библиотеки Python);
       * модуль ctypes — через него можно обойти любые проверки.
     Снять аудит-хук из Python-кода нельзя.
  3. На Linux/macOS дополнительно ограничиваем память и процессорное время (resource).
  4. Вывод обрезается, временная папка удаляется.

ЧЕСТНО: это защита от случайностей и наивного кода, а не от целенаправленной атаки
(например, через уязвимости самого интерпретатора). Поэтому по умолчанию запуск кода
подтверждает пользователь. Настоящая изоляция — Docker или виртуальная машина.
"""

import asyncio
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

MAX_OUTPUT_CHARS = 8_000
MAX_CODE_CHARS = 20_000
MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024  # 1 ГБ (только Linux/macOS)

# Этот код выполняется в дочернем процессе ДО кода пользователя.
# Код пользователя приходит через stdin, чтобы не возиться с экранированием.
RUNNER = r'''
import os, sys

_SANDBOX = os.path.realpath(os.getcwd())
_ALLOWED_READ = [os.path.realpath(p) for p in {sys.prefix, sys.base_prefix, sys.exec_prefix} if p]
_BLOCKED_EVENTS = {
    "socket.connect", "socket.bind", "socket.sendto", "socket.getaddrinfo",
    "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile",
    "os.fork", "os.forkpty", "os.kill", "pty.spawn", "winreg.OpenKey", "winreg.CreateKey",
}
_PATH_EVENTS = {"os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.chown",
                "shutil.rmtree", "shutil.move", "shutil.copyfile", "os.truncate", "os.symlink", "os.link"}
_BLOCKED_IMPORTS = {"ctypes", "_ctypes", "cffi"}

def _inside(path, roots):
    try:
        real = os.path.realpath(os.fsdecode(path))
    except Exception:
        return False
    return any(real == r or real.startswith(r + os.sep) for r in roots)

def _hook(event, args):
    if event in _BLOCKED_EVENTS:
        raise PermissionError(f"Песочница: действие запрещено ({event})")
    if event == "import" and args and str(args[0]).split(".")[0] in _BLOCKED_IMPORTS:
        raise ImportError(f"Песочница: модуль {args[0]} запрещён")
    if event == "open" and args and isinstance(args[0], (str, bytes, os.PathLike)):
        path, mode = args[0], (args[1] or "r") if len(args) > 1 else "r"
        writing = any(c in str(mode) for c in "wax+")
        if not _inside(path, [_SANDBOX] + ([] if writing else _ALLOWED_READ)):
            raise PermissionError(f"Песочница: доступ к файлу запрещён: {os.fsdecode(path)}")
    if event in _PATH_EVENTS:
        for p in args[:2]:
            if isinstance(p, (str, bytes, os.PathLike)) and not _inside(p, [_SANDBOX]):
                raise PermissionError(f"Песочница: изменять файлы вне песочницы нельзя ({event})")

_code = sys.stdin.read()
sys.addaudithook(_hook)   # с этого момента снять проверки уже нельзя
del _hook
exec(compile(_code, "<код>", "exec"), {"__name__": "__main__"})
'''


def _limit_resources(cpu_seconds: int):
    """Вызывается в дочернем процессе перед запуском (только Linux/macOS)."""
    def apply():
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (50 * 1024 * 1024, 50 * 1024 * 1024))
    return apply


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n… (вывод обрезан, всего {len(text)} символов)"


def _run_blocking(code: str, timeout: float, holder: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="jarvis-sandbox-") as tmp:
        env = {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TEMP": tmp, "TMP": tmp, "TMPDIR": tmp, "HOME": tmp,
            "MPLBACKEND": "Agg",  # если есть matplotlib — рисовать в файл, без окон
        }
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]  # без неё Python на Windows не стартует
        kwargs = {}
        if os.name != "nt":
            kwargs["preexec_fn"] = _limit_resources(int(timeout) + 1)
        else:
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # без всплывающего окна консоли
        started = time.monotonic()
        proc = subprocess.Popen(
            [sys.executable, "-I", "-c", RUNNER],  # -I: изолированный режим, без пользовательских модулей
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=tmp, env=env, **kwargs,
        )
        holder["proc"] = proc
        timed_out = False
        try:
            out, err = proc.communicate(code.encode("utf-8"), timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            timed_out = True
        duration = round(time.monotonic() - started, 2)
        files = [{"name": p.name, "size": p.stat().st_size} for p in Path(tmp).iterdir() if p.is_file()]
        return {
            "stdout": _truncate(out.decode("utf-8", errors="replace")),
            "stderr": _truncate(err.decode("utf-8", errors="replace")),
            "exit_code": proc.returncode,
            "timed_out": timed_out,
            "duration": duration,
            "files": files,  # что код создал в песочнице (сама папка потом удаляется)
        }


async def run_python(code: str, *, timeout: float = 10) -> dict:
    """Запускает код и ждёт результат. Если ответ остановили («Стоп») — процесс убивается."""
    if len(code) > MAX_CODE_CHARS:
        raise ValueError("Слишком длинный код")
    holder: dict = {}
    loop = asyncio.get_running_loop()
    done = loop.create_future()

    def worker():
        try:
            result = _run_blocking(code, timeout, holder)
            loop.call_soon_threadsafe(lambda: done.done() or done.set_result(result))
        except Exception as e:  # noqa: BLE001
            loop.call_soon_threadsafe(lambda: done.done() or done.set_exception(e))

    # Отдельный поток, а не asyncio-подпроцесс: так работает на любом цикле событий Windows
    threading.Thread(target=worker, daemon=True).start()
    try:
        return await done
    except asyncio.CancelledError:
        proc = holder.get("proc")
        if proc and proc.poll() is None:
            proc.kill()
        raise
