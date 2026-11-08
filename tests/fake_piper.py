"""
Голос-пустышка для Piper — чтобы проверять озвучку без скачивания настоящего голоса.

Настоящие голоса лежат на HuggingFace, а из облачного контейнера разработки он недоступен.
Поэтому собираем крошечную ONNX-модель с тем же интерфейсом, что у голосов Piper
(входы input / input_lengths / scales → выход audio). Звучит она как гудок, но весь путь —
наш код → piper → фонемизатор espeak-ng → onnxruntime → WAV — проверяется по-настоящему.

Нужен пакет onnx (requirements-dev.txt).
"""

import json
from pathlib import Path

SAMPLES_PER_ID = 256  # сколько отсчётов звука на один id фонемы


def make_voice(folder: Path, name: str = "ru_RU-ruslan-medium") -> Path:
    import onnx
    from onnx import TensorProto, helper
    from piper.phoneme_ids import DEFAULT_PHONEME_ID_MAP

    folder.mkdir(parents=True, exist_ok=True)
    model_path = folder / f"{name}.onnx"

    nodes = [
        helper.make_node("Cast", ["input"], ["ids_f"], to=TensorProto.FLOAT),            # [1, N]
        helper.make_node("Unsqueeze", ["ids_f", "axis2"], ["ids_3d"]),                    # [1, N, 1]
        helper.make_node("Tile", ["ids_3d", "repeats"], ["tiled"]),                       # [1, N, 256]
        helper.make_node("Reshape", ["tiled", "shape"], ["flat"]),                        # [1, 1, N*256]
        helper.make_node("Mul", ["flat", "freq"], ["phase"]),
        helper.make_node("Sin", ["phase"], ["wave"]),
        helper.make_node("Mul", ["wave", "volume"], ["output"]),
    ]
    inits = [
        helper.make_tensor("axis2", TensorProto.INT64, [1], [2]),
        helper.make_tensor("repeats", TensorProto.INT64, [3], [1, 1, SAMPLES_PER_ID]),
        helper.make_tensor("shape", TensorProto.INT64, [3], [1, 1, -1]),
        helper.make_tensor("freq", TensorProto.FLOAT, [], [0.05]),
        helper.make_tensor("volume", TensorProto.FLOAT, [], [0.3]),
    ]
    graph = helper.make_graph(
        nodes, "fake_piper", [
            helper.make_tensor_value_info("input", TensorProto.INT64, [1, None]),
            helper.make_tensor_value_info("input_lengths", TensorProto.INT64, [1]),
            helper.make_tensor_value_info("scales", TensorProto.FLOAT, [3]),
        ],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 1, None])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8  # совместимо с onnxruntime из колёс piper-tts
    onnx.save(model, model_path)

    config = {
        "audio": {"sample_rate": 22050, "quality": "medium"},
        "espeak": {"voice": "ru"},
        "inference": {"noise_scale": 0.667, "length_scale": 1, "noise_w": 0.8},
        "phoneme_type": "espeak",
        "phoneme_id_map": DEFAULT_PHONEME_ID_MAP,
        "num_symbols": 256,
        "num_speakers": 1,
        "language": {"code": "ru_RU"},
        "dataset": name,
    }
    Path(f"{model_path}.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return model_path
