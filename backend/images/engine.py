"""
Движок рисования: скачивание моделей, загрузка в видеопамять, генерация, освобождение памяти.

Как делим 8 ГБ видеопамяти с языковой моделью:
  1. перед рисованием выгружаем Qwen3 из видеопамяти (Ollama: keep_alive = 0);
  2. переносим модель картинок на видеокарту и рисуем;
  3. переносим её обратно в ОЗУ и очищаем кэш CUDA — память свободна для чата.
Следующий ответ в чате будет на 5–10 секунд дольше: Ollama загрузит Qwen3 обратно.

Тяжёлые библиотеки (torch, diffusers) импортируются только внутри функций: без них
приложение работает как раньше, а установить их можно кнопкой (installer.py).

IMAGE_ENGINE=fake — движок-заглушка для тестов (рисует градиент с текстом промпта через Pillow).
"""

import asyncio
import hashlib
import importlib.util
import io
import json
import os
import random
import shutil
import threading
import time
from pathlib import Path

from ..config import settings as env
from .catalog import ALLOW, ALLOW_FULL, IGNORE, MODELS

FAKE = os.getenv("IMAGE_ENGINE") == "fake"
MARKER = ".complete"  # файл-метка «модель скачана целиком» (внутри — вариант весов)
MIRRORS = {"huggingface": "https://huggingface.co", "hf-mirror": "https://hf-mirror.com"}


class ImageError(Exception):
    """Понятная ошибка для интерфейса."""


class Cancelled(ImageError):
    pass


def models_dir() -> Path:
    return env.data_dir / "models" / "images"


def model_dir(model_id: str) -> Path:
    return models_dir() / model_id


def is_installed() -> bool:
    if FAKE:
        return True
    return importlib.util.find_spec("torch") is not None and importlib.util.find_spec("diffusers") is not None


def is_downloaded(model_id: str) -> bool:
    return (model_dir(model_id) / MARKER).is_file()


def _dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0


# ---------- скачивание модели ----------


class Downloader:
    def __init__(self):
        self.state: dict | None = None
        self._thread: threading.Thread | None = None

    def busy(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, model_id: str, mirror: str = "huggingface") -> dict:
        if model_id not in MODELS:
            raise ImageError("Такой модели нет в списке")
        if not is_installed():
            raise ImageError("Сначала установите движок рисования (кнопка «Установить»)")
        if self.busy():
            raise ImageError(f"Уже скачивается «{self.state['model']}» — дождитесь окончания")
        total = int(MODELS[model_id]["size_gb"] * 1024 ** 3)
        self.state = {"model": model_id, "done": 0, "total": total, "error": None, "finished": False}
        self._thread = threading.Thread(target=self._run, args=(model_id, MIRRORS.get(mirror, MIRRORS["huggingface"])),
                                        daemon=True)
        self._thread.start()
        return self.state

    def wait(self, timeout: float = 30) -> None:
        if self._thread:
            self._thread.join(timeout)

    def _run(self, model_id: str, endpoint: str) -> None:
        info = MODELS[model_id]
        target = model_dir(model_id)
        stop = threading.Event()
        # Прогресс считаем по размеру папки: huggingface_hub пишет файлы туда же по мере скачивания
        watcher = threading.Thread(target=self._watch, args=(target, stop), daemon=True)
        watcher.start()
        try:
            if FAKE:
                _fake_download(target, self.state)
                variant = "fp16"
            else:
                variant = _download_real(info, target, endpoint)
            (target / MARKER).write_text(json.dumps({"variant": variant}), encoding="utf-8")
        except Exception as e:  # noqa: BLE001 — сеть, диск, HuggingFace: всё превращаем в понятный текст
            shutil.rmtree(target, ignore_errors=True)
            self.state["error"] = (f"Не удалось скачать модель: {e}. Проверьте интернет и место на диске "
                                   "или выберите зеркало hf-mirror.")
        finally:
            stop.set()
            watcher.join(2)
            if not self.state["error"]:
                self.state["done"] = self.state["total"] = max(self.state["done"], _dir_size(target))
            self.state["finished"] = True

    def _watch(self, target: Path, stop: threading.Event) -> None:
        while not stop.wait(0.5):
            self.state["done"] = min(_dir_size(target), self.state["total"])


