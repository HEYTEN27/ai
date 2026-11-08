"""Тесты этапа 5: инструменты — калькулятор, файлы, песочница, веб, цикл вызовов, подтверждения."""

import asyncio
import json
import os
import time

import httpx
import pytest

from backend.tools import calculator, files, sandbox, web
from backend.tools import confirm as tool_confirm
from backend.tools import registry
from tests import fake_ollama
from tests.conftest import parse_sse
from tests.test_knowledge import make_pdf
from tests.test_stop import live_servers  # noqa: F401 — фикстура живых серверов


def _ask(client, text, **conv):
    conv_id = client.post("/api/conversations", json=conv).json()["id"]
    events = parse_sse(client.post(f"/api/conversations/{conv_id}/messages", json={"content": text}).text)
    return conv_id, events


def _of(events, kind):
    return [d for e, d in events if e == kind]


# ---------- калькулятор ----------


@pytest.mark.parametrize("expr, result", [
    ("2+2*2", "6"), ("(2+3)^2 / sqrt(16)", "6.25"), ("2,5 * 4", "10"), ("10 // 3", "3"), ("2**0.5", "1.41421356237"),
    ("sin(pi/2)", "1"), ("5!", "120"), ("√81", "9"), ("log(1000)", "3"), ("max(3, 7, 1)", "7"), ("-(-3)", "3"),
])
def test_calculator(expr, result):
    assert calculator.calculate(expr)["result"] == result


@pytest.mark.parametrize("expr, error", [
    ("__import__('os').system('ls')", "недопустимая"), ("().__class__", "недопустимая"), ("1/0", "деление на ноль"),
    ("9**9**9", "степень"), ("10**4000 * 10**4000", "цифр"), ("factorial(5000)", "факториал"), ("open('x')", "недопустимая"),
    ("2 +", "не понимаю"), ("'a' * 3", "недопустимая"),
])
def test_calculator_rejects_dangerous_and_invalid(expr, error):
    with pytest.raises(calculator.CalcError, match=error):
        calculator.calculate(expr)


# ---------- файлы ----------


@pytest.fixture
def workdir(tmp_path):
    root = tmp_path / "Проект"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.js").write_text("console.log('привет');", encoding="utf-8")
    (root / "заметки.txt").write_bytes("Старая заметка в cp1251".encode("cp1251"))
    (root / "node_modules" / "lib").mkdir(parents=True)
    (root / "node_modules" / "lib" / "x.js").write_text("x", encoding="utf-8")
    (root / "image.png").write_bytes(b"\x89PNG\r\n\x00\x00\x00binary")
    (tmp_path / "секрет.txt").write_text("пароль", encoding="utf-8")
    return root


def test_files_list_and_read(workdir):
    listing = files.list_files(str(workdir), ".", recursive=True)
    paths = [e["path"] for e in listing["entries"]]
    assert "src/" in paths and "src/app.js" in paths and not any("node_modules" in p for p in paths)
    assert files.read_file(str(workdir), "src/app.js")["content"] == "console.log('привет');"
    assert files.read_file(str(workdir), "заметки.txt")["content"] == "Старая заметка в cp1251"
    with pytest.raises(files.FileToolError, match="двоичный"):
        files.read_file(str(workdir), "image.png")


@pytest.mark.parametrize("bad", ["../секрет.txt", "src/../../секрет.txt", "/etc/passwd", "..\\секрет.txt"])
def test_files_cannot_escape_root(workdir, bad):
    with pytest.raises(files.FileToolError, match="за пределы|не найден"):
        files.read_file(str(workdir), bad)


def test_files_symlink_escape_blocked(workdir):
    link = workdir / "ярлык.txt"
    try:
        os.symlink(workdir.parent / "секрет.txt", link)
    except (OSError, NotImplementedError):
        pytest.skip("символические ссылки недоступны")
    with pytest.raises(files.FileToolError, match="за пределы"):
        files.read_file(str(workdir), "ярлык.txt")


def test_files_pdf_and_truncation(workdir):
    make_pdf(workdir / "lecture.pdf", ["Page one text about closures", "Page two about event loop"])
    text = files.read_file(str(workdir), "lecture.pdf")["content"]
    assert "[стр. 2]" in text and "event loop" in text
    (workdir / "big.txt").write_text("а" * 50_000, encoding="utf-8")
    big = files.read_file(str(workdir), "big.txt")
    assert big["truncated"] and len(big["content"]) == files.MAX_READ_CHARS


