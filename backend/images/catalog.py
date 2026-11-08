"""
Модели для рисования и их настройки под RTX 2060 Super (8 ГБ, fp16, без bf16).

  * DreamShaper 8 — дообученный Stable Diffusion 1.5. Веса ≈ 2 ГБ, в видеопамяти ≈ 3,5 ГБ при
    512×512. Универсальный: фото, арт, иллюстрации. 25 шагов ≈ 8–15 секунд. По умолчанию.
  * SDXL Turbo — SDXL, обученный рисовать за 1–4 шага. Детальнее, но веса ≈ 7 ГБ: целиком
    в 8 ГБ вместе с вычислениями не помещается, поэтому части модели по очереди переезжают
    между ОЗУ и видеокартой (enable_model_cpu_offload) — работает, но первые секунды уходят
    на перенос. Лицензия — только некоммерческое использование (для личного — подходит).

Модели крупнее (SDXL base, FLUX) на 8 ГБ работают мучительно медленно — их не предлагаем.
"""

MODELS = {
    "dreamshaper": {
        "title": "DreamShaper 8 — универсальная (SD 1.5)",
        "repo": "Lykon/dreamshaper-8",
        "kind": "sd15",
        "size_gb": 2.2,
        "recommended": True,
        "steps": 25,
        "guidance": 6.5,
        "sizes": {"square": (512, 512), "portrait": (512, 768), "landscape": (768, 512)},
        "note": "≈ 8–15 с на картинку",
    },
    "sdxl-turbo": {
        "title": "SDXL Turbo — детальнее и быстрее, но тяжелее",
        "repo": "stabilityai/sdxl-turbo",
        "vae_repo": "madebyollin/sdxl-vae-fp16-fix",  # родной VAE SDXL в fp16 даёт чёрные картинки
        "kind": "sdxl",
        "size_gb": 7.0,
        "steps": 4,
        "guidance": 0.0,  # Turbo обучен без guidance
        "sizes": {"square": (512, 512), "portrait": (512, 768), "landscape": (768, 512)},
        "note": "≈ 5–10 с, впритык по видеопамяти",
    },
}

# Что качать: конфиги и веса в fp16; без safety_checker (фильтр NSFW от SD 1.5 весит 1,2 ГБ и
# часто ошибается — на личном компьютере решает пользователь) и без старых форматов весов
ALLOW = ["*.json", "*.txt", "*.model", "*fp16.safetensors"]
ALLOW_FULL = ["*.json", "*.txt", "*.model", "*.safetensors"]  # если у модели нет fp16-варианта
IGNORE = ["safety_checker/*", "*.ckpt", "*.bin", "*.onnx", "*.onnx_data", "*.msgpack", "*.h5", "*ema*", "*.png", "*.jpg"]

NEGATIVE_DEFAULT = ("lowres, blurry, bad anatomy, extra fingers, deformed, watermark, text, signature, "
                    "jpeg artifacts, worst quality")

TORCH_INDEX = "https://download.pytorch.org/whl/cu126"  # колёса PyTorch с CUDA 12.6 (подходят к драйверу 616 и sm_75)
PACKAGES = ["diffusers>=0.30", "transformers>=4.44", "accelerate>=0.33", "safetensors", "huggingface_hub>=0.24"]
