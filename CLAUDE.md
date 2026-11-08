# Личный локальный ИИ-ассистент

Приложение-ассистент, которое работает на компьютере пользователя с открытой языковой
моделью, учится на его данных и помогает в учёбе, программировании, текстах и
повседневных задачах.

## Пользователь
- Студент, веб-разработчик среднего уровня.
- Ключевые решения объяснять простым языком.
- Код понятный, с комментариями **на русском**.
- Общение на русском.

## Целевое железо (компьютер пользователя)
| Компонент | Значение |
|---|---|
| GPU | NVIDIA RTX 2060 Super, **8 ГБ VRAM**, Turing (sm_75), **нет bf16** → только fp16 |
| CPU | AMD Ryzen 5 2600 (6 ядер / 12 потоков) |
| RAM | 16 ГБ |
| ОС | **Windows 10** (драйвер в режиме WDDM) |
| Драйвер / CUDA | 616.92 / CUDA 13.4 (совместим с колёсами PyTorch cu12x) |
| Ollama | 0.34.4 |
| VRAM в простое | ≈ 0,8 ГБ занято (Chrome, Telegram, Wallpaper Engine и др.) → **свободно ≈ 7,3 ГБ** |

Значит, скрипты запуска нужны в первую очередь `.bat`/PowerShell, пути пишем через
`pathlib`, Docker не предполагаем (песочница работает через subprocess с ограничениями).

> Разработка идёт в облачном контейнере **без GPU**. Здесь проверять логику на CPU
> с маленькой моделью или с заглушкой Ollama; производительность и VRAM пользователь
> проверяет у себя по инструкции из отчёта этапа.

## Модели
- **Основная:** `qwen3:8b` (Q4_K_M) через Ollama. Должна целиком помещаться в VRAM.
- **Запасная для сравнения:** `llama3.1:8b` (Q4_K_M).
- **Эмбеддинги:** `bge-m3` (мультиязычная, хороша для русского). Запасной вариант
  `nomic-embed-text` (лёгкая, но в основном для английского).
- **Модели крупнее 8B** не делать основными. В интерфейсе показывать их с пометкой
  «медленно, частично на CPU».

### Бюджет VRAM (оценка)
- qwen3:8b Q4_K_M: веса ≈ 5,2 ГБ.
- KV-кэш при 8K контекста ≈ 1,1 ГБ (fp16). Опционально в 2 раза меньше через
  `OLLAMA_FLASH_ATTENTION=1` и `OLLAMA_KV_CACHE_TYPE=q8_0`.
- Рабочий стол Windows/браузер ≈ 0,8 ГБ (измерено у пользователя).
- Буферы вычислений Ollama ≈ 0,3–0,5 ГБ.
- **Итого ≈ 6,8 ГБ из 7,3 ГБ свободных.** Влезает, но запаса мало; Wallpaper Engine
  лучше ставить на паузу.
- bge-m3 ≈ 1,2 ГБ. **Вместе с основной моделью на 8 ГБ впритык**, поэтому по умолчанию
  эмбеддинги считаются на CPU (`options.num_gpu = 0`) либо модель переключается
  на `nomic-embed-text`.
- Контекст по умолчанию **8192** токенов, меняется в настройках. При увеличении показывать
  предупреждение.
- **Замер у пользователя (qwen3:8b, 8K, fp16 KV):** `ollama ps` 6,2 GB, 100% GPU;
  `nvidia-smi` 6876 / 8192 МиБ (простой 823 МиБ) → модель ≈ 5,9 ГиБ, **свободно ≈ 1,3 ГиБ**;
  скорость **≈ 54 ток/с**.
- KV-кэш Qwen3 8B: 36 слоёв × 8 KV-голов × (128+128) × 2 байта ≈ **144 КиБ на токен**
  (q8_0 — в ~1,9 раза меньше). Безопасно: fp16 до 12K, q8_0 до 16K; 16K fp16 и 24K q8_0 — впритык.
- **Детектор выгрузки в RAM:** `GET /api/ps` в Ollama. Если `size_vram < size`, модель
  частично на CPU, и UI показывает предупреждение.

