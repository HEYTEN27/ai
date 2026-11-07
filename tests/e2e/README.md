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
   - `node tests/e2e/ollama_down.js` — при остановленном эмуляторе.

Скриншоты сохраняются в `tests/e2e/screenshots/`.
