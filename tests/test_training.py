"""Тесты этапа 7: ноутбук Colab, локальный скрипт, пакет для обучения, подключение модели к Ollama."""

import ast
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

from backend.config import PROJECT_ROOT
from backend.training import ollama_import
from tests import fake_ollama
from tests.conftest import parse_sse

NOTEBOOK = PROJECT_ROOT / "training" / "colab_finetune.ipynb"


# ---------- ноутбук ----------


def _notebook() -> dict:
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))


def _python_source(cell) -> str:
    """Код ячейки без «магий» Colab (!команда, %%capture) — их Python не понимает."""
    source = cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
    return "\n".join("" if line.lstrip().startswith(("!", "%")) else line for line in source.splitlines())


def test_notebook_is_valid_and_code_compiles():
    nbformat = pytest.importorskip("nbformat")
    nb = nbformat.read(str(NOTEBOOK), as_version=4)
    nbformat.validate(nb)
    assert nb.metadata["accelerator"] == "GPU" and nb.metadata["colab"]["gpuType"] == "T4"
    code_cells = [c for c in nb.cells if c.cell_type == "code"]
    assert len(code_cells) >= 15
    for cell in code_cells:
        ast.parse(_python_source(cell))  # синтаксическая ошибка — упадёт здесь
    text = "\n".join(c.source for c in nb.cells)
    for must in ("fp16=not is_bfloat16_supported()", "train_on_responses_only", "q4_k_m", "enable_thinking=False",
                 "unsloth/Qwen3-8B-unsloth-bnb-4bit", "config.json", "drive.mount"):
        assert must in text, must


def _prep_namespace() -> dict:
    """Выполняет ячейку с функциями подготовки данных (в ней только стандартная библиотека)."""
    cell = next(c for c in _notebook()["cells"] if "prep-functions" in c.get("metadata", {}).get("tags", []))
    namespace = {"json": json, "Path": Path}
    exec(compile(_python_source(cell), "prep", "exec"), namespace)
    return namespace


def test_notebook_prep_functions(tmp_path):
    ns = _prep_namespace()
    good = {"messages": [{"role": "system", "content": "Ты Джарвис"}, {"role": "user", "content": "Привет"},
                         {"role": "assistant", "content": "Здравствуйте!"}]}
    lines = [
        json.dumps(good, ensure_ascii=False),
        json.dumps(good, ensure_ascii=False),  # дубликат
        "не json",
        json.dumps({"messages": [{"role": "user", "content": "без ответа"}]}),
        json.dumps({"messages": [{"role": "robot", "content": "x"}, {"role": "assistant", "content": "y"}]}),
        "",
    ]
    path = tmp_path / "train_sft.jsonl"
    path.write_text("\n".join(lines), encoding="utf-8")
    rows, errors = ns["load_jsonl"](path)
    assert len(rows) == 2 and len(errors) == 3
    assert "не JSON" in errors[0] and "messages" in errors[1] and "роль" in errors[2]
    assert len(ns["dedupe"](rows)) == 1

    many = [[{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}] for i in range(100)]
    train, evaluation = ns["split"](many)
    assert len(evaluation) == 10 and len(train) == 90 and not {id(x) for x in train} & {id(x) for x in evaluation}
    assert ns["split"](many[:20]) [1] == [], "меньше 50 примеров — без проверочной части"


def test_notebook_reads_real_export(client, tmp_path):
    """Датасет, который выгружает приложение, ноутбук должен принимать без ошибок."""
    conv = client.post("/api/conversations", json={}).json()["id"]
    parse_sse(client.post(f"/api/conversations/{conv}/messages", json={"content": "Что такое HTTP?"}).text)
    answer = [m for m in client.get(f"/api/conversations/{conv}").json()["messages"] if m["role"] == "assistant"][0]
    client.post("/api/dataset/feedback", json={"message_id": answer["id"], "rating": 1})
    data = client.get("/api/training/package").content
    jsonl = zipfile.ZipFile(io.BytesIO(data)).read("train_sft.jsonl").decode()
    path = tmp_path / "export_check.jsonl"
    path.write_text(jsonl, encoding="utf-8")
    rows, errors = _prep_namespace()["load_jsonl"](path)
    assert errors == [] and len(rows) == 1 and rows[0][-2]["content"] == "Что такое HTTP?"


