"""
Файлы 3D-моделей во вложениях (этап 15б): STL, OBJ, GLB.

Языковая модель не «видит» сетку из треугольников, поэтому мы сами считаем то, о чём
обычно спрашивают: размеры (габариты) в миллиметрах, число треугольников, объём и
примерный расход пластика для 3D-печати. Это текстовое описание уходит в контекст —
и Джарвис может ответить «влезет ли на стол принтера 220×220» или «сколько уйдёт PLA».
Саму модель пользователь крутит в просмотрщике (frontend, Three.js).

Объём считаем суммой «знаковых» тетраэдров от начала координат до каждого треугольника —
это точно для замкнутой (водонепроницаемой) сетки; для дырявой — оценка.
"""

import json
import re
import struct

import numpy as np

MAX_TRIANGLES = 5_000_000
PLA_DENSITY = 1.24  # г/см³


class ModelError(ValueError):
    pass


# ---------- чтение форматов: всё сводим к массиву треугольников (N, 3, 3) ----------


def _stl(data: bytes) -> np.ndarray:
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if 84 + count * 50 == len(data):  # двоичный STL: заголовок 80 байт, число, по 50 байт на треугольник
            if count > MAX_TRIANGLES:
                raise ModelError("Слишком много треугольников")
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]),
                                count=count, offset=84)
            return rec["v"].astype(np.float64)
    text = data.decode("utf-8", errors="ignore")
    nums = re.findall(r"vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)", text)
    if not nums or len(nums) % 3:
        raise ModelError("Не похоже на STL: нет треугольников")
    return np.array(nums, dtype=np.float64).reshape(-1, 3, 3)


def _obj(data: bytes) -> np.ndarray:
    vertices, faces = [], []
    for line in data.decode("utf-8", errors="ignore").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v" and len(parts) >= 4:
            vertices.append([float(x) for x in parts[1:4]])
        elif parts[0] == "f" and len(parts) >= 4:
            idx = []
            for p in parts[1:]:
                i = int(p.split("/")[0])
                idx.append(i - 1 if i > 0 else len(vertices) + i)  # отрицательные индексы — от конца
            for k in range(1, len(idx) - 1):  # многоугольник → веер треугольников
                faces.append((idx[0], idx[k], idx[k + 1]))
    if not vertices or not faces:
        raise ModelError("Не похоже на OBJ: нет вершин или граней")
    v = np.array(vertices, dtype=np.float64)
    f = np.array(faces, dtype=np.int64)
    if f.max() >= len(v) or f.min() < 0:
        raise ModelError("В OBJ грани ссылаются на несуществующие вершины")
    return v[f]


COMPONENT = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
SIZE = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _glb(data: bytes) -> np.ndarray:
    """GLB = заголовок + JSON-описание + двоичный буфер. Берём POSITION и индексы всех сеток.
    (Повороты/масштабы узлов сцены не применяем — для габаритов обычно не нужны.)"""
    if data[:4] != b"glTF":
        raise ModelError("Не похоже на GLB")
    offset, doc, binary = 12, None, b""
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<I4s", data, offset)
        chunk = data[offset + 8: offset + 8 + length]
        if kind == b"JSON":
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == b"BIN\x00":
            binary = chunk
        offset += 8 + length
    if not doc:
        raise ModelError("В GLB нет описания сцены")

    def accessor(i: int) -> np.ndarray:
        acc = doc["accessors"][i]
        view = doc["bufferViews"][acc["bufferView"]]
        dtype = np.dtype(COMPONENT[acc["componentType"]])
        n = SIZE[acc["type"]]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = view.get("byteStride") or dtype.itemsize * n
        count = acc["count"]
        raw = np.frombuffer(binary, dtype=np.uint8, count=stride * (count - 1) + dtype.itemsize * n, offset=start)
        rows = np.lib.stride_tricks.as_strided(raw, shape=(count, dtype.itemsize * n), strides=(stride, 1))
        return np.ascontiguousarray(rows).view(dtype).reshape(count, n).astype(np.float64 if dtype.kind == "f" else np.int64)

    tris = []
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4 or "POSITION" not in prim["attributes"]:
                continue
            pos = accessor(prim["attributes"]["POSITION"])
            idx = accessor(prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(pos))
            tris.append(pos[idx[: len(idx) // 3 * 3].reshape(-1, 3)])
    if not tris:
        raise ModelError("В GLB нет сеток из треугольников")
    # glTF хранит размеры в метрах — переводим в миллиметры
    return np.concatenate(tris) * 1000.0


READERS = {"stl": _stl, "obj": _obj, "glb": _glb}


def analyze(data: bytes, name: str) -> tuple[str, dict]:
    """Байты файла → (текст для модели, meta для интерфейса)."""
    fmt = name.rsplit(".", 1)[-1].lower()
    if fmt not in READERS:
        raise ModelError("Поддерживаются STL, OBJ и GLB")
    try:
        tris = READERS[fmt](data)
    except ModelError:
        raise
    except Exception as e:  # noqa: BLE001 — повреждённый файл
        raise ModelError(f"Не удалось прочитать {fmt.upper()}: {e}") from e
    if len(tris) > MAX_TRIANGLES:
        raise ModelError("Слишком много треугольников (больше 5 млн)")
    points = tris.reshape(-1, 3)
    if not np.isfinite(points).all():
        raise ModelError("В модели есть некорректные координаты")
    size = points.max(axis=0) - points.min(axis=0)
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    volume_mm3 = abs(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0
    volume_cm3 = volume_mm3 / 1000.0
    up = "Z" if fmt == "stl" else "Y"  # в STL обычно «вверх» — Z, в OBJ/GLB — Y
    meta = {"type": "model3d", "format": fmt, "triangles": int(len(tris)),
            "size_mm": [round(float(x), 2) for x in size], "volume_cm3": round(volume_cm3, 2), "up": up}
    f = lambda x: f"{x:.1f}".replace(".", ",")  # noqa: E731
    text = (f"3D-модель «{name}» (формат {fmt.upper()}): треугольников {len(tris):,}".replace(",", " ")
            + f"; габариты по осям X × Y × Z = {f(size[0])} × {f(size[1])} × {f(size[2])} мм (вверх — ось {up})"
            + f"; объём ≈ {f(volume_cm3)} см³ (точно, если сетка замкнутая)"
            + f"; пластик PLA ≈ {f(volume_cm3 * PLA_DENSITY)} г при 100% заполнении, ≈ "
            + f"{f(volume_cm3 * PLA_DENSITY * 0.35)} г при обычных 15–20% заполнения со стенками.")
    return text, meta
