@echo off
rem ================================================================
rem  Запуск ассистента на Windows: двойной клик по этому файлу.
rem  При первом запуске создаёт виртуальное окружение и ставит пакеты.
rem  (Полноценный скрипт с проверками появится на этапе 8.)
rem ================================================================
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/2] Создаю виртуальное окружение Python...
    py -3.12 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || python -m venv .venv
    if errorlevel 1 (
        echo Не найден Python. Установите Python 3.12 с python.org ^(галочка "Add to PATH"^).
        pause
        exit /b 1
    )
)

echo [2/2] Проверяю зависимости...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo Не удалось установить зависимости. Проверьте интернет и запустите ещё раз.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -m backend --open
pause
