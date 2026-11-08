"""
ЭКСПЕРИМЕНТАЛЬНОЕ локальное дообучение на своей видеокарте (RTX 2060 Super, 8 ГБ).

Честно о железе:
  * Qwen3-8B на 8 ГБ НЕ помещается даже в 4 битах: слои ~4 ГБ + два слоя словаря
    (151 тыс. слов × 4096, они не сжимаются) ~2,5 ГБ + активации и оптимизатор.
    Основной путь для 8B — ноутбук Google Colab (training/colab_finetune.ipynb).
  * Здесь по умолчанию — Qwen3-4B: помещается при контексте 1024 и батче 1,
    но ТОЛЬКО если закрыть Ollama и другие программы, использующие видеокарту.
  * Turing (RTX 20xx) не умеет bfloat16 — обучаем в float16.

Установка (в отдельном окружении, чтобы не трогать окружение ассистента):
    python -m venv .venv-train
    .venv-train\\Scripts\\activate
    pip install torch --index-url https://download.pytorch.org/whl/cu124
    pip install unsloth
  Если Unsloth не ставится на Windows — используйте WSL2 (Ubuntu) или Colab.

Запуск:
    ollama stop qwen3:8b        (освободить видеопамять; или закрыть Ollama в трее)
    python training/train_local.py --dataset data/dataset/train_sft.jsonl

Результат: папка с LoRA и объединённой моделью (16 бит) + инструкция, как получить GGUF
и подключить его к Ollama (`ollama create ... --quantize q4_K_M`).
"""

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path

DEFAULT_BASE = "unsloth/Qwen3-4B-unsloth-bnb-4bit"
# Сколько свободной видеопамяти нужно (ГиБ, с запасом) — по замерам Unsloth для QLoRA
REQUIRED_VRAM_GB = {"0.6b": 2.0, "1.7b": 3.5, "4b": 5.5, "8b": 9.0, "14b": 14.0}


# ---------- подготовка данных (без torch — эти функции можно проверять без видеокарты) ----------


def load_jsonl(path: Path) -> list[list[dict]]:
    rows = []
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            messages = json.loads(line)["messages"]
        except (json.JSONDecodeError, KeyError, TypeError):
            print(f"⚠ строка {number} пропущена: ожидается {{\"messages\": [...]}}")
            continue
        if len(messages) >= 2 and messages[-1].get("role") == "assistant" and messages[-2].get("role") == "user":
            rows.append(messages)
        else:
            print(f"⚠ строка {number} пропущена: в конце нужны вопрос и ответ")
    # Дубликаты (одинаковые вопрос + ответ) убираем — иначе модель их зазубрит
    seen, unique = set(), []
    for m in rows:
        key = hashlib.md5(json.dumps(m[-2:], ensure_ascii=False).encode()).hexdigest()
        if key not in seen:
            seen.add(key)
            unique.append(m)
    random.Random(3407).shuffle(unique)
    return unique


def model_size_key(base: str) -> str | None:
    """«unsloth/Qwen3-8B-unsloth-bnb-4bit» → «8b».

    Ищем «-<число>b-» или «-<число>b» в конце: просто «4b» искать нельзя — в «bnb-4bit»
    тоже есть «-4b», и 8B-модель приняли бы за 4B.
    """
    match = re.search(r"-(\d+(?:\.\d+)?)b(?:-|$)", base.lower())
    key = f"{match.group(1)}b" if match else None
    return key if key in REQUIRED_VRAM_GB else None