## Стек
- **Бэкенд модели:** Ollama (основной, `http://localhost:11434`). Через слой-адаптер
  можно переключиться на llama.cpp (`llama-server`, OpenAI-совместимый API).
- **Сервер:** Python 3.11/3.12 + FastAPI, стриминг ответов (SSE).
- **Интерфейс:** веб-UI, чат в стиле ChatGPT, тёмная тема, история диалогов, markdown,
  подсветка кода. Все JS-библиотеки лежат локально (без CDN), чтобы работать офлайн.
- **Хранилище:** SQLite (диалоги, настройки, память, оценки), ChromaDB (векторный поиск).

## Принципы
- Всё работает **офлайн**, кроме инструмента «поиск в интернете». Данные не покидают ПК.
  Никакой телеметрии (у ChromaDB отключать `anonymized_telemetry`).
- **Модульность:** каждая функция (чат, память, RAG, инструменты, датасет, обучение,
  голос) живёт в своём модуле и своём API-роутере.
- Каждое действие инструментов с файлами **подтверждает пользователь** в UI.
- Если что-то не влезает в железо, сказать прямо и предложить альтернативу.
- Этапы делаются по одному. После каждого: запуск, проверка, короткий отчёт
  и инструкция «как проверить у себя». Следующий этап начинать только после подтверждения.

## Этапы
1. Базовый чат: подключение к модели, стриминг, история, выбор модели.
2. Настройки: системный промпт, персоны, температура и другие параметры, размер контекста.
3. Долговременная память: факты о пользователе, подтягиваются в контекст, страница управления.
4. RAG: PDF, DOCX, TXT, MD (Obsidian), чанкинг, эмбеддинги, ссылки на источники.
5. Инструменты: веб-поиск, чтение файлов из выбранной папки (с подтверждением),
   Python-песочница, калькулятор.
6. Датасет: 👍/👎, «исправить ответ», экспорт в JSONL.
7. Дообучение: основной вариант — Colab-ноутбук (Unsloth, QLoRA, **fp16**) → GGUF → Ollama
   (`Modelfile`). Локальный вариант только экспериментальный, с минимальными настройками
   под 8 ГБ.
8. Полировка: голосовой ввод (Whisper), экспорт диалогов, запуск одной командой, README.

## Решения пользователя
- Ассистента зовут **Джарвис**. Имя и системный промпт редактируются в UI (таблица
  `app_settings`, умолчания в `backend/settings/store.py`; `ASSISTANT_NAME` — начальное значение).
- Фронтенд: чистые HTML/CSS/JS, ES-модули, без сборки.
- Git: после каждого этапа коммит и пуш в `main` репозитория HEYTEN27/ai.

## Как проверять в облачном контейнере
- Ollama/HuggingFace отсюда недоступны → используем эмулятор `tests/fake_ollama.py`
  (`FAKE_DELAY=0.04 python -m uvicorn tests.fake_ollama:app --port 11434`).
- `python -m pytest` — модульные и API-тесты (включая «Стоп» на живых серверах).
- UI проверяем Playwright-скриптами `tests/e2e/*.js` (Chromium предустановлен), смотрим скриншоты.
  Запускать с `LANG=C.UTF-8 LC_ALL=C.UTF-8` — иначе Chromium в контейнере не читает файлы
  с кириллицей в пути (загрузка молча теряет такие файлы).
- «Векторы» эмулятора — подсчёт общих слов: их близость ниже, чем у bge-m3, поэтому тесты
  базы знаний ставят `rag_min_score = 0.15`.

## Статус
- [x] Этап 0: CLAUDE.md и план
- [x] Этап 1: базовый чат (стриминг SSE, история в SQLite, выбор модели, «Стоп»,
      «Повторить», размышления Qwen3, индикатор VRAM, адаптер llama.cpp)
- [x] Этап 2: настройки в UI (имя, системный промпт с {name}/{model}/{date}, модель и
      персона по умолчанию, контекст + оценка VRAM, тип KV-кэша), персоны (4 встроенные +
      свои) с параметрами генерации; миграция БД №2
