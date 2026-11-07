"""
Оценка расхода видеопамяти — чтобы ещё ДО загрузки модели предупредить:
«с таким контекстом модель не поместится в видеокарту и будет медленной».

Из чего складывается память модели на видеокарте:
  1. Веса — примерно размер файла модели (qwen3:8b Q4_K_M ≈ 4,9 ГиБ).
  2. KV-кэш — память под контекст. Растёт линейно с размером контекста:
     байт_на_токен × num_ctx. У Qwen3 8B в fp16 это 144 КиБ на токен,
     то есть 8K контекста ≈ 1,1 ГиБ, 32K ≈ 4,5 ГиБ.
     Сжатие кэша (OLLAMA_KV_CACHE_TYPE) уменьшает его: q8_0 почти в 2 раза, q4_0 — в 3,5.

Проверка на замере пользователя (qwen3:8b, 8K, fp16):
  оценка 4,87 + 1,13 = 6,0 ГиБ, по nvidia-smi — 5,9 ГиБ. Оценка чуть с запасом — так и надо.

Это именно ОЦЕНКА. Точно видно по индикатору VRAM после загрузки модели (данные Ollama).
"""

GIB = 1024**3

# Во сколько раз сжатый KV-кэш меньше fp16 (байт на значение / 2 байта).
# q8_0: блок из 32 чисел занимает 34 байта; q4_0 — 18 байт.
KV_FACTOR = {"f16": 1.0, "q8_0": 34 / 64, "q4_0": 18 / 64}

# Запас, который хотим оставить свободным, чтобы считать конфигурацию «безопасной»
SAFE_MARGIN_GB = 0.5


def estimate(
    *,
    weights_bytes: int,
    kv_bytes_per_token: int | None,
    num_ctx: int,
    kv_cache_type: str,
    vram_total_gb: float,
    vram_reserved_gb: float,
) -> dict:
    """Возвращает оценку и уровень: ok (влезает с запасом), warn (впритык), danger (не влезет)."""
    weights_gb = weights_bytes / GIB
    if kv_bytes_per_token:
        kv_gb = kv_bytes_per_token * KV_FACTOR.get(kv_cache_type, 1.0) * num_ctx / GIB
    else:
        kv_gb = None  # устройство модели неизвестно — считаем только веса
    total_gb = weights_gb + (kv_gb or 0.0)
    available_gb = vram_total_gb - vram_reserved_gb

    if total_gb > available_gb:
        level = "danger"
        message = (
            f"Скорее всего не поместится: нужно ≈ {total_gb:.1f} ГиБ, а свободно ≈ {available_gb:.1f} ГиБ. "
            "Часть модели уйдёт в оперативную память — ответы станут в несколько раз медленнее."
        )
    elif total_gb > available_gb - SAFE_MARGIN_GB:
        level = "warn"
        message = (
            f"Впритык: ≈ {total_gb:.1f} из {available_gb:.1f} ГиБ свободной видеопамяти. "
            "Может не поместиться, если открыто много вкладок браузера или запущены игры."
        )
    else:
        level = "ok"
        message = f"Поместится: ≈ {total_gb:.1f} из {available_gb:.1f} ГиБ свободной видеопамяти."

    if kv_gb is None:
        message += " (Размер контекста не учтён: движок не сообщил устройство модели.)"

    return {
        "weights_gb": round(weights_gb, 2),
        "kv_gb": round(kv_gb, 2) if kv_gb is not None else None,
        "total_gb": round(total_gb, 2),
        "available_gb": round(available_gb, 2),
        "vram_total_gb": vram_total_gb,
        "level": level,
        "message": message,
    }


def max_safe_context(
    *, weights_bytes: int, kv_bytes_per_token: int | None, kv_cache_type: str,
    vram_total_gb: float, vram_reserved_gb: float, steps: list[int],
) -> int | None:
    """Самый большой контекст из списка steps, при котором оценка — «ok»."""
    best = None
    for num_ctx in steps:
        result = estimate(
            weights_bytes=weights_bytes, kv_bytes_per_token=kv_bytes_per_token, num_ctx=num_ctx,
            kv_cache_type=kv_cache_type, vram_total_gb=vram_total_gb, vram_reserved_gb=vram_reserved_gb,
        )
        if result["level"] == "ok":
            best = num_ctx
    return best