def _download_real(info: dict, target: Path, endpoint: str) -> str:
    from huggingface_hub import snapshot_download

    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(info["repo"], local_dir=target, allow_patterns=ALLOW, ignore_patterns=IGNORE, endpoint=endpoint)
    variant = "fp16"
    if not list((target / "unet").glob("*fp16.safetensors")):
        # У модели нет fp16-файлов — качаем обычные (вдвое больше) и приводим к fp16 при загрузке
        snapshot_download(info["repo"], local_dir=target, allow_patterns=ALLOW_FULL, ignore_patterns=IGNORE, endpoint=endpoint)
        variant = None
    if info.get("vae_repo"):
        snapshot_download(info["vae_repo"], local_dir=target / "vae_fix", allow_patterns=["*.json", "*.safetensors"],
                          ignore_patterns=["*.bin", "*.ckpt"], endpoint=endpoint)
    return variant


def _fake_download(target: Path, state: dict) -> None:
    target.mkdir(parents=True, exist_ok=True)
    state["total"] = 4 * 1024 * 1024
    for i in range(8):
        (target / f"part{i}.bin").write_bytes(b"\0" * 512 * 1024)
        time.sleep(0.08)


def delete_model(model_id: str) -> bool:
    engine.forget()
    path = model_dir(model_id)
    if not path.exists():
        return False
    shutil.rmtree(path, ignore_errors=True)
    return True


downloader = Downloader()


# ---------- генерация ----------