- [x] Этап 3: долговременная память (таблицы memories + memory_events, миграция №3);
      извлечение фактов той же моделью с JSON-схемой и тем же num_ctx (без перезагрузки),
      add/update/delete только по известным id, фильтр чувствительных данных, дедупликация;
      выбор: все в бюджет → иначе 📌 + по смыслу (bge-m3 на CPU, num_gpu=0) / по словам;
      отметки «Запомнил · Отменить» и «🧠 N фактов» в чате, страница «Память» с журналом
- [x] Этап 4: база знаний (миграция №4: kb_collections/kb_documents/kb_chunks + FTS5 kb_fts,
      conversations.kb_scope). Вместо ChromaDB — векторы в SQLite + numpy (60 зависимостей у Chroma).
      Парсеры PDF (pypdf, страницы)/DOCX (заголовки, таблицы)/TXT (utf-8|cp1251)/MD (Obsidian:
      frontmatter, [[ссылки]]); нарезка по разделам с перекрытием; фоновая очередь индексации;
      гибридный поиск (вектор ≥ rag_min_score + FTS, RRF); фрагменты — в последнем сообщении
      (кэш Ollama не сбрасывается); ссылки [n] → источник, PDF #page=N; синхронизация папки
- [x] Этап 5: инструменты через нативный tool calling Ollama (tools в /api/chat, роль tool).
      Цикл модель→инструмент→модель, ≤6 вызовов, затем запрос без tools. calculator (AST, без eval,
      лимиты размера), web_search (DDG HTML / SearXNG) + open_url (защита от SSRF, проверка
      редиректов), list_files/read_file (только внутри files_root, resolve+is_relative_to,
      подтверждение ВСЕГДА), run_python (subprocess + audit hook: без сети/subprocess/ctypes/файлов
      вне песочницы, таймаут, rlimit на POSIX; подтверждение по умолчанию). Подтверждения —
      asyncio.Future + SSE tool_confirm + POST /api/tools/confirm/{id}. Карточки в extras.tools
- [x] Этап 6: датасет (миграция №5: dataset_examples — снимок system/history/question/answer,
      corrected, rating, used_tools, strip_citations, included; message_id SET NULL — пример
      переживает удаление диалога). В SFT: 👍 или исправленные, не 👎-без-исправления, без
      инструментов по умолчанию; RAG-фрагменты в вопросе или вырезка [n]. DPO: chosen=corrected,
      rejected=answer. Исправление подменяет ответ в контексте. Файлы data/dataset/train_{sft,dpo}.jsonl
- [x] Этап 7: дообучение. training/colab_finetune.ipynb (unsloth/Qwen3-8B-unsloth-bnb-4bit, LoRA r16,
      fp16 на T4, train_on_responses_only, enable_thinking=False, сравнение до/после, GGUF q4_k_m →
      Google Диск, опционально адаптер через convert_lora_to_gguf). training/train_local.py —
      Qwen3-4B, seq 1024, batch 1, проверка VRAM (8B на 8 ГБ — честный отказ). backend/training:
      анализ датасета + zip-пакет (dataset без дублей, notebook, config.json с эпохами по размеру),
      подключение к Ollama: sha256 → /api/blobs → /api/create с template/parameters от qwen3:8b
      (иначе пропадут tools/thinking), adapter-режим (from + adapters), quantize q4_K_M для f16
- [x] Этап 8: голос — faster-whisper на CPU (int8, small, beam 1, VAD), модель скачивается один раз
      в data/models/whisper; своё decode_audio через PyAV (faster-whisper 1.2 падает на PyAV 14+ из-за
      metadata_errors); MediaRecorder webm/opus → текст в поле ввода (не автоотправка). Экспорт: диалог в
      MD/JSON, архив всех. scripts/launcher.py (только stdlib до старта): pip по хэшу requirements,
      ensurepip, «уже запущен», запуск Ollama, предложение скачать модели (отказ от bge-m3 запоминается),
      порт занят. start.bat/start.sh — только venv. Итоговый README

