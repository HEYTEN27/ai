#!/usr/bin/env bash
# Запуск ассистента на Linux/macOS:  ./start.sh   (флаг --yes — скачать всё без вопросов)
# Здесь только создаётся окружение Python — остальное делает scripts/launcher.py.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
    PY=""
    for candidate in python3.12 python3.11 python3; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
            PY="$candidate"
            break
        fi
    done
    if [ -z "$PY" ]; then
        echo "Нужен Python 3.11 или 3.12 (например: sudo apt install python3.12 python3.12-venv)"
        exit 1
    fi
    echo "Создаю окружение Python (один раз)..."
    "$PY" -m venv .venv
fi

exec .venv/bin/python scripts/launcher.py "$@"