class Engine:
    """Одна генерация за раз (видеокарта одна). Прогресс читает интерфейс через статус."""

    def __init__(self):
        self.lock = threading.Lock()
        self.progress: dict | None = None
        self._cancel = threading.Event()
        self._pipe = None
        self._pipe_id: str | None = None
        self.cuda: bool | None = None  # видит ли PyTorch видеокарту (узнаём при первом рисовании)

    def busy(self) -> bool:
        return self.lock.locked()

    def cancel(self) -> None:
        self._cancel.set()

    def forget(self) -> None:
        self._pipe, self._pipe_id = None, None

    def _set(self, **kw) -> None:
        self.progress = {**(self.progress or {}), **kw}

    # --- настоящий Stable Diffusion ---

    def _load(self, model_id: str):
        import torch
        from diffusers import AutoencoderKL, AutoPipelineForText2Image, DPMSolverMultistepScheduler, StableDiffusionPipeline

        if self._pipe_id == model_id and self._pipe is not None:
            return self._pipe
        self.forget()
        info = MODELS[model_id]
        path = model_dir(model_id)
        variant = json.loads((path / MARKER).read_text(encoding="utf-8")).get("variant")
        common = {"torch_dtype": torch.float16, "local_files_only": True, "variant": variant}  # fp16: на Turing нет bf16
        if info["kind"] == "sd15":
            pipe = StableDiffusionPipeline.from_pretrained(path, safety_checker=None, requires_safety_checker=False, **common)
            # DPM++ 2M Karras — хорошее качество уже за 20–25 шагов
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
            pipe.enable_attention_slicing()  # меньше пикового расхода видеопамяти
        else:
            vae = AutoencoderKL.from_pretrained(path / "vae_fix", torch_dtype=torch.float16, local_files_only=True)
            pipe = AutoPipelineForText2Image.from_pretrained(path, vae=vae, **common)
            pipe.enable_model_cpu_offload()  # 7 ГБ весов: части модели заезжают на видеокарту по очереди
        pipe.enable_vae_tiling()  # декодер по кусочкам — большие картинки не переполняют память
        pipe.set_progress_bar_config(disable=True)
        self._pipe, self._pipe_id = pipe, model_id
        return pipe

    def _generate_real(self, model_id, prompt, negative, width, height, steps, guidance, seeds) -> list:
        import torch

        if self.cuda is None:
            self.cuda = torch.cuda.is_available()
        if not self.cuda:
            raise ImageError("PyTorch не видит видеокарту (установлен вариант без CUDA). На странице «Изображения» "
                             "нажмите «Переустановить движок».")
        self._set(stage="load", text="Загружаю модель в видеопамять…")
        pipe = self._load(model_id)
        offloaded = MODELS[model_id]["kind"] == "sdxl"
        if not offloaded:
            pipe.to("cuda")
        images = []
        try:
            for n, seed in enumerate(seeds):
                def on_step(_pipe, step, _t, kwargs, n=n):
                    if self._cancel.is_set():
                        raise Cancelled("Остановлено")
                    self._set(stage="draw", step=step + 1, total=steps, image=n + 1, count=len(seeds),
                              text=f"Рисую{f' {n + 1} из {len(seeds)}' if len(seeds) > 1 else ''}: шаг {step + 1} из {steps}")
                    return kwargs

                generator = torch.Generator("cpu").manual_seed(seed)  # на CPU — повторяемо при любом размещении модели
                result = pipe(prompt=prompt, negative_prompt=negative or None, width=width, height=height,
                              num_inference_steps=steps, guidance_scale=guidance, generator=generator,
                              callback_on_step_end=on_step)
                images.append(result.images[0])
        except torch.cuda.OutOfMemoryError as e:
            raise ImageError("Не хватило видеопамяти. Закройте игры и лишние вкладки браузера, поставьте Wallpaper "
                             "Engine на паузу, выберите размер поменьше или модель DreamShaper.") from e
        finally:
            if not offloaded:
                pipe.to("cpu")  # модель остаётся в ОЗУ — следующая картинка начнётся быстрее
            if MODELS[model_id]["kind"] == "sdxl":
                self.forget()  # 7 ГБ в ОЗУ не держим: у пользователя 16 ГБ, и Ollama тоже их использует
            torch.cuda.empty_cache()
        return images

    # --- заглушка для тестов ---

    def _generate_fake(self, model_id, prompt, negative, width, height, steps, guidance, seeds) -> list:
        from PIL import Image, ImageDraw

        self._set(stage="load", text="Загружаю модель в видеопамять…")
        time.sleep(0.05)
        images = []
        for n, seed in enumerate(seeds):
            for step in range(steps):
                if self._cancel.is_set():
                    raise Cancelled("Остановлено")
                self._set(stage="draw", step=step + 1, total=steps, image=n + 1, count=len(seeds),
                          text=f"Рисую: шаг {step + 1} из {steps}")
                time.sleep(float(os.getenv("FAKE_IMAGE_STEP", "0.03")))
            rnd = random.Random(int(hashlib.md5(f"{prompt}{seed}".encode()).hexdigest()[:8], 16))
            a, b = [tuple(rnd.randint(30, 230) for _ in range(3)) for _ in range(2)]
            img = Image.new("RGB", (width, height))
            draw = ImageDraw.Draw(img)
            for y in range(height):
                t = y / max(1, height - 1)
                draw.line([(0, y), (width, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
            draw.text((12, 12), f"{prompt[:60]}\nseed {seed}", fill=(255, 255, 255))
            images.append(img)
        return images

    def generate(self, model_id: str, prompt: str, *, negative: str = "", orientation: str = "square",
                 count: int = 1, seed: int | None = None) -> dict:
        """Рисует count картинок. Возвращает {images: [PNG bytes], seeds, width, height, steps, seconds}."""
        info = MODELS[model_id]
        if not is_downloaded(model_id):
            raise ImageError(f"Модель «{info['title']}» не скачана: страница «Изображения» → «Скачать».")
        width, height = info["sizes"].get(orientation, info["sizes"]["square"])
        steps, guidance = info["steps"], info["guidance"]
        base = seed if seed is not None else random.randint(0, 2 ** 31 - 1)
        seeds = [base + i for i in range(max(1, min(4, count)))]
        if not self.lock.acquire(blocking=False):
            raise ImageError("Уже рисую другую картинку — подождите")
        self._cancel.clear()
        started = time.monotonic()
        try:
            run = self._generate_fake if FAKE else self._generate_real
            pictures = run(model_id, prompt, negative, width, height, steps, guidance, seeds)
            self._set(stage="save", text="Сохраняю…")
            pngs = []
            for picture in pictures:
                buf = io.BytesIO()
                picture.save(buf, format="PNG")
                pngs.append(buf.getvalue())
            return {"images": pngs, "seeds": seeds, "width": width, "height": height, "steps": steps,
                    "seconds": round(time.monotonic() - started, 1)}
        finally:
            self.progress = None
            self.lock.release()


engine = Engine()


async def unload_language_models() -> list[str]:
    """Освободить видеопамять от Qwen3 перед рисованием."""
    from ..llm import get_backend

    engine._set(stage="unload", text="Освобождаю видеопамять от языковой модели…")
    try:
        return await get_backend().unload_all()
    except Exception:  # noqa: BLE001 — если не вышло, попробуем рисовать всё равно
        return []


async def generate(model_id: str, prompt: str, **kw) -> dict:
    """Асинхронная обёртка: выгрузить языковую модель → нарисовать в отдельном потоке."""
    if engine.busy():
        raise ImageError("Уже рисую другую картинку — подождите")
    await unload_language_models()
    return await asyncio.to_thread(engine.generate, model_id, prompt, **kw)
