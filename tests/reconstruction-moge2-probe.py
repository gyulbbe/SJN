"""Opt-in, local-only MoGe-2 geometry probe; no application imports or dependencies.

Run `download` explicitly before `run`. The run phase uses a pinned local checkpoint,
blocks Python socket/urllib network operations before importing the model, and never
uses room dimensions/fixture annotations as input. See docs/reconstruction-moge2-probe.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gc
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import sys
import threading
import time
import traceback
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from reconstruction_geometry.model import MODEL_REPO, MODEL_REVISION, PINNED_FILES, RssSampler, SOURCE_REVISION, UTILS_REVISION, configure_local_cache, forbid_network, import_existing_cv2, sha256, verify_local_files




def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)






def download(work):
    """Only approved public source/model downloads. No input manifest or photo access."""
    work.mkdir(parents=True, exist_ok=True)
    items = [(f"https://huggingface.co/api/models/{MODEL_REPO}/revision/{MODEL_REVISION}", "hf-metadata.json", None), *PINNED_FILES]
    files = []
    for url, name, expected in items:
        path = work / name
        cached = path.exists()
        start = time.perf_counter()
        if not cached:
            temporary = path.with_suffix(path.suffix + ".part")
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as stream:
                while chunk := response.read(1024 * 1024):
                    stream.write(chunk)
            temporary.replace(path)
        actual = sha256(path)
        if expected and actual != expected:
            raise ValueError(f"Downloaded checksum mismatch: {name}")
        if name == "hf-metadata.json":
            metadata = json.loads(path.read_text(encoding="utf-8"))
            if metadata["sha"] != MODEL_REVISION or metadata["cardData"]["license"] != "mit":
                raise ValueError("Unexpected official model revision or license")
        if name.endswith(".zip"):
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    if not (work / entry.filename).resolve().is_relative_to(work):
                        raise ValueError("Unsafe archive path")
                archive.extractall(work)
        record = {"url": url, "path": str(path.relative_to(ROOT)), "bytes": path.stat().st_size,
                  "sha256": actual, "cached": cached, "elapsedSeconds": time.perf_counter() - start}
        files.append(record)
        print(json.dumps(record), flush=True)
    write_json(work / "download-manifest.json", {"phase": "download-only-no-user-images-read", "files": files})








def describe_arrays(arrays):
    import numpy as np
    p, d, n, m, k = (arrays[key] for key in ("points", "depth", "normal", "mask", "intrinsics"))
    h, w = d.shape
    shape_ok = p.shape == (h, w, 3) and n.shape == (h, w, 3) and m.shape == (h, w) and k.shape == (3, 3)
    if not shape_ok or m.dtype != np.bool_ or not m.any():
        raise ValueError("Invalid output shapes or empty/nonboolean model mask")
    finite = np.isfinite(p[m]).all() and np.isfinite(d[m]).all() and np.isfinite(n[m]).all() and np.isfinite(k).all()
    if not finite or not (d[m] > 0).all() or k[0, 0] <= 0 or k[1, 1] <= 0:
        raise ValueError("Invalid finite/depth/intrinsic values on valid mask")
    norm = np.linalg.norm(n[m], axis=-1)
    z_error = np.abs(p[..., 2][m] - d[m])
    yy, xx = np.mgrid[:h, :w]
    u = p[..., 0][m] / p[..., 2][m] * k[0, 0] + k[0, 2]
    v = p[..., 1][m] / p[..., 2][m] * k[1, 1] + k[1, 2]
    pixel_error = np.hypot(u * w - (xx[m] + 0.5), v * h - (yy[m] + 0.5))
    return {"outputShapes": {key: list(value.shape) for key, value in arrays.items()},
            "outputDtypes": {key: str(value.dtype) for key, value in arrays.items()},
            "finiteOnValidMask": bool(finite), "validPixels": int(m.sum()), "maskCoverage": float(m.mean()),
            "depthEstimateQuantiles": {str(q): float(np.percentile(d[m], q)) for q in (0, 2, 50, 98, 100)},
            "depthPointZMaxError": float(z_error.max()),
            "normalLengthQuantiles": {str(q): float(np.percentile(norm, q)) for q in (0, 50, 100)},
            "intrinsicsNormalized": k.tolist(),
            "estimatedFovDegrees": {"horizontal": math.degrees(2 * math.atan(0.5 / float(k[0, 0]))),
                                    "vertical": math.degrees(2 * math.atan(0.5 / float(k[1, 1])))},
            "forcedProjectionPixelError": {"median": float(np.median(pixel_error)), "max": float(pixel_error.max()),
                 "meaning": "Internal consistency only: force_projection=True constructs points from depth and estimated intrinsics. Not geometry accuracy."}}


def diagnostic_images(rgb, arrays, target, case_id):
    import numpy as np
    from PIL import Image, ImageDraw, ImageOps
    from matplotlib import colormaps
    d, n, m = (arrays[key] for key in ("depth", "normal", "mask"))
    low, high = np.percentile(d[m], [2, 98])
    normalized = np.zeros_like(d)
    normalized[m] = np.clip((np.log(d[m]) - np.log(low)) / max(float(np.log(high / low)), 1e-8), 0, 1)
    depth_rgb = (colormaps["viridis"](normalized)[..., :3] * 255).astype(np.uint8)
    depth_rgb[~m] = 0
    normal_rgb = (np.clip(n * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    normal_rgb[~m] = 0
    images = [(rgb, "Input: frozen evaluation photo"),
              (Image.fromarray(depth_rgb), f"Model depth estimate: log p2-p98 {low:.2f}-{high:.2f}"),
              (Image.fromarray(normal_rgb), "Normal RGB: OpenCV xyz [-1,1] -> [0,255]"),
              (Image.fromarray(m.astype(np.uint8) * 255).convert("RGB"), "Predicted valid mask; not floor segmentation")]
    images[1][0].save(target / "depth.png")
    images[2][0].save(target / "normal.png")
    images[3][0].save(target / "valid-mask.png")
    cell_w, cell_h, label_h = 440, 400, 42
    board = Image.new("RGB", (cell_w * 2, (cell_h + label_h) * 2 + 48), (20, 22, 27))
    draw = ImageDraw.Draw(board)
    draw.text((12, 12), f"{case_id} | MoGe-2 vits-normal | MODEL ESTIMATE, NOT A MEASUREMENT", fill="white")
    for i, (im, title) in enumerate(images):
        x, y = (i % 2) * cell_w, (i // 2) * (cell_h + label_h) + 48
        thumbnail = ImageOps.contain(im, (cell_w, cell_h), Image.Resampling.LANCZOS)
        board.paste(thumbnail, (x + (cell_w - thumbnail.width) // 2, y))
        draw.text((x + 8, y + cell_h + 8), title, fill="white")
    board.save(target / "diagnostic.png")
    return {"depthVisualization": "Log model-depth p2-p98 scaled separately per image; black invalid; Viridis near purple/far yellow.",
            "normalVisualization": "RGB=(OpenCV camera-space normal xyz+1)*127.5; black invalid.",
            "depthDisplayRangeEstimate": [float(low), float(high)]}


def run(args, work, output):
    files = verify_local_files(work)
    attempts = []
    forbid_network(attempts)
    import psutil
    process = psutil.Process()
    output.mkdir(parents=True, exist_ok=True)
    with RssSampler(process) as total_rss:
        runtime_start = time.perf_counter()
        import numpy as np
        import torch
        from PIL import Image, ImageOps
        cv2 = import_existing_cv2(args.extra_cv2_site)
        sys.path[:0] = [str(work / f"MoGe-{SOURCE_REVISION}"), str(work / f"utils3d-{UTILS_REVISION}")]
        from moge.model.v2 import MoGeModel
        if not torch.cuda.is_available():
            raise RuntimeError("This measured probe requires CUDA; no silent CPU fallback")
        torch.manual_seed(0)
        np.random.seed(0)
        torch.cuda.init()
        free_before, total_gpu = torch.cuda.mem_get_info()
        manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
        cases = [case for case in manifest["cases"] if not args.case or case["id"] in args.case]
        if not cases or len({case["id"] for case in cases}) != len(cases):
            raise ValueError("Missing or duplicate cases")
        for case in cases:
            case_path = ROOT / case["input"]["path"]
            if sha256(case_path) != case["input"]["sha256"]:
                raise ValueError(f"Frozen input hash mismatch: {case['id']}")
            if (output / case["id"] / "report.json").exists() and not args.overwrite:
                raise ValueError(f"Output already exists for {case['id']}; choose a new --output or explicit --overwrite")
        device = torch.device("cuda:0")
        torch.cuda.reset_peak_memory_stats(device)
        load_start = time.perf_counter()
        with RssSampler(process) as load_rss:
            model = MoGeModel.from_pretrained(str(work / "model.pt")).to(device).eval()
            torch.cuda.synchronize()
        model_load = {"elapsedSeconds": time.perf_counter() - load_start,
                      "cudaPeakAllocatedBytes": torch.cuda.max_memory_allocated(device),
                      "cudaPeakReservedBytes": torch.cuda.max_memory_reserved(device), "rss": load_rss.report()}
        summary = {"schemaVersion": 1, "status": "running", "startedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
                   "scope": manifest["scope"], "scriptSha256": sha256(__file__),
                   "manifestSha256": sha256(args.manifest), "sourceRevision": SOURCE_REVISION,
                   "utils3dRevision": UTILS_REVISION, "modelRepo": MODEL_REPO, "modelRevision": MODEL_REVISION,
                   "downloadedFiles": files, "modelParameterCount": sum(p.numel() for p in model.parameters()),
                   "provenance": {"geometry": "MoGe-2 local neural model estimate", "metricScale": "Model-predicted metric scale, NOT measured physical units",
                                  "camera": "Estimated intrinsics; source photo OpenCV x-right y-down z-forward. No shared-room extrinsics inferred.",
                                  "mask": "Model validity only; no semantic floor labels or complete room boundary claim",
                                  "fixturePlacement": "Not attempted; no model outputs promoted to product coordinates"},
                   "inferenceConfig": {"resolutionLevel": args.resolution_level, "numTokensRange": model.num_tokens_range,
                       "effectiveNumTokens": int(model.num_tokens_range[0] + args.resolution_level / 9 * (model.num_tokens_range[1] - model.num_tokens_range[0])),
                       "useFp16": True, "forceProjection": True, "applyMask": True, "fovX": None,
                       "inputResize": "None; EXIF transpose followed by original frozen image resolution", "seed": 0},
                   "environment": {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
                       "torch": torch.__version__, "cudaRuntime": torch.version.cuda, "opencv": cv2.__version__, "opencvPath": cv2.__file__,
                       "numpy": np.__version__, "gpu": torch.cuda.get_device_name(device), "gpuTotalBytes": total_gpu,
                       "gpuFreeBytesBeforeModelLoad": free_before,
                       "concurrentWork": "Browser Chrome WASM DeepLab evaluation and other development work may overlap; measured run is not an isolated hardware benchmark.",
                       "packagesInstalled": False, "cacheEnvironment": {key: os.environ[key] for key in ("HF_HOME", "HF_HUB_CACHE", "TORCH_HOME", "XDG_CACHE_HOME", "MPLCONFIGDIR")}},
                   "network": {"mode": "Offline env + fail-closed Python audit hook for socket DNS/connect/sendto and urllib requests; not OS firewall", "guardSelfTestPassed": True, "unexpectedAttempts": attempts},
                   "modelLoad": model_load, "cases": [], "errors": []}
        write_json(output / "summary.json", summary)
        for case in cases:
            target = output / case["id"]
            target.mkdir(parents=True, exist_ok=True)
            case_start = time.perf_counter()
            result = {"id": case["id"], "split": case["split"], "input": case["input"], "status": "running"}
            try:
                with RssSampler(process) as case_rss:
                    with Image.open(ROOT / case["input"]["path"]) as image_file:
                        rgb = ImageOps.exif_transpose(image_file).convert("RGB")
                    if rgb.size != (case["input"]["width"], case["input"]["height"]):
                        raise ValueError("Unexpected decoded dimensions")
                    tensor = torch.from_numpy(np.array(rgb, dtype=np.float32) / 255).permute(2, 0, 1).to(device)
                    torch.cuda.synchronize()
                    torch.cuda.reset_peak_memory_stats(device)
                    baseline_gpu = torch.cuda.memory_allocated(device)
                    inference_start = time.perf_counter()
                    prediction = model.infer(tensor, resolution_level=args.resolution_level, force_projection=True,
                                             apply_mask=True, fov_x=None, use_fp16=True)
                    torch.cuda.synchronize()
                    inference_seconds = time.perf_counter() - inference_start
                    peak_allocated = torch.cuda.max_memory_allocated(device)
                    peak_reserved = torch.cuda.max_memory_reserved(device)
                    arrays = {key: value.detach().cpu().numpy() for key, value in prediction.items()}
                    validation = describe_arrays(arrays)
                    save_start = time.perf_counter()
                    temporary = target / "geometry.npz.tmp"
                    with temporary.open("wb") as stream:
                        np.savez_compressed(stream, **arrays)
                    temporary.replace(target / "geometry.npz")
                    plots = diagnostic_images(rgb, arrays, target, case["id"])
                    result.update({"status": "complete", "validation": validation, "diagnostics": plots,
                                   "timing": {"inferenceSeconds": inference_seconds, "arrayValidationAndCopyIncludedInInference": False,
                                              "archiveAndPngSeconds": time.perf_counter() - save_start,
                                              "caseTotalSeconds": time.perf_counter() - case_start},
                                   "memory": {"cudaBaselineAllocatedBytes": baseline_gpu, "cudaPeakAllocatedBytes": peak_allocated,
                                              "cudaPeakReservedBytes": peak_reserved,
                                              "cudaPeakIncrementAllocatedBytes": peak_allocated - baseline_gpu},
                                   "artifacts": {"geometry": str((target / "geometry.npz").relative_to(ROOT)),
                                                 "geometrySha256": sha256(target / "geometry.npz"),
                                                 "diagnostic": str((target / "diagnostic.png").relative_to(ROOT))}})
                    del arrays, prediction, tensor
                    gc.collect()
                result["memory"]["rss"] = case_rss.report()
            except Exception as error:
                result.update({"status": "failed", "error": str(error), "traceback": traceback.format_exc(),
                               "elapsedSeconds": time.perf_counter() - case_start})
                summary["errors"].append({"id": case["id"], "error": str(error)})
            write_json(target / "report.json", result)
            summary["cases"].append(result)
            write_json(output / "summary.json", summary)
            print(json.dumps({"id": case["id"], "status": result["status"], "timing": result.get("timing"), "memory": result.get("memory"), "error": result.get("error")}), flush=True)
        summary["status"] = "complete" if not summary["errors"] and not attempts else "failed"
        summary["runtimeSecondsAfterOfflineGuard"] = time.perf_counter() - runtime_start
        summary["gpuFreeBytesAtEnd"] = torch.cuda.mem_get_info()[0]
        del model
        gc.collect()
        torch.cuda.empty_cache()
    summary["runtimeRss"] = total_rss.report()
    summary["endedAtUtc"] = dt.datetime.now(dt.timezone.utc).isoformat()
    write_json(output / "summary.json", summary)
    print(json.dumps({"status": summary["status"], "cases": len(summary["cases"]), "errors": summary["errors"],
                      "networkAttempts": attempts, "runtimeRss": summary["runtimeRss"]}), flush=True)
    return 0 if summary["status"] == "complete" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["download", "run"])
    parser.add_argument("--work", type=Path, default=ROOT / "tmp/moge2")
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/reconstruction-moge2-20260913")
    parser.add_argument("--manifest", type=Path, default=ROOT / "test-results/reconstruction-moge2-20260913/manifest.json")
    parser.add_argument("--extra-cv2-site", type=Path, default=None)
    parser.add_argument("--resolution-level", type=int, choices=range(10), default=9)
    parser.add_argument("--case", action="append")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    work, output = args.work.resolve(), args.output.resolve()
    if not work.is_relative_to(ROOT / "tmp") or not output.is_relative_to(ROOT / "test-results"):
        parser.error("Probe downloads must stay inside tmp and private results inside test-results")
    args.manifest = args.manifest.resolve()
    configure_local_cache(work)
    if args.phase == "download":
        download(work)
        return 0
    try:
        return run(args, work, output)
    except Exception as error:
        write_json(output / "startup-failure.json", {"error": str(error), "traceback": traceback.format_exc(), "phase": "offline-run"})
        raise


if __name__ == "__main__":
    raise SystemExit(main())