def test_files_without_root():
    with pytest.raises(files.FileToolError, match="не выбрана"):
        files.list_files("", ".")


# ---------- песочница ----------


def _py(code, timeout=5):
    return asyncio.run(sandbox.run_python(code, timeout=timeout))


def test_sandbox_runs_code_and_reports_files():
    r = _py("import numpy as np\nprint(np.arange(4).sum(), 'готово')\nopen('out.csv','w').write('a,b')")
    assert r["stdout"].strip() == "6 готово" and r["exit_code"] == 0
    assert r["files"] == [{"name": "out.csv", "size": 3}]


@pytest.mark.parametrize("code, blocked", [
    ("import socket; socket.create_connection(('example.com', 80))", "socket"),
    ("import subprocess; subprocess.run(['ls'])", "subprocess"),
    ("import os; os.system('echo hi')", "os.system"),
    (f"print(open({os.path.abspath(__file__)!r}).read())", "доступ к файлу запрещён"),  # файл проекта вне песочницы
    ("open('/tmp/jarvis_evil.txt', 'w').write('x')", "доступ к файлу запрещён"),
    ("import ctypes", "ctypes"),
])
def test_sandbox_blocks_dangerous_actions(code, blocked):
    r = _py(code)
    assert r["exit_code"] != 0 and blocked in r["stderr"]
    assert not os.path.exists("/tmp/jarvis_evil.txt")


def test_sandbox_timeout():
    started = time.monotonic()
    r = _py("while True: pass", timeout=1)
    assert r["timed_out"] and time.monotonic() - started < 5


# ---------- веб ----------

DDG_HTML = """
<div class="result results_links web-result"><h2><a rel="nofollow" class="result__a"
 href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fru%2Fdocs%2FClosures&amp;rut=x">Замыкания - <b>JavaScript</b> | MDN</a></h2>
<a class="result__snippet" href="#">Замыкание — это комбинация функции и лексического окружения.</a></div>
<div class="result results_links web-result"><h2><a class="result__a" href="https://learn.javascript.ru/closure">Замыкание</a></h2>
<a class="result__snippet">Современный учебник JavaScript.</a></div>
"""


def test_duckduckgo_parsing():
    results = web.parse_duckduckgo(DDG_HTML, 5)
    assert results[0] == {"title": "Замыкания - JavaScript | MDN", "url": "https://developer.mozilla.org/ru/docs/Closures",
                          "snippet": "Замыкание — это комбинация функции и лексического окружения."}
    assert results[1]["url"] == "https://learn.javascript.ru/closure"


def test_search_providers():
    def handler(request):
        if request.url.host == "html.duckduckgo.com":
            assert request.method == "POST"
            return httpx.Response(200, text=DDG_HTML)
        assert request.url.params["format"] == "json"
        return httpx.Response(200, json={"results": [{"title": "T", "url": "https://x.org", "content": "C"}]})

    transport = httpx.MockTransport(handler)
    ddg = asyncio.run(web.search("замыкания", transport=transport))
    assert len(ddg) == 2
    sx = asyncio.run(web.search("q", provider="searxng", searxng_url="http://my-searx:8888", transport=transport))
    assert sx == [{"title": "T", "url": "https://x.org", "snippet": "C"}]
    with pytest.raises(web.WebError, match="SearXNG"):
        asyncio.run(web.search("q", provider="searxng", searxng_url="", transport=transport))


@pytest.mark.parametrize("url", ["http://127.0.0.1:11434/api/tags", "http://localhost:8000/api/knowledge",
                                 "http://192.168.1.1/", "http://10.0.0.5/", "ftp://example.org/x", "file:///etc/passwd"])
def test_open_url_blocks_local_addresses(url):
    with pytest.raises(web.WebError, match="SSRF|http"):
        asyncio.run(web.check_url(url))