def vram_advice(base: str, free_gb: float) -> tuple[bool, str]:
    """Хватит ли видеопамяти. Возвращает (можно ли пробовать, объяснение)."""
    key = model_size_key(base)
    need = REQUIRED_VRAM_GB.get(key or "", 0)
    if not need:
        return True, f"Размер модели не распознан — свободно {free_gb:.1f} ГиБ, пробуем на ваш страх и риск."
    if free_gb >= need:
        return True, f"Свободно {free_gb:.1f} ГиБ, нужно ~{need} ГиБ — должно поместиться."
    tip = " Закройте Ollama (`ollama stop qwen3:8b` или значок в трее → Quit), браузер и Wallpaper Engine."
    if key in ("8b", "14b"):
        tip += " Модели 8B+ на 8 ГБ не обучаются — используйте ноутбук Colab или --base Qwen3-4B."
    return False, f"Свободно {free_gb:.1f} ГиБ, а нужно ~{need} ГиБ.{tip}"


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Экспериментальное локальное дообучение (QLoRA, fp16)")
    p.add_argument("--dataset", type=Path, default=Path("data/dataset/train_sft.jsonl"))
    p.add_argument("--base", default=DEFAULT_BASE, help="модель Unsloth в 4 битах (по умолчанию Qwen3-4B)")
    p.add_argument("--max-seq", type=int, default=1024, help="максимальная длина примера в токенах")
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--lora-r", type=int, default=8, help="меньше r — меньше памяти")
    p.add_argument("--out", type=Path, default=Path("training/output/jarvis-local"))
    p.add_argument("--force", action="store_true", help="запустить, даже если видеопамяти по оценке мало")
    return p.parse_args(argv)


# ---------- обучение ----------


def main(argv=None):
    args = parse_args(argv)
    rows = load_jsonl(args.dataset)
    print(f"Примеров после проверки и удаления дублей: {len(rows)}")
    if not rows:
        sys.exit("Датасет пуст. Отметьте ответы 👍 или исправьте их ✏️ в приложении.")

    import torch  # тяжёлые библиотеки импортируем только здесь

    if not torch.cuda.is_available():
        sys.exit("PyTorch не видит видеокарту. Установите torch с CUDA: "
                 "pip install torch --index-url https://download.pytorch.org/whl/cu124")
    free, total = (x / 1024**3 for x in torch.cuda.mem_get_info())
    ok, advice = vram_advice(args.base, free)
    print(f"Видеокарта: {torch.cuda.get_device_name(0)}, всего {total:.1f} ГиБ. {advice}")
    if not ok and not args.force:
        sys.exit("Остановлено, чтобы не упасть с нехваткой памяти посреди обучения (флаг --force — всё равно попробовать).")

    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import train_on_responses_only

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base, max_seq_length=args.max_seq, dtype=torch.float16, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model, r=args.lora_r, lora_alpha=args.lora_r, lora_dropout=0, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=3407)

    texts = [tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False, enable_thinking=False)
             for m in rows]
    texts = [t for t in texts if len(tokenizer(t).input_ids) <= args.max_seq]
    print(f"Помещаются в {args.max_seq} токенов: {len(texts)} примеров")

    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=Dataset.from_dict({"text": texts}),
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=args.max_seq,
            per_device_train_batch_size=1, gradient_accumulation_steps=8,  # минимум памяти
            warmup_steps=5, num_train_epochs=args.epochs, learning_rate=args.lr,
            fp16=True, bf16=False,  # Turing: только float16
            logging_steps=1, optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="linear",
            seed=3407, output_dir=str(args.out / "checkpoints"), report_to="none", save_strategy="no",
        ),
    )
    trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n",
                                      response_part="<|im_start|>assistant\n")
    stats = trainer.train()
    print(f"Обучение заняло {stats.metrics['train_runtime'] / 60:.1f} мин, loss {stats.metrics['train_loss']:.3f}, "
          f"пик видеопамяти {torch.cuda.max_memory_reserved() / 1024**3:.1f} ГиБ")

    lora_dir, merged_dir = args.out / "lora", args.out / "merged"
    model.save_pretrained(str(lora_dir))
    tokenizer.save_pretrained(str(lora_dir))
    model.save_pretrained_merged(str(merged_dir), tokenizer, save_method="merged_16bit")
    name = args.out.name
    print(f"""
Готово. Адаптер: {lora_dir}
Объединённая модель (16 бит): {merged_dir}

Как подключить к Ollama (сборка llama.cpp не нужна — только Python-скрипт конвертации):
  git clone --depth 1 https://github.com/ggml-org/llama.cpp
  pip install -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
  python llama.cpp/convert_hf_to_gguf.py {merged_dir} --outtype f16 --outfile {args.out / (name + '.f16.gguf')}
Затем в приложении: Обучение → Подключить модель → путь к .f16.gguf, галочка «Сжать до Q4_K_M».
""")


if __name__ == "__main__":
    main()
