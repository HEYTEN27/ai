"""
Картинки для модели зрения (этап 14).

Модель «видит» картинку как набор токенов: у Qwen-VL примерно один токен на квадрат 28×28
пикселей. Фото с телефона 4000×3000 — это ≈ 15 000 токенов, а весь наш контекст — 8192.
Поэтому для модели делаем уменьшенную копию: не больше 1280 пикселей по длинной стороне
(≈ 1000–1600 токенов — текст на скриншоте ещё читается). Оригинал хранится для скачивания.

Сканы PDF (страницы-картинки без текстового слоя) раньше отклонялись. Теперь вынимаем из
первых страниц сами изображения и показываем их модели зрения как картинки.
"""

import io
from pathlib import Path

from PIL import Image, ImageOps

MAX_SIDE = 1280  # длинная сторона копии для модели
JPEG_QUALITY = 85
MAX_PIXELS = 60_000_000  # защита от «бомбы» — картинки, которая распаковывается в гигабайты
SCAN_PAGES = 4  # сколько страниц скана показывать модели

Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class VisionError(ValueError):
    """Картинку не прочитать — текст показывается пользователю."""


def _to_jpeg(img: Image.Image) -> bytes:
    img = ImageOps.exif_transpose(img)  # фото с телефона «лежат на боку» без учёта EXIF
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))  # прозрачность → белый фон (скриншоты)
        background.paste(img, mask=img.split()[-1])
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


def prepare_image(data: bytes) -> tuple[dict, bytes]:
    """Байты картинки → (сведения для интерфейса, JPEG-копия для модели)."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()  # первый кадр (GIF — тоже первый кадр)
            width, height = ImageOps.exif_transpose(img).size
            jpeg = _to_jpeg(img)
    except Image.DecompressionBombError as e:
        raise VisionError("Картинка слишком большая (больше 60 мегапикселей)") from e
    except (OSError, ValueError, SyntaxError) as e:
        raise VisionError("Не получилось открыть картинку — файл повреждён или это не изображение") from e
    with Image.open(io.BytesIO(jpeg)) as small:
        vw, vh = small.size
    return {"type": "image", "width": width, "height": height, "vision_size": [vw, vh],
            "tokens": (vw // 28 + 1) * (vh // 28 + 1)}, jpeg


def scan_pages(data: bytes, limit: int = SCAN_PAGES) -> tuple[int, list[bytes]]:
    """PDF-скан → (всего страниц, JPEG первых страниц). Берём самое большое изображение страницы."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = []
    for page in reader.pages[:limit]:
        try:
            images = list(page.images)
        except Exception:  # noqa: BLE001 — экзотическое сжатие картинки в PDF: пропускаем страницу
            continue
        if not images:
            continue
        biggest = max(images, key=lambda im: len(im.data))
        try:
            with Image.open(io.BytesIO(biggest.data)) as img:
                img.load()
                pages.append(_to_jpeg(img))
        except (OSError, ValueError, Image.DecompressionBombError):
            continue
    return len(reader.pages), pages


def page_name(n: int) -> str:
    return f"page-{n}.jpg"


VISION_NAME = "vision.jpg"


def vision_files(folder: Path, meta: dict) -> list[Path]:
    """Файлы-картинки для модели у одного вложения."""
    if meta.get("type") == "image":
        return [folder / VISION_NAME]
    if meta.get("type") == "scan":
        return [folder / page_name(n) for n in range(1, meta.get("scan_pages", 0) + 1)]
    return []