def test_open_url_extracts_text_and_checks_redirects(monkeypatch):
    monkeypatch.setattr(web, "_is_public_host", lambda host: host.endswith(".test"))
    page = ("<html><head><title>Статья</title><style>.x{}</style></head><body><nav>Меню</nav>"
            "<h1>Заголовок</h1><p>Первый абзац.</p><script>alert(1)</script><p>Второй.</p></body></html>")

    def handler(request):
        if request.url.path == "/redirect-to-local":
            return httpx.Response(302, headers={"location": "http://127.0.0.1:11434/api/tags"})
        return httpx.Response(200, text=page, headers={"content-type": "text/html; charset=utf-8"})

    transport = httpx.MockTransport(handler)
    result = asyncio.run(web.open_url("https://site.test/article", transport=transport))
    assert result["title"] == "Статья"
    assert "Первый абзац." in result["content"] and "alert" not in result["content"] and "Меню" not in result["content"]
    with pytest.raises(web.WebError, match="SSRF"):
        asyncio.run(web.open_url("https://site.test/redirect-to-local", transport=transport))


# ---------- цикл инструментов в чате ----------


def test_calculator_tool_flow(client):
    conv_id, events = _ask(client, "Посчитай (2+3)^2 / sqrt(16)")
    start = events[0][1]
    assert "calculator" in start["tools"] and "read_file" not in start["tools"], "файлы недоступны без папки"
    [tool_start] = _of(events, "tool_start")
    assert tool_start["name"] == "calculator" and tool_start["needs_confirm"] is False
    assert tool_start["summary"] == "(2+3)^2 / sqrt(16)"
    [result] = _of(events, "tool_result")
    assert result["status"] == "ok" and result["display"]["result"] == "6.25"

    first, second = fake_ollama.state["chat_requests"][-2:]
    assert {t["function"]["name"] for t in first["tools"]} >= {"calculator", "web_search", "run_python"}
    assert "У тебя есть инструменты" in first["messages"][0]["content"]
    assert second["messages"][-2]["tool_calls"][0]["function"]["name"] == "calculator"
    assert second["messages"][-1] == {"role": "tool", "content": "(2+3)^2 / sqrt(16) = 6.25", "tool_name": "calculator"}

    msg = client.get(f"/api/conversations/{conv_id}").json()["messages"][-1]
    assert msg["content"].startswith("Сейчас проверю.") and "6.25" in msg["content"]
    assert msg["extras"]["tools"][0]["display"]["result"] == "6.25", "карточка сохранена для перезагрузки"


def test_two_tools_in_one_step(client):
    _, events = _ask(client, "Используй два инструмента сразу")
    assert [r["display"]["result"] for r in _of(events, "tool_result")] == ["4", "9"]


def test_tool_loop_is_limited(client):
    _, events = _ask(client, "ЦИКЛ — вызывай калькулятор бесконечно")
    assert len(_of(events, "tool_result")) == 6, "не больше 6 вызовов за ответ"
    assert "tools" not in fake_ollama.state["chat_requests"][-1], "последний запрос — без инструментов, чтобы получить ответ"
    assert _of(events, "done")


def test_tools_disabled_or_unsupported(client):
    # Модель без поддержки инструментов. (Меняем до первого запроса: возможности моделей кэшируются.)
    caps = fake_ollama.MODELS["llama3.1:8b"]["capabilities"]
    fake_ollama.MODELS["llama3.1:8b"]["capabilities"] = ["completion"]
    try:
        _, events = _ask(client, "Посчитай 2+2", model="llama3.1:8b")
        assert events[0][1]["tools"] == [] and "tools" not in fake_ollama.state["last_request"]
    finally:
        fake_ollama.MODELS["llama3.1:8b"]["capabilities"] = caps

    client.put("/api/settings", json={"tools_enabled": False})
    _ask(client, "Посчитай 2+2")
    assert "tools" not in fake_ollama.state["last_request"]
    assert "инструменты" not in fake_ollama.state["last_request"]["messages"][0]["content"]


def test_python_tool_without_confirmation(client):
    client.put("/api/settings", json={"confirm_python": False})
    _, events = _ask(client, "Запусти код:\n```python\nprint(sum(range(101)))\n```")
    [result] = _of(events, "tool_result")
    assert result["status"] == "ok" and result["display"]["stdout"].strip() == "5050"
    assert "5050" in fake_ollama.state["last_request"]["messages"][-1]["content"]


