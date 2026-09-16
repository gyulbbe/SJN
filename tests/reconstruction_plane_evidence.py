"""Offline evidence filters and conservative patch consensus; no model calls."""
from __future__ import annotations
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from reconstruction_geometry.consensus import joint_patch_fit
import hashlib
import json
import math
import numpy as np
from scipy import ndimage


def inventory_exclusions(report, fingerprint, image, grid, margin=2):
    """Only raw inventory-confirmed optical/door regions can remove plane support.

    This is an exclusion hypothesis, never proof of a physical wall or opening extent.
    It reads the preserved model response, not corrected candidates or free-text guesses.
    """
    if report.get("inputFingerprint") != fingerprint:
        raise ValueError("Inventory input fingerprint differs from pointmap input")
    if (report.get("input", {}).get("width"), report.get("input", {}).get("height")) != tuple(image):
        raise ValueError("Inventory input dimensions differ from pointmap input")
    model = report.get("pipeline", {}).get("model", {})
    if model.get("outputContract") != "fixture-inventory-v2" or not model.get("modelId") or not model.get("modelRevision"):
        raise ValueError("A versioned preserved inventory model response is required")
    completion = model.get("completion", {})
    if not completion.get("done") or completion.get("doneReason") != "stop":
        raise ValueError("Incomplete inventory response cannot exclude plane support")
    raw = model.get("rawText", "")
    items = json.loads(raw).get("items")
    candidates = report.get("pipeline", {}).get("automaticUnderstanding", {}).get("candidates")
    if not isinstance(items, list) or not isinstance(candidates, list) or len(items) != len(candidates):
        raise ValueError("Raw inventory and preserved automatic candidate counts differ")
    width, height = grid
    excluded = np.zeros((height, width), dtype=bool)
    records, skipped = [], []
    for item, candidate in zip(items, candidates):
        identifier = candidate.get("id")
        bounds = candidate.get("bounds", {})
        values = [bounds.get(k) for k in ("left", "top", "right", "bottom")]
        raw_bounds = item.get("bbox_2d")
        expected_view = {"direct": "physical", "mirror_image": "reflected", "uncertain": "unknown"}.get(item.get("view"))
        valid = (all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values)
                 and 0 <= values[0] < values[2] <= 1 and 0 <= values[1] < values[3] <= 1
                 and isinstance(raw_bounds, list) and len(raw_bounds) == 4
                 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in raw_bounds))
        if not valid or any(abs(a - b / 1000) > 1e-9 for a, b in zip(values, raw_bounds or [])):
            raise ValueError(f"Raw/automatic inventory bounds mismatch: {identifier}")
        if item.get("kind") != candidate.get("kind") or expected_view != candidate.get("reflection"):
            raise ValueError(f"Raw/automatic inventory identity mismatch: {identifier}")
        kind, reflection = candidate.get("kind"), candidate.get("reflection")
        if candidate.get("validation", {}).get("issues") or not any(str(e).strip() for e in candidate.get("evidence", [])):
            skipped.append({"id": identifier, "reason": "invalid-or-unobserved-inventory"})
            continue
        category = ("reflected-image" if reflection == "reflected" else
                    "optical-surface" if reflection == "physical" and kind in {"glassPartition", "mirror", "mirrorCabinet"} else
                    "opening-or-leaf" if reflection == "physical" and kind in {"window", "door"} else None)
        if category is None:
            skipped.append({"id": identifier, "kind": kind, "reason": "no-optical-opening-or-reflection-evidence"})
            continue
        left, top = max(0, math.floor(values[0] * width) - margin), max(0, math.floor(values[1] * height) - margin)
        right, bottom = min(width, math.ceil(values[2] * width) + margin), min(height, math.ceil(values[3] * height) + margin)
        excluded[top:bottom, left:right] = True
        records.append({"id": identifier, "kind": kind, "bounds": bounds.copy(), "source": "qwen-raw-inventory",
                        "category": category, "reflection": reflection, "evidence": list(candidate["evidence"]),
                        "exclusion": f"observed-region-plus-{margin}-grid-pixels",
                        "limitation": "May also remove true wall/floor visible through or around this region; not an instance mask or physical opening boundary."})
    return excluded, records, {"runId": report.get("runId"), "modelId": model["modelId"],
                              "modelRevision": model["modelRevision"], "promptRevision": model.get("promptRevision"),
                              "rawTextSha256": hashlib.sha256(raw.encode()).hexdigest(), "skipped": skipped}


