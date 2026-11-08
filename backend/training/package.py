"""
Подготовка к дообучению: проверка датасета и пакет для Google Colab.

Пакет (zip) содержит всё, что нужно ноутбуку:
  * train_sft.jsonl — датасет без дубликатов;
  * colab_finetune.ipynb — ноутбук;
  * config.json — настройки (эпохи подбираются под размер датасета);
  * ПРОЧТИ_МЕНЯ.txt — что делать по шагам.
"""

import hashlib
import io
import json
import math
import zipfile

from ..config import PROJECT_ROOT
from ..dataset import store as dataset_store

NOTEBOOK_PATH = PROJECT_ROOT / "training" / "colab_finetune.ipynb"
BASE_MODEL = "unsloth/Qwen3-8B-unsloth-bnb-4bit"
MAX_SEQ_LENGTH = 2048
OUTPUT_NAME = "jarvis-qwen3"
EXAMPLES_PER_STEP = 8  # batch 2 × накопление 4 — как в ноутбуке
SECONDS_PER_STEP_T4 = 8  # грубо для Qwen3-8B QLoRA на Tesla T4
COLAB_OVERHEAD_MIN = 25  # установка, загрузка модели, экспорт GGUF


def _tokens(messages: list[dict]) -> int:
    return sum(len(m["content"]) // 3 + 4 for m in messages)


def dedupe(rows: list[dict]) -> tuple[list[dict], int]:
    seen, result = set(), []
    for row in rows:
        key = hashlib.md5(json.dumps(row["messages"][-2:], ensure_ascii=False).encode()).hexdigest()
        if key not in seen:
            seen.add(key)
            result.append(row)
    return result, len(rows) - len(result)


def recommended_epochs(n: int) -> int:
    """Мало примеров — больше проходов (но не больше 3, иначе зазубрит), много — меньше."""
    if n < 100:
        return 3
    if n < 500:
        return 2
    return 1


def analyze(include_system: bool = True) -> dict:
    """Проверки датасета перед обучением и рекомендуемые настройки."""
    rows, duplicates = dedupe(dataset_store.export_sft(include_system=include_system))
    n = len(rows)
    too_long = sum(1 for r in rows if _tokens(r["messages"]) > MAX_SEQ_LENGTH)
    checks = []

    if n == 0:
        checks.append({"level": "error", "text": "В датасете нет примеров. Отмечайте хорошие ответы 👍 и исправляйте плохие ✏️."})
    elif n < 50:
        checks.append({"level": "warn", "text": f"Примеров {n} — это мало: модель скорее зазубрит их, чем научится. "
                                                "Обучить можно (для пробы), но для заметного эффекта нужно 200+."})
    elif n < 150:
        checks.append({"level": "warn", "text": f"Примеров {n} — эффект будет небольшим. Хорошо бы 200+."})
    else:
        checks.append({"level": "ok", "text": f"Примеров {n} — достаточно для заметного эффекта."})
    if duplicates:
        checks.append({"level": "ok", "text": f"Повторы ({duplicates}) будут убраны из пакета."})
    if too_long:
        checks.append({"level": "warn", "text": f"Длинных примеров (больше {MAX_SEQ_LENGTH} токенов): {too_long} — ноутбук их пропустит."})
    stats = dataset_store.stats()
    if stats["with_tools"]:
        checks.append({"level": "ok", "text": f"Ответы с инструментами ({stats['with_tools']}) в пакет не входят — модель научилась бы выдумывать их результаты."})

    epochs = recommended_epochs(n)
    steps = math.ceil(max(n, 1) * 0.9 / EXAMPLES_PER_STEP) * epochs if n else 0
    return {
        "examples": n,
        "duplicates": duplicates,
        "too_long": too_long,
        "checks": checks,
        "ready": n > 0,
        "config": {
            "base_model": BASE_MODEL, "max_seq_length": MAX_SEQ_LENGTH, "epochs": epochs,
            "learning_rate": 2e-4, "lora_r": 16, "output_name": OUTPUT_NAME, "dataset_path": "train_sft.jsonl",
        },
        "steps": steps,
        "estimated_minutes": round(steps * SECONDS_PER_STEP_T4 / 60) + COLAB_OVERHEAD_MIN if n else 0,
    }


README = """\
Дообучение Джарвиса в Google Colab — по шагам

1. Откройте https://colab.research.google.com и войдите в Google-аккаунт.
2. Файл → Загрузить блокнот → выберите colab_finetune.ipynb из этого архива.
3. Среда выполнения → Сменить среду выполнения → T4 GPU → Сохранить.
4. Запускайте ячейки по порядку (Shift+Enter). В шаге 3 ноутбук попросит файл —
   загрузите ВЕСЬ этот архив (jarvis_colab_package.zip), он распакуется сам.
5. Обучение и экспорт займут примерно {minutes} мин. В конце ноутбук положит
   jarvis-qwen3.Q4_K_M.gguf (~5 ГБ) на ваш Google Диск в папку jarvis/.
6. Скачайте этот файл на компьютер и подключите его в приложении:
   Обучение → Подключить модель.

Важно: датасет ({examples} примеров) загружается в Google Colab, то есть покидает компьютер.
Перед этим просмотрите его на странице «Датасет» и исключите личное.
"""


def build_zip(include_system: bool = True) -> tuple[bytes, dict]:
    info = analyze(include_system)
    rows, _ = dedupe(dataset_store.export_sft(include_system=include_system))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("train_sft.jsonl", dataset_store.to_jsonl(rows))
        z.writestr("config.json", json.dumps(info["config"], ensure_ascii=False, indent=2))
        z.write(NOTEBOOK_PATH, "colab_finetune.ipynb")
        z.writestr("ПРОЧТИ_МЕНЯ.txt", README.format(minutes=info["estimated_minutes"], examples=info["examples"]))
    return buffer.getvalue(), info