# ---------- локальный скрипт ----------


def _train_local():
    spec = importlib.util.spec_from_file_location("train_local", PROJECT_ROOT / "training" / "train_local.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_local_script_imports_without_torch():
    before = set(sys.modules)
    module = _train_local()
    assert "torch" not in set(sys.modules) - before, "torch импортируется только при запуске обучения"
    args = module.parse_args([])
    assert args.base == "unsloth/Qwen3-4B-unsloth-bnb-4bit" and args.max_seq == 1024 and args.lora_r == 8


def test_local_script_vram_advice():
    m = _train_local()
    assert m.model_size_key("unsloth/Qwen3-8B-unsloth-bnb-4bit") == "8b"
    assert m.model_size_key("unsloth/Qwen3-4B-unsloth-bnb-4bit") == "4b"
    assert m.model_size_key("unsloth/Qwen3-1.7B-unsloth-bnb-4bit") == "1.7b"
    ok, text = m.vram_advice("unsloth/Qwen3-8B-unsloth-bnb-4bit", 7.3)
    assert not ok and "Colab" in text, "8B на 8 ГБ — честный отказ"
    ok, text = m.vram_advice("unsloth/Qwen3-4B-unsloth-bnb-4bit", 6.0)
    assert ok
    ok, text = m.vram_advice("unsloth/Qwen3-4B-unsloth-bnb-4bit", 1.5)
    assert not ok and "ollama stop" in text, "занята Ollama — подсказка её выключить"


def test_local_script_dataset(tmp_path):
    m = _train_local()
    row = {"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}
    path = tmp_path / "d.jsonl"
    path.write_text("\n".join([json.dumps(row)] * 3 + ["мусор"]), encoding="utf-8")
    assert len(m.load_jsonl(path)) == 1


# ---------- пакет для Colab ----------


def _like(client, question):
    conv = client.post("/api/conversations", json={}).json()["id"]
    parse_sse(client.post(f"/api/conversations/{conv}/messages", json={"content": question}).text)
    answer = [m for m in client.get(f"/api/conversations/{conv}").json()["messages"] if m["role"] == "assistant"][0]
    client.post("/api/dataset/feedback", json={"message_id": answer["id"], "rating": 1})


def test_status_and_package(client):
    status = client.get("/api/training/status").json()
    assert status["ready"] is False and status["checks"][0]["level"] == "error"
    assert client.get("/api/training/package").status_code == 400
    assert status["base_installed"] is True

    for q in ["Что такое замыкание?", "Как работает event loop?", "Объясни промисы"]:
        _like(client, q)
    status = client.get("/api/training/status").json()
    assert status["examples"] == 3 and status["ready"] is True
    assert status["checks"][0]["level"] == "warn" and "мало" in status["checks"][0]["text"]
    assert status["config"]["epochs"] == 3 and status["estimated_minutes"] > 20

    r = client.get("/api/training/package")
    assert r.headers["content-disposition"] == 'attachment; filename="jarvis_colab_package.zip"'
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert set(z.namelist()) == {"train_sft.jsonl", "config.json", "colab_finetune.ipynb", "ПРОЧТИ_МЕНЯ.txt"}
    config = json.loads(z.read("config.json"))
    assert config["base_model"] == "unsloth/Qwen3-8B-unsloth-bnb-4bit" and config["epochs"] == 3
    assert len(z.read("train_sft.jsonl").decode().splitlines()) == 3
    assert "3 примеров" in z.read("ПРОЧТИ_МЕНЯ.txt").decode()
    assert json.loads(z.read("colab_finetune.ipynb"))["nbformat"] == 4


def test_epochs_recommendation():
    from backend.training.package import recommended_epochs

    assert [recommended_epochs(n) for n in (10, 99, 100, 499, 500, 5000)] == [3, 3, 2, 2, 1, 1]


# ---------- подключение модели к Ollama ----------


@pytest.fixture
def gguf(tmp_path, monkeypatch):
    monkeypatch.setattr(ollama_import, "MIN_MODEL_BYTES", 1000)  # «модель» в тестах — пара мегабайт
    path = tmp_path / "jarvis-qwen3.Q4_K_M.gguf"
    path.write_bytes(b"GGUF" + bytes(range(256)) * 20_000)
    return path


def _import(client, **body):
    r = client.post("/api/training/import", json=body)
    return r.status_code, parse_sse(r.text) if r.status_code == 200 else r.json()


def test_import_full_gguf(client, gguf):
    status, events = _import(client, path=str(gguf), name="jarvis-qwen3")
    stages = [d.get("stage") for e, d in events if e == "progress"]
    assert stages[0] == "hash" and "upload" in stages and "create" in stages and stages[-1] == "done"
    assert events[-1][1]["model"] == "jarvis-qwen3:latest"

    created = fake_ollama.state["last_create"]
    assert created["files"] == {gguf.name: next(iter(fake_ollama.state["blobs"]))}
    assert created["template"] == fake_ollama.QWEN3_TEMPLATE, "шаблон скопирован с qwen3:8b"
    assert created["parameters"] == {"repeat_penalty": 1, "stop": ["<|im_start|>", "<|im_end|>"],
                                     "temperature": 0.6, "top_k": 20, "top_p": 0.95}
    assert "quantize" not in created

    models = {m["name"]: m for m in client.get("/api/models").json()["models"]}
    assert models["jarvis-qwen3:latest"]["supports_thinking"] and models["jarvis-qwen3:latest"]["supports_tools"]
    assert client.get("/api/training/status").json()["models"] == ["jarvis-qwen3:latest"]

    # Повторное подключение того же файла — без повторной загрузки
    _, events = _import(client, path=str(gguf), name="jarvis-qwen3-v2", quantize=True)
    assert any("уже есть" in (d.get("message") or "") for _, d in events)
    assert fake_ollama.state["last_create"]["quantize"] == "q4_K_M"


def test_import_adapter(client, gguf):
    adapter = gguf.with_name("jarvis-qwen3-lora.gguf")
    adapter.write_bytes(b"GGUF-lora" * 100)
    _, events = _import(client, path=str(adapter), name="jarvis-lora", kind="adapter")
    assert events[-1][1]["stage"] == "done"
    created = fake_ollama.state["last_create"]
    assert created["from"] == "qwen3:8b" and list(created["adapters"]) == ["jarvis-qwen3-lora.gguf"]

    fake_ollama.state["adapters_unsupported"] = True
    _, events = _import(client, path=str(adapter), name="jarvis-lora-2", kind="adapter")
    assert events[-1][0] == "error" and "полный GGUF" in events[-1][1]["message"]


@pytest.mark.parametrize("body, error", [
    ({"path": "/нет/файла.gguf"}, "не найден"),
    ({"name": "Джарвис!"}, "Имя модели"),
    ({"kind": "zip"}, "Вид файла"),
])
def test_import_validation(client, gguf, body, error):
    status, data = _import(client, **{"path": str(gguf), "name": "jarvis", **body})
    assert status == 422 and error in data["detail"]


def test_import_rejects_wrong_files(client, gguf, tmp_path, monkeypatch):
    txt = tmp_path / "model.bin"
    txt.write_bytes(b"x" * 2000)
    assert "Нужен файл .gguf" in _import(client, path=str(txt), name="jarvis")[1]["detail"]
    monkeypatch.setattr(ollama_import, "MIN_MODEL_BYTES", 10**9)
    assert "меньше 100 МБ" in _import(client, path=str(gguf), name="jarvis")[1]["detail"]


def test_parse_parameters():
    text = 'stop "<|im_end|>"\nstop "</s>"\ntemperature 0.7\nnum_ctx 4096\nmirostat_tau 5.0\nseed abc'
    assert ollama_import.parse_parameters(text) == {"stop": ["<|im_end|>", "</s>"], "temperature": 0.7,
                                                    "num_ctx": 4096, "mirostat_tau": 5.0, "seed": "abc"}