def test_web_search_tool(client, monkeypatch):
    async def fake_search(query, **kwargs):
        return [{"title": f"Про {query}", "url": "https://example.org", "snippet": "Описание"}]
    monkeypatch.setattr(web, "search", fake_search)
    _, events = _ask(client, "Найди в интернете курс доллара")
    [result] = _of(events, "tool_result")
    assert result["display"]["results"][0]["title"] == "Про курс доллара"
    assert "https://example.org" in fake_ollama.state["last_request"]["messages"][-1]["content"]


def test_tool_errors_are_reported_to_model(client):
    _, events = _ask(client, "Посчитай 1/0")
    [result] = _of(events, "tool_result")
    assert result["status"] == "error" and "деление на ноль" in result["display"]["error"]
    assert fake_ollama.state["last_request"]["messages"][-1]["content"] == "Ошибка: деление на ноль"


def test_tools_api_and_settings_validation(client, workdir):
    tools = {t["name"]: t for t in client.get("/api/tools").json()}
    assert tools["read_file"]["available"] is False and tools["read_file"]["reason"] == "не выбрана папка"
    assert tools["run_python"]["needs_confirm"] is True and tools["web_search"]["online"] is True
    assert client.put("/api/settings", json={"files_root": "/нет/такой/папки"}).status_code == 422
    assert client.put("/api/settings", json={"files_root": str(workdir)}).status_code == 200
    assert client.get("/api/tools").json()[4]["available"] is True
    check = client.get("/api/tools/files/check", params={"path": str(workdir)}).json()
    assert check["files"] == 3, "app.js, заметки.txt, image.png (node_modules пропущена)"
    assert client.post("/api/tools/confirm/nope", json={"approved": True}).status_code == 404


# ---------- подтверждения (живые серверы: ответ на кнопку идёт отдельным запросом) ----------


def _stream_with_answer(base, conv_id, text, approve: bool | None):
    """Читает поток ответа; на tool_confirm отвечает кнопкой (или обрывает, если approve=None)."""
    events = []
    with httpx.stream("POST", f"{base}/api/conversations/{conv_id}/messages", json={"content": text}, timeout=20) as r:
        event = None
        for line in r.iter_lines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:])
                events.append((event, data))
                if event == "tool_confirm":
                    if approve is None:
                        return events  # «Стоп» во время ожидания
                    assert data["id"] in tool_confirm.pending_ids()
                    httpx.post(f"{base}/api/tools/confirm/{data['id']}", json={"approved": approve})
    return events


def test_file_read_requires_confirmation(live_servers, workdir):  # noqa: F811
    base = live_servers
    httpx.put(f"{base}/api/settings", json={"files_root": str(workdir)})
    conv_id = httpx.post(f"{base}/api/conversations", json={}).json()["id"]

    events = _stream_with_answer(base, conv_id, "Прочитай файл src/app.js", approve=True)
    [confirm] = _of(events, "tool_confirm")
    assert confirm["name"] == "read_file" and confirm["summary"] == "src/app.js"
    [result] = _of(events, "tool_result")
    assert result["status"] == "ok" and "console.log" in result["display"]["content"]
    assert "console.log" in fake_ollama.state["last_request"]["messages"][-1]["content"]

    events = _stream_with_answer(base, conv_id, "Прочитай файл заметки.txt", approve=False)
    [result] = _of(events, "tool_result")
    assert result["status"] == "declined"
    assert fake_ollama.state["last_request"]["messages"][-1]["content"] == "Пользователь отклонил это действие."
    assert "Старая заметка" not in json.dumps(fake_ollama.state["last_request"], ensure_ascii=False)


def test_stop_while_waiting_for_confirmation(live_servers, workdir):  # noqa: F811
    base = live_servers
    httpx.put(f"{base}/api/settings", json={"files_root": str(workdir)})
    conv_id = httpx.post(f"{base}/api/conversations", json={}).json()["id"]
    _stream_with_answer(base, conv_id, "Покажи файлы в папке", approve=None)
    for _ in range(40):
        if not tool_confirm.pending_ids():
            break
        time.sleep(0.1)
    assert tool_confirm.pending_ids() == [], "ожидание подтверждения убрано после «Стоп»"
    msgs = httpx.get(f"{base}/api/conversations/{conv_id}").json()["messages"]
    assert msgs[-1]["role"] == "assistant" and msgs[-1]["stopped"] is True


def test_registry_schema_shape():
    schema = registry.TOOLS["calculator"].schema()
    assert schema["type"] == "function" and schema["function"]["parameters"]["required"] == ["expression"]