- [x] Интерфейс «Джарвис» (после этапа 8): тема HUD по умолчанию (frontend/css/hud.css, `<html data-theme>`,
      классическая сохранена), анимированное SVG-ядро с состояниями idle/thinking/speaking/listening
      (body[data-core]), заставка запуска (раз за сессию, ?boot — принудительно, не при navigator.webdriver),
      приветствие по времени суток «…, {address}.», часы; персона «Джарвис» (по умолчанию, sort_order −1,
      «Да, {address}.»), настройки address/ui_theme/tts_enabled/tts_voice/tts_rate/ui_sounds;
      озвучка speechSynthesis ТОЛЬКО localService-голосами (офлайн, мужской Pavel по возможности), код
      не зачитывается; звуки — Web Audio. Шрифты Exo 2/Jura/Orbitron (OFL) локально. Без логотипов Marvel

- [x] Этап 9: документы. Миграция №6: files (upload|generated, text, meta JSON; файл в data/files/<id>/<имя>;
      conversation_id CASCADE + cleanup() папок при старте/удалении диалога; брошенные вложения > суток удаляются).
      Вложения: POST /api/files (≤25 МБ, текст извлекается сразу: парсеры этапа 4 для PDF/DOCX + openpyxl XLSX,
      python-pptx PPTX, CSV→таблица, код в ```); attachments в MessageCreate; все файлы диалога (5 свежих, вкл.
      созданные) каждый раз идут в последний вопрос: целиком или выдержки (≈40% num_ctx, поиск по словам или
      равномерно), помечены как ДАННЫЕ. Инструменты create_word_document (markdown→docx со стилями Word),
      create_presentation (16:9, макеты с настоящими заголовками, маркеры через XML), create_spreadsheet (числа,
      формулы СУММ→SUM), edit_word_document (замены по прогонам с сохранением оформления → копия «(исправлено)»);
      без подтверждения: файлы только внутри приложения. «Скачать как Word» под ответом, предпросмотр в карточке
- [x] Этап 10: артефакты — модель пишет ```html/```svg/```mermaid (не инструмент: надёжнее для 8B и работает без
      tools); ARTIFACTS_HINT в системном промпте (настройка artifacts_enabled); compact_history: полный код только у
      последней версии каждого артефакта (ключ lang+<title>). Фронтенд artifacts.js: карточки вместо кода (во время
      стрима «пишу код…», «код оборвался» при незакрытом ```), панель справа (просмотр/код, версии по одинаковому
      title, перезапуск, весь экран, скачать, ширина тянется), iframe sandbox="allow-scripts …" БЕЗ allow-same-origin
      + CSP meta (connect-src 'none'), перехват ошибок → postMessage с токеном → «🛠 Исправить» (номер строки
      пересчитывается назад после вставки), CDN-ссылки Three.js r149/Chart.js 4 → локальная копия из
      vendor/artifact-libs; Mermaid 10 (vendor, грузится лениво, securityLevel strict); SVG — через <img> (скрипты не идут)
- [x] Этап 11: «умнее и обучаемее». Миграция №7: lessons (content, source correction|feedback|manual, enabled).
      POST /api/lessons/learn: 👎 с быстрой причиной без текста → готовое правило без модели (wrong/offtopic → нет
      урока); исправление или пояснение → модель по JSON-схеме {general, lesson, replaces(0=нет)}, разовые правки
      факта — general=false; похожий (корни ≥0.6) или replaces → обновление. Блок уроков в системном промпте
      (≤400 ток., свежие первыми), настройка lessons_enabled; в чате «📘 Урок · Отменить», раздел «Уроки» в «Памяти».
      Авто-размышления: chat/complexity.py (баллы: математика/отладка/логика 2, анализ/вычисления/код 1;
      «напиши игру/реферат» −2; порог 2), настройка auto_think, extras.auto_think. «▶ Проверить»: Python →
      POST /api/tools/run-python (та же песочница), JS → iframe sandbox+CSP, console → postMessage; «Исправить».
      Исправлена гонка: отложенный rAF стрима больше не затирает финальную отрисовку ответа
- [x] Этап 12: нейроголос — Piper (piper-tts, onnxruntime на CPU, espeak-ng внутри колеса). backend/voice/tts.py:
      голоса ru_RU ruslan (по умолчанию)/dmitri/denis/irina medium с HuggingFace или hf-mirror (PIPER_VOICES_URL
      переопределяет), фоновое скачивание с прогрессом (.part → rename), Engine держит один голос, синтез в потоке
      под замком, length_scale = 1.08/rate («дворецкий»). API /api/voice/tts (GET статус, POST текст→WAV, /download,
      DELETE голоса); настройки tts_engine (neural|system, фолбэк на доступный), tts_neural_voice, tts_effect.
      Фронтенд speech.js: сессия-очередь, createStreamSpeaker — законченные предложения вне блоков кода уходят на
      синтез во время стрима, предзагрузка 2 следующих, Web Audio: playbackRate 0.965 + highpass + presence + лёгкий
      reverb (сгенерированный импульс). Клонирование голоса актёра — нет (голос реального человека).
      Тесты на голосе-пустышке tests/fake_piper.py (ONNX с интерфейсом Piper — путь через настоящий piper/espeak/onnxruntime);
      HuggingFace из контейнера недоступен, звучание настоящих голосов проверяет пользователь.
      Пользователь: «работать с моделями» = 3D-модели; голос — русский «британский дворецкий»
- [x] Этап 13: картинки — backend/images. diffusers + PyTorch cu126 ставятся ПО КНОПКЕ (installer.py: pip в фоне
      тем же python, лог в UI), не в requirements. Модели: dreamshaper (Lykon/dreamshaper-8, SD1.5, fp16, DPM++ 2M
      Karras, attention slicing, 25 шагов) и sdxl-turbo (+ madebyollin/sdxl-vae-fp16-fix, model_cpu_offload, 4 шага,
      guidance 0); snapshot_download (fp16-файлы, без safety_checker; фолбэк на полные веса), прогресс по размеру
      папки, зеркало hf-mirror через endpoint. Перед рисованием LLMBackend.unload_all() (Ollama keep_alive=0), после —
      pipe.to("cpu") + empty_cache (SDXL выгружается из ОЗУ). Generator на CPU (seed повторяем). Картинки — files
      (generated, image/png, meta prompt/seed/…). Инструмент generate_image (промпт по-английски, orientation,
      count ≤4) + tool_progress в SSE (чат опрашивает tool.progress раз в 0,5 с), «Стоп» → engine.cancel.
      /api/images: status/install/download/generate(translate через LLM)/cancel/gallery. «Ещё вариант» дописывает в
      extras карточки ответа. IMAGE_ENGINE=fake — заглушка (Pillow) для тестов; настоящий diffusers проверяет пользователь
- [x] Этап 14: зрение. ModelInfo.supports_vision (capability "vision" из /api/show). Картинки-вложения
      (png/jpg/webp/gif/bmp; HEIC — отказ с подсказкой): оригинал + files/<id>/vision.jpg (EXIF-поворот, прозрачность →
      белый, ≤1280 px, JPEG 85; лимит 60 Мп), /api/files/{id}/preview. Сканы PDF (парсер говорит «нет текста/скан») →
      pypdf page.images, первые 4 страницы → page-N.jpg, meta type=scan. В чате: картинки самого свежего сообщения
      среди 3 последних пользовательских (≤4), base64 в messages[-1].images (Ollama; llama.cpp → content parts
      image_url), подпись «[приложены изображения…]» в вопросе, бюджет истории уменьшается на токены картинок.
      Если модель не видит — подмена на settings.vision_model (qwen3-vl:8b), нет её — LLMError с подсказкой.
      extras/start.vision {model, images, instead_of}. /api/models/vision (каталог: qwen3-vl:8b, qwen2.5vl:7b,
      gemma3:4b, minicpm-v:8b) и /api/models/pull (Ollama /api/pull с прогрессом, LLMBackend.pull). UI: миниатюры в
      чипах и сообщениях, Ctrl+V скриншота, «👁 N картинка», «Подключаю модель зрения…», раздел в настройках

Этапы 1–14 готовы. Дальше по плану: 15 проекты, удобство и 3D-модели.
