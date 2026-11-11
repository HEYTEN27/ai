"""Тесты этапа 15б: 3D-модели — разбор STL/OBJ/GLB (размеры, объём), вложения, подсказка модели, артефакты ```3d."""

import json
import struct

import numpy as np
import pytest

from backend.chat import artifacts
from backend.files import model3d
from tests import fake_ollama
from tests.conftest import parse_sse

# Коробка 10 × 20 × 30 мм: 8 вершин, 12 треугольников, объём 6 см³
V = np.array([[0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0], [0, 0, 30], [10, 0, 30], [10, 20, 30], [0, 20, 30]], float)
QUADS = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]  # наружу
TRIS = [(q[0], q[1], q[2]) for q in QUADS] + [(q[0], q[2], q[3]) for q in QUADS]


def stl_binary() -> bytes:
    out = bytearray(b"\0" * 80) + struct.pack("<I", len(TRIS))
    for t in TRIS:
        out += struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *V[i]) for i in t) + b"\0\0"
    return bytes(out)


def stl_ascii() -> bytes:
    lines = ["solid box"]
    for t in TRIS:
        lines += ["facet normal 0 0 0", " outer loop"] + [f"  vertex {V[i][0]} {V[i][1]} {V[i][2]}" for i in t] + [" endloop", "endfacet"]
    return "\n".join(lines + ["endsolid box"]).encode()


def obj_text() -> bytes:
    lines = [f"v {x} {y} {z}" for x, y, z in V] + ["f " + " ".join(f"{i + 1}/1/1" for i in q) for q in QUADS]
    return "\n".join(lines).encode()


def glb() -> bytes:
    pos = (V / 1000).astype("<f4").tobytes()  # glTF — в метрах
    idx = np.array(TRIS, dtype="<u2").tobytes()
    binary = pos + idx + b"\0" * ((4 - len(idx) % 4) % 4)
    doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(binary)}],
           "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos)},
                           {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx)}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3"},
                         {"bufferView": 1, "componentType": 5123, "count": 36, "type": "SCALAR"}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}]}
    js = json.dumps(doc).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    body = struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


@pytest.mark.parametrize("name, data", [("box.stl", stl_binary()), ("box_ascii.stl", stl_ascii()),
                                        ("box.obj", obj_text()), ("box.glb", glb())])
def test_analyze_formats(name, data):
    text, meta = model3d.analyze(data, name)
    assert meta["triangles"] == 12
    assert meta["size_mm"] == [10.0, 20.0, 30.0]
    assert meta["volume_cm3"] == pytest.approx(6.0, abs=0.01)
    assert "10,0 × 20,0 × 30,0 мм" in text and "6,0 см³" in text and "PLA" in text


def test_analyze_errors():
    with pytest.raises(model3d.ModelError):
        model3d.analyze(b"solid nothing endsolid", "x.stl")
    with pytest.raises(model3d.ModelError):
        model3d.analyze(b"f 1 2 3", "x.obj")
    with pytest.raises(model3d.ModelError):
        model3d.analyze(b"not a glb", "x.glb")


def test_model_upload_goes_to_context(client):
    r = client.post("/api/files", files={"file": ("деталь.stl", stl_binary())})
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["meta"]["type"] == "model3d" and f["meta"]["format"] == "stl" and f["mime"] == "model/stl"
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    parse_sse(client.post(f"/api/conversations/{conv_id}/messages",
                          json={"content": "Влезет на стол 220×220?", "attachments": [f["id"]]}).text)
    question = fake_ollama.state["last_request"]["messages"][-1]["content"]
    assert "3D-модель «деталь.stl»" in question and "10,0 × 20,0 × 30,0 мм" in question
    assert client.post("/api/files", files={"file": ("битая.stl", b"\x00" * 10)}).status_code == 422


def test_3d_hint_and_compaction(client):
    conv_id = client.post("/api/conversations", json={}).json()["id"]
    url = f"/api/conversations/{conv_id}/messages"
    for q in ("Сделай 3d-модель подставки", "Ещё раз 3d-модель", "Что получилось?"):
        parse_sse(client.post(url, json={"content": q}).text)
    req = fake_ollama.state["last_request"]
    assert "```3d" in req["messages"][0]["content"] and "subtract(a, b)" in req["messages"][0]["content"]
    answers = [m["content"] for m in req["messages"] if m["role"] == "assistant"]
    assert "опущен" in answers[0] and "subtract(body" in answers[1], "старая версия 3D-модели сжата"


def test_3d_title():
    assert artifacts.artifact_title("3d", "// title: Держатель\nadd(box(1,1,1))") == "Держатель"
    assert artifacts.artifact_title("3d", "add(box(1,1,1))") == "3D-модель"
    assert artifacts.is_artifact("3d", "add(box(1,1,1))")
