@echo off
rem ================================================================
rem  Запуск ассистента на Windows: двойной клик по этому файлу.
rem  Здесь только создаётся окружение Python — всё остальное
rem  (пакеты, Ollama, модели, браузер) делает scripts\launcher.py.
rem  Флаги: start.bat --yes   (скачать всё без вопросов)
rem ================================================================
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Создаю окружение Python ^(один раз^)...
    py -3.12 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || python -m venv .venv
    if errorlevel 1 goto :no_python
)

".venv\Scripts\python.exe" scripts\launcher.py %*
if errorlevel 1 pause
exit /b

:no_python
echo.
echo Не найден Python 3.11 или 3.12.
echo Установите Python 3.12 с https://www.python.org/downloads/
echo (при установке отметьте галочку "Add python.exe to PATH") и запустите start.bat снова.
pause
exit /b 1
