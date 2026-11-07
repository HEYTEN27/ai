# Джарвис — личный локальный ИИ-ассистент

Чат-ассистент, который работает **целиком на вашем компьютере** через [Ollama](https://ollama.com).
Данные никуда не отправляются.

> Проект в разработке, сейчас готов **этап 1**: чат со стримингом, история диалогов,
> выбор модели, «размышления» Qwen3, индикатор видеопамяти.
> Полная инструкция появится на этапе 8.

## Что нужно

- Windows 10/11 (Linux/macOS тоже работают)
- Видеокарта NVIDIA с 8 ГБ памяти (проверено под RTX 2060 Super)
- [Ollama](https://ollama.com/download)
- [Python 3.12](https://www.python.org/downloads/) (при установке отметьте «Add python.exe to PATH»)

## Быстрый старт (Windows)

1. Скачайте модели (один раз, ~5 ГБ):
   ```bat
   ollama pull qwen3:8b
   ollama pull llama3.1:8b
   ```
   Вторая модель нужна только для сравнения, её можно пропустить.
2. Дважды кликните по `start.bat`. Он создаст окружение, установит пакеты и откроет
   интерфейс по адресу http://127.0.0.1:8000.

Вручную (любая ОС):
```bash
python -m venv .venv
.venv\Scripts\activate          # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python -m backend --open
```

## Настройки

Скопируйте `.env.example` в `.env` и меняйте значения при необходимости: имя ассистента
(`ASSISTANT_NAME`, по умолчанию «Джарвис»), адрес Ollama,
модель по умолчанию, размер контекста (`NUM_CTX`, по умолчанию 8192), порт.

Переход на llama.cpp вместо Ollama: `LLM_BACKEND=llamacpp` и запущенный
`llama-server -m модель.gguf -c 8192 -ngl 99 --jinja --port 8080`.

## Структура

```
backend/
  main.py          сборка приложения FastAPI
  config.py        настройки из переменных окружения / .env
  db.py            SQLite и миграции схемы
  llm/             адаптеры движков: Ollama, llama.cpp (общий интерфейс base.py)
  chat/            диалоги: хранение, сборка контекста, API со стримингом
  system/          здоровье Ollama, список моделей, состояние VRAM
frontend/          интерфейс на чистом HTML/CSS/JS, библиотеки в vendor/ (без CDN)
tests/             тесты и эмулятор Ollama (работают без видеокарты)
data/              ваша база диалогов (не попадает в git)
```

## Тесты

```bash
pip install -r requirements-dev.txt
python -m pytest
```

Тестам не нужны ни Ollama, ни видеокарта: они используют эмулятор `tests/fake_ollama.py`.
Его можно запустить и отдельно, чтобы поработать с интерфейсом без модели:
`python -m uvicorn tests.fake_ollama:app --port 11434`.
