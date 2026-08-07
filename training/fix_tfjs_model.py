"""
Patches a TFJS layers-model.json exported from a Keras 3 model: Keras 3
renamed InputLayer's `batch_shape` config key to `batch_input_shape` (the
name tensorflowjs's browser-side loader still expects), so a model exported
via the standard converter fails to load in the browser with
"An InputLayer should be passed either a `batchInputShape` or an
`inputShape`." Run this after every tensorflowjs conversion.

Usage: .venv/Scripts/python.exe fix_tfjs_model.py <path-to-model.json>
"""

import json
import sys


def fix(path: str) -> int:
    with open(path) as f:
        data = json.load(f)
    layers = data["modelTopology"]["model_config"]["config"]["layers"]
    fixed = 0
    for layer in layers:
        if layer["class_name"] == "InputLayer":
            cfg = layer["config"]
            if "batch_shape" in cfg and "batch_input_shape" not in cfg:
                cfg["batch_input_shape"] = cfg.pop("batch_shape")
                fixed += 1
    with open(path, "w") as f:
        json.dump(data, f)
    return fixed


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: fix_tfjs_model.py <path-to-model.json>")
        sys.exit(1)
    n = fix(sys.argv[1])
    print(f"Patched {n} InputLayer(s) in {sys.argv[1]}")
