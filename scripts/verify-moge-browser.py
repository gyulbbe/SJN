"""Verify the pinned browser ONNX and compare captured browser tensors to official FP32.

No package installs or implicit model downloads. Requires the existing geometry Python
environment, tmp/moge2 source/weights, tmp/moge2-onnx/model.onnx, and browser capture.
Usage: <existing-python> scripts/verify-moge-browser.py --capture test-results/.../moge-runtime
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SHA256 = "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0"
REVISION = "e50ffda41565591092adea54c6ac83d6212e1e23"
SOURCE = "925b8ed835a7a9cdb7578ba15c658a0afc969030"
UTILS = "3fab839f0be9931dac7c8488eb0e1600c236e183"


def fields(data):
    """Read protobuf wire records without requiring/installing the onnx package."""
    pos = 0
    def varint():
        nonlocal pos
        result, shift = 0, 0
        while True:
            byte = data[pos]
            pos += 1
            result |= (byte & 127) << shift
            if byte < 128:
                return result
            shift += 7
            if shift > 70:
                raise ValueError("Invalid protobuf")
    while pos < len(data):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value = varint()
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            value = data[pos:pos + size]
            pos += size
        elif wire == 2:
            size = varint()
            value = data[pos:pos + size]
            pos += size
        else:
            raise ValueError(f"Unsupported protobuf wire: {wire}")
        yield number, wire, value


def graph_info(path):
    content = path.read_bytes()
    if len(content) != 140852051 or hashlib.sha256(content).hexdigest() != SHA256:
        raise ValueError("Pinned ONNX integrity mismatch")
    nodes, opsets, initializers = [], [], []
    for number, _, value in fields(memoryview(content)):
        if number == 8:
            opsets.append({str(n): bytes(v).decode() if isinstance(v, memoryview) else v for n, _, v in fields(value)})
        elif number == 7:
            for kind, _, record in fields(value):
                if kind == 1:
                    node = {"input": [], "output": []}
                    for n, _, v in fields(record):
                        if n in (1, 2): node["input" if n == 1 else "output"].append(bytes(v).decode())
                        if n in (3, 4): node["name" if n == 3 else "op"] = bytes(v).decode()
                    nodes.append(node)
                elif kind == 5:
                    for n, _, v in fields(record):
                        if n == 8: initializers.append(bytes(v).decode())
    return {"sha256": SHA256, "revision": REVISION, "bytes": len(content), "opsets": opsets,
            "operators": dict(Counter(n["op"] for n in nodes)), "nodeCount": len(nodes),
            "inputNormalizationBuffers": [n for n in initializers if "image_mean" in n or "image_std" in n],
            "outputNodes": [n for n in nodes if any(v in ("points", "normal", "mask", "scale") for v in n["output"])]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--model", type=Path, default=ROOT / "tmp/moge2-onnx/model.onnx")
    parser.add_argument("--work", type=Path, default=ROOT / "tmp/moge2")
    parser.add_argument("--extra-cv2-site", type=Path, default=Path.home() / "AppData/Local/Programs/Python/Python310/Lib/site-packages")
    args = parser.parse_args()
    args.capture.mkdir(parents=True, exist_ok=True)
    report = {"graph": graph_info(args.model), "reference": "official pinned MoGe FP32, same captured browser RGB01 NCHW"}
    from reconstruction_geometry.model import configure_local_cache, verify_local_files, import_existing_cv2, forbid_network
    configure_local_cache(args.work)
    report["pinnedSourceAndWeights"] = verify_local_files(args.work)
    import_existing_cv2(args.extra_cv2_site)
    sys.path[:0] = [str(args.work / f"MoGe-{SOURCE}"), str(args.work / f"utils3d-{UTILS}")]
    import numpy as np
    import torch
    import onnxruntime as ort
    from moge.model.v2 import MoGeModel
    from moge.utils.geometry_torch import recover_focal_shift
    import utils3d
    network_attempts = []
    forbid_network(network_attempts)
    torch.set_num_threads(4)
    metadata = json.loads((args.capture / "input.json").read_text())
    width, height, num_tokens = metadata["width"], metadata["height"], metadata["numTokens"]
    image = np.fromfile(args.capture / "input.bin", dtype=np.float32).reshape(1, 3, height, width)
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(args.model), session_options, providers=["CPUExecutionProvider"])
    report["onnxRuntimePythonVersion"] = ort.__version__
    report["inputs"] = [{"name": x.name, "shape": x.shape, "type": x.type} for x in session.get_inputs()]
    started = time.perf_counter()
    raw_onnx = dict(zip([x.name for x in session.get_outputs()], session.run(None, {"image": image, "num_tokens": np.array(num_tokens, dtype=np.int64)})))
    report["pythonOnnxSeconds"] = time.perf_counter() - started
    del session
    model = MoGeModel.from_pretrained(args.work / "model.pt").eval()
    model.onnx_compatible_mode = True
    started = time.perf_counter()
    with torch.inference_mode():
        raw_torch = model(torch.from_numpy(image), torch.tensor(num_tokens))
    report["torchFp32Seconds"] = time.perf_counter() - started
    def difference(a, b):
        a, b = np.asarray(a), np.asarray(b)
        finite = np.isfinite(a) & np.isfinite(b)
        delta = np.abs(a[finite].astype(np.float64) - b[finite].astype(np.float64))
        return {"shape": list(a.shape), "finiteAgreement": bool(np.array_equal(np.isfinite(a), np.isfinite(b))),
                "meanAbsolute": float(np.mean(delta)), "p99Absolute": float(np.quantile(delta, .99)), "maxAbsolute": float(np.max(delta))}
    report["torchOnnxRawParity"] = {}
    for name, array in raw_onnx.items():
        reference = raw_torch["metric_scale" if name == "scale" else name].numpy()
        report["torchOnnxRawParity"][name] = difference(array, reference)
        array.tofile(args.capture / f"python-raw-{name}.bin")
    # Official infer() postprocessing applied to the SAME ONNX arrays isolates browser solver parity.
    tensors = {name: torch.from_numpy(value.copy()) for name, value in raw_onnx.items()}
    points, normal, mask = tensors["points"], tensors["normal"], tensors["mask"] > .5
    focal, shift = recover_focal_shift(points, mask)
    aspect = width / height
    fx = focal / 2 * (1 + aspect ** 2) ** .5 / aspect
    fy = focal / 2 * (1 + aspect ** 2) ** .5
    intrinsics = utils3d.pt.intrinsics_from_focal_center(fx, fy, torch.tensor(.5), torch.tensor(.5))
    points[..., 2] += shift[..., None, None]
    mask &= points[..., 2] > 0
    depth = points[..., 2].clone()
    points = utils3d.pt.depth_map_to_point_map(depth, intrinsics=intrinsics)
    points *= tensors["scale"][:, None, None, None]
    depth *= tensors["scale"][:, None, None]
    points = torch.where(mask[..., None], points, torch.inf)
    depth = torch.where(mask, depth, torch.inf)
    normal = torch.where(mask[..., None], normal, torch.zeros_like(normal))
    dense = {"points": points.numpy(), "depth": depth.numpy(), "normal": normal.numpy(), "mask": mask.numpy().astype(np.uint8)}
    report["officialPostprocess"] = {"focal": float(focal), "shift": float(shift), "intrinsics": intrinsics.numpy().tolist(), "metricScale": float(raw_onnx["scale"][0]), "validPixels": int(mask.sum())}
    for name, array in dense.items(): array.tofile(args.capture / f"python-dense-{name}.bin")
    report["browserParity"] = {}
    for mode in ("webgpu", "wasm", "auto"):
        if not (args.capture / f"{mode}-result.json").is_file(): continue
        result = json.loads((args.capture / f"{mode}-result.json").read_text())
        compare = {"raw": {}, "dense": {}, "intrinsics": result["intrinsics"], "diagnostics": result["diagnostics"]}
        for name in ("points", "normal", "mask"):
            array = np.fromfile(args.capture / f"{mode}-raw-{name}.bin", np.float32).reshape(raw_onnx[name].shape)
            compare["raw"][name] = difference(array, raw_onnx[name])
        for name, reference in dense.items():
            array = np.fromfile(args.capture / f"{mode}-dense-{name}.bin", np.uint8 if name == "mask" else np.float32).reshape(reference.shape)
            compare["dense"][name] = difference(array, reference)
        report["browserParity"][mode] = compare
    report["networkAttempts"] = network_attempts
    (args.capture / "python-reference.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
