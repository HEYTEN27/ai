# Браузерные проверки интерфейса (необязательно)

Сквозные проверки через Playwright: открывают интерфейс в Chromium и прокликивают
сценарии (отправка, стриминг, «Стоп», «Повторить», VRAM-предупреждение, телефон).

Нужны Node.js и Playwright (`npm i -g playwright && npx playwright install chromium`).

1. Запустите эмулятор Ollama и сервер на чистой базе:
   ```bash
   FAKE_DELAY=0.04 python -m uvicorn tests.fake_ollama:app --port 11434
   DATA_DIR=/tmp/assistant-e2e python -m backend
   ```
2. Сценарии (каждый — на чистой базе):
   - `node tests/e2e/ui.js` — этап 1: чат, стриминг, «Стоп», «Повторить», VRAM;
   - `node tests/e2e/settings.js` — этап 2: персоны, настройки, оценка VRAM;
   - `node tests/e2e/memory.js` — этап 3: запоминание, отмена, страница «Память»;
   - `node tests/e2e/knowledge.js` — этап 4: загрузка, папка Obsidian, ссылки на источники;
   - `node tests/e2e/tools.js` — этап 5: инструменты, подтверждения, поиск (через поддельный SearXNG);
   - `node tests/e2e/dataset.js` — этап 6: 👍/👎, исправления, страница «Датасет», экспорт;
   - `node tests/e2e/training.js` — этап 7: пакет для Colab, подключение модели к Ollama;
   - `node tests/e2e/polish.js` — этап 8: голосовой ввод (поддельный микрофон) и экспорт.
     Сервер для него — `python tests/e2e/serve_fake_voice.py` (заглушка Whisper, но запись
     из браузера декодируется по-настоящему);
   - `node tests/e2e/documents.js` — этап 9: вложения, создание Word/PowerPoint/Excel, правка Word, перетаскивание;
   - `node tests/e2e/artifacts.js` — этап 10: игры в песочнице, версии, «Исправить», Three.js офлайн, схемы, SVG;
   - `node tests/e2e/lessons.js` — этап 11: уроки из 👎 и исправлений, авто-размышления, «▶ Проверить» Python/JS;
   - `node tests/e2e/voice_neural.js` — этап 12: скачивание голоса, озвучка по предложениям во время ответа.
     Сервер для него — с адресом «HuggingFace» в эмуляторе: `PIPER_VOICES_URL=http://127.0.0.1:11434/_voices python -m backend`
     (голос-пустышка собирается из `tests/fake_piper.py`, нужен пакет onnx из requirements-dev.txt);
   - `node tests/e2e/images.js` — этап 13: модель, рисование со страницы и в чате, прогресс, галерея.
     Сервер — с движком-заглушкой: `IMAGE_ENGINE=fake FAKE_IMAGE_STEP=0.04 python -m backend`;
   - `node tests/e2e/vision.js` — этап 14: вставка скриншота, скачивание модели зрения, ответ по картинке;
   - `node tests/e2e/projects.js` — этап 15а: проекты, стиль, правка вопроса и ветки, поиск Ctrl+K;
   - `node tests/e2e/models3d.js` — этап 15б: 3D-модель с вырезами, экспорт STL/OBJ/GLB, ошибка, свой STL;
   - `node tests/e2e/hud.js` — интерфейс «Джарвис»: заставка, ядро, «…, сэр», озвучка
     (поддельный голос Windows), обращение, смена темы, телефон;
   - `node tests/e2e/ollama_down.js` — при остановленном эмуляторе.

Скриншоты сохраняются в `tests/e2e/screenshots/`.

В Linux без настроенной локали запускайте с `LANG=C.UTF-8 LC_ALL=C.UTF-8`: иначе Chromium
не прочитает тестовые файлы с кириллицей в имени.
