"""Offline pointmap + semantic-mask plane evidence; no room-corner or metric truth claims."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import traceback

# Bound CPU threads before NumPy import; no model imports, downloads, or environment installation.
for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ[key] = "1"
sys.dont_write_bytecode = True
import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull
from PIL import Image, ImageDraw, ImageOps
from reconstruction_plane_evidence import inventory_exclusions
from reconstruction_geometry.consensus import merge_wall_patches

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from reconstruction_geometry.planes import CONFIG, angle_unsigned, extract_planes, map_to_semantic, object_exclusions, orient_to_camera, pca_plane, ransac, summarize_plane, unit


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def no_network():
    def audit(event, _):
        if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto", "urllib.Request"}:
            raise RuntimeError(f"Offline plane evaluation forbids {event}")
    sys.addaudithook(audit)




















def render_overlay(photo, raw_floor, raw_wall, excluded, clean_floor, clean_wall, labels, residual, threshold, planes, target, case_id):
    def tint(base, mask, color, strength=.45):
        out = base.copy()
        out[mask] = np.round(out[mask] * (1 - strength) + np.array(color) * strength).astype(np.uint8)
        return out
    cleaned = tint(photo, clean_floor, [50, 235, 80])
    cleaned = tint(cleaned, clean_wall, [70, 135, 255])
    cleaned = tint(cleaned, excluded & (raw_floor | raw_wall), [255, 45, 45], .65)
    palette = [[35, 245, 85], [165, 255, 60], [210, 245, 75], [60, 165, 255], [255, 155, 45], [225, 75, 240], [40, 230, 215], [245, 230, 60], [225, 100, 100]]
    fitted = photo.copy()
    for plane in planes:
        color_index = int(plane["id"].split("-")[-1]) - 1 + (0 if plane["kind"] == "floor" else 3)
        code = int(plane["id"].split("-")[-1]) + (0 if plane["kind"] == "floor" else 10)
        fitted = tint(fitted, labels == code, palette[color_index % len(palette)], .60)
    error = (photo * .30).astype(np.uint8)
    finite = np.isfinite(residual)
    ratio = np.zeros_like(residual)
    ratio[finite] = np.minimum(residual[finite] / threshold, 1)
    error[finite] = np.column_stack([ratio[finite] * 255, (1 - ratio[finite]) * 255, np.full(finite.sum(), 60)]).astype(np.uint8)
    images = [(photo, "Input; same full-frame semantic grid"), (cleaned, "Clean candidates: floor green/wall blue; object exclusion red"),
              (fitted, "Inlier evidence patches only; dark pixels are not inferred boundaries"), (error, "Inlier residual / threshold: green low, red high; no metric accuracy")]
    cw, ch, header = 620, 530, 60
    board = Image.new("RGB", (cw * 2, (ch + header) * 2 + 85), (22, 24, 28))
    draw = ImageDraw.Draw(board)
    draw.text((12, 12), f"{case_id}: OFFLINE OBSERVED PLANE EVIDENCE; NOT PHYSICAL ROOM EXTENT", fill="white")
    draw.text((12, 36), " | ".join(f"{p['id']}:{p['support']['pixels']}px/{p['residual']['inlierP95']:.4f} p95" for p in planes), fill="white")
    for i, (im, title) in enumerate(images):
        x, y = i % 2 * cw, i // 2 * (ch + header) + 85
        thumbnail = ImageOps.contain(Image.fromarray(im), (cw, ch), Image.Resampling.LANCZOS)
        board.paste(thumbnail, (x + (cw - thumbnail.width) // 2, y))
        draw.text((x + 8, y + ch + 12), title, fill="white")
    board.save(target / "overlay.png")
    board.save(target / "overlay-preview.jpg", quality=86)


def check_sources(semantic_report, frozen=None, semantic_path=None):
    expected = semantic_report["sourceHashes"]
    actual = {path: digest(ROOT / path) for path in expected}
    if frozen is not None:
        saved = frozen["semantic"]
        if (semantic_path is None or digest(semantic_path) != saved["sha256"]
                or expected != saved["sourceHashes"]):
            raise ValueError("Frozen semantic report or original capture provenance changed")
        return expected
    if expected != actual:
        raise ValueError("Semantic capture source hashes differ from current code")
    return actual




def evaluate_case(case, geometry_root, semantic_root, target, rng, frozen=None, use_inventory=False, merge_patches=False):
    started = time.perf_counter()
    case_id = case["id"]
    geometry_report = json.loads((geometry_root / case_id / "report.json").read_text(encoding="utf-8"))
    semantic_path = semantic_root / case_id / "report.json"
    semantic = json.loads(semantic_path.read_text(encoding="utf-8"))
    if semantic.get("errors") or semantic.get("external"):
        raise ValueError("Semantic capture reported browser/network errors")
    input_path = ROOT / case["input"]["path"]
    input_hash = digest(input_path)
    if not input_hash == case["input"]["sha256"] == semantic["inputSha256"] == geometry_report["input"]["sha256"]:
        raise ValueError("Input hash mismatch across MoGe, semantic capture, and manifest")
    if frozen is not None and frozen["inputSha256"] != input_hash:
        raise ValueError("Frozen replay input identity changed")
    sources = check_sources(semantic, frozen, semantic_path)
    geometry_path = geometry_root / case_id / "geometry.npz"
    if digest(geometry_path) != geometry_report["artifacts"]["geometrySha256"]:
        raise ValueError("Saved pointmap hash differs from actual model-run report")
    w, h = semantic["width"], semantic["height"]
    with np.load(geometry_path, allow_pickle=False) as archive:
        original_h, original_w = archive["depth"].shape
        if (original_w, original_h) != (case["input"]["width"], case["input"]["height"]):
            raise ValueError("Input and pointmap dimensions differ")
        aspect_error = abs(original_w / original_h - w / h)
        if aspect_error > 1 / h + 1 / original_h:
            raise ValueError("Semantic grid aspect ratio indicates a crop or unexpected mapping")
        points, normals, mask, map_x, map_y = map_to_semantic(archive["points"], archive["normal"], archive["mask"], w, h)
        intrinsics = archive["intrinsics"].copy()
    paths = {key: semantic_root / case_id / name for key, name in {"floor": "floor.u8", "wall": "wall.u8", "photo": "photo.rgba"}.items()}
    if frozen is not None and {k: digest(p) for k, p in paths.items()} != frozen["semantic"]["buffers"]:
        raise ValueError("Frozen semantic buffers changed")
    raw_floor, raw_wall = [np.fromfile(paths[key], dtype=np.uint8).reshape(h, w) > 0 for key in ("floor", "wall")]
    photo = np.fromfile(paths["photo"], dtype=np.uint8).reshape(h, w, 4)[..., :3]
    lengths = np.linalg.norm(normals, axis=-1)
    valid = mask & np.isfinite(points).all(axis=-1) & np.isfinite(normals).all(axis=-1) & (points[..., 2] > 0) & (lengths > .9) & (lengths < 1.1)
    safe_lengths = np.where(valid, lengths, 1)
    normals = normals / safe_lengths[..., None]
    excluded, object_records = object_exclusions(semantic)
    inventory_records, inventory_source = [], None
    inventory_mask = np.zeros((h, w), dtype=bool)
    if use_inventory:
        if frozen is None:
            raise ValueError("Inventory exclusions require a frozen input/report manifest")
        inventory_path = ROOT / frozen["inventory"]["path"]
        if digest(inventory_path) != frozen["inventory"]["sha256"]:
            raise ValueError("Frozen raw inventory report changed")
        inventory_report = json.loads(inventory_path.read_text(encoding="utf-8-sig"))
        inventory_mask, inventory_records, inventory_source = inventory_exclusions(
            inventory_report, input_hash, (original_w, original_h), (w, h), CONFIG["objectMarginGridPixels"])
        inventory_source.update(reportPath=frozen["inventory"]["path"], reportSha256=digest(inventory_path))
        excluded |= inventory_mask
    structure = np.ones((3, 3), dtype=bool)
    eroded_floor = ndimage.binary_erosion(raw_floor, structure, iterations=CONFIG["erosionGridPixels"], border_value=0)
    eroded_wall = ndimage.binary_erosion(raw_wall, structure, iterations=CONFIG["erosionGridPixels"], border_value=0)
    clean_floor = eroded_floor & ~excluded & valid & ~raw_wall
    clean_wall = eroded_wall & ~excluded & valid & ~raw_floor
    threshold = float(np.median(points[..., 2][valid])) * CONFIG["distanceThresholdMedianDepthRatio"]
    floor, rejected_floor, floor_labels, floor_count = extract_planes(points, normals, clean_floor, threshold, rng, "floor")
    gravity = np.array(floor[0]["equation"]["normal"]) if floor else None
    walls, rejected_walls, wall_labels, wall_count = extract_planes(points, normals, clean_wall, threshold, rng, "wall", gravity=gravity)
    unmerged_walls, merge_checks = walls, []
    if merge_patches:
        walls, wall_labels, merge_checks = merge_wall_patches(
            walls, wall_labels, points, normals, threshold, gravity, int(clean_wall.sum()))
    labels = np.where(floor_labels > 0, floor_labels, wall_labels).astype(np.int16)
    planes = [*floor, *walls]
    residual = np.full((h, w), np.nan, dtype=np.float32)
    for plane in planes:
        code = int(plane["id"].split("-")[-1]) + (0 if plane["kind"] == "floor" else 10)
        chosen = labels == code
        residual[chosen] = np.abs(points[chosen] @ np.array(plane["equation"]["normal"]) + plane["equation"]["d"])
    orientation_axes = []
    for wall in walls:
        normal = np.array(wall["equation"]["normal"])
        index = next((i for i, axis in enumerate(orientation_axes) if angle_unsigned(normal, axis) <= CONFIG["parallelClusterToleranceDegrees"]), None)
        if index is None:
            index = len(orientation_axes)
            orientation_axes.append(normal)
        wall["orientationCluster"] = index + 1
    pairs = []
    for i, a in enumerate(walls):
        for b in walls[i + 1:]:
            angle = angle_unsigned(a["equation"]["normal"], b["equation"]["normal"])
            if angle >= 90 - CONFIG["wallVerticalToleranceDegrees"]:
                pairs.append({"planeIds": [a["id"], b["id"]], "angleDegreesUnsigned": angle})
    mirror_kinds = {"mirror", "mirror-cabinet", "glass-partition", "window"}
    warnings = ["Plane groups retain disjoint observed support; direction alone does not establish a physical wall. No room-face naming is performed.",
                "All object bounding rectangles excluded conservatively; no per-object pixel masks were captured. True plane support inside those rectangles is also removed.",
                "Mirror/window/glass exclusions cover detected rectangles only; missing or incomplete detections and transparent overlaps cannot be ruled out.",
                "Normals and pointmap come from the same neural model, not independent measurements.",
                "Coplanar/parallel columns, furniture missed by segmentation, and adjacent-room surfaces may remain; observed wall labels are not named room boundaries.",
                "No full physical floor extent, source camera extrinsics, room origin, or measured scale is solved."]
    report = {"schemaVersion": 1, "id": case_id, "split": case["split"], "status": "evaluated",
              "elapsedSeconds": time.perf_counter() - started, "inputSha256": input_hash,
              "provenance": "Local MoGe-2 pointmap and actual local DeepLab masks; offline numeric evidence only, not manual correction or AI fixture placement success",
              "hashes": {"geometryNpz": digest(geometry_path), "geometryReport": digest(geometry_root / case_id / "report.json"),
                         "semanticReport": digest(semantic_path), "semanticBuffers": {k: digest(p) for k, p in paths.items()},
                         "captureSources": sources,
                         "captureSourceMode": "frozen-historical-replay" if frozen is not None else "current-code",
                         "sourceHashMatchStart": sources == {p: digest(ROOT / p) for p in sources},
                         "savedCaptureIntegrityStart": True, "inventory": inventory_source},
              "mapping": {"geometryWidth": original_w, "geometryHeight": original_h, "semanticWidth": w, "semanticHeight": h,
                  "method": "Full-frame grid-center nearest pointmap sample: original index=floor((grid index+0.5)*original size/grid size). No interpolation across object edges.",
                  "captureTransformEvidence": "Capture harness draws full decoded image to mask-sized OffscreenCanvas without crop; supplied width/height match exact u8 and rgba lengths.",
                  "aspectRatioRoundingError": aspect_error, "maximumCenterMappingErrorOriginalPixels": .5,
                  "intrinsicsNormalized": intrinsics.tolist()},
              "candidateFiltering": {"validGeometryPixels": int(valid.sum()), "invalidGeometryPixels": int((~valid).sum()),
                  "rawFloorPixels": int(raw_floor.sum()), "rawWallPixels": int(raw_wall.sum()),
                  "floorAfterErosion": int(eroded_floor.sum()), "wallAfterErosion": int(eroded_wall.sum()),
                  "floorExcludedByObjectRectangles": int((eroded_floor & excluded).sum()),
                  "wallExcludedByObjectRectangles": int((eroded_wall & excluded).sum()),
                  "cleanFloorPixels": int(clean_floor.sum()), "cleanWallPixels": int(clean_wall.sum()),
                  "objectsExcluded": object_records, "mirrorWindowGlassRectangles": [o for o in object_records if o["kind"] in mirror_kinds],
                  "inventoryRegions": inventory_records, "inventoryExcludedFloorPixels": int((eroded_floor & inventory_mask).sum()),
                  "inventoryExcludedWallPixels": int((eroded_wall & inventory_mask).sum())},
              "distanceThresholdModelUnits": threshold, "floors": floor, "walls": walls,
              "wallPatchGrouping": {"enabled": merge_patches, "maximumNormalDegrees": 5,
                  "maximumOffsetThresholdMultiple": 2, "adjacencyGridPixels": 2,
                  "requiresAllIndependentPixels": True, "checks": merge_checks},
              "unmergedWalls": unmerged_walls if merge_patches else [],
              "rejectedPlaneCandidates": [*rejected_floor, *rejected_walls],
              "unassigned": {"floor": floor_count, "wall": wall_count},
              "floorGravityCandidate": {"upCamera": gravity.tolist(), "downCamera": (-gravity).tolist(),
                   "basis": floor[0]["id"], "measuredGravity": False} if gravity is not None else None,
              "wallOrientationClusters": [axis.tolist() for axis in orientation_axes], "approximatelyOrthogonalWallPairs": pairs,
              "hasFloorAndTwoApproximatelyOrthogonalWallPatches": bool(floor and pairs),
              "calibrationStatus": "Not calibrated: this boolean only describes supported observed plane patches, not physical room corners or accepted source camera",
              "warnings": warnings}
    target.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target / "support-labels.npz", labels=labels, clean_floor=clean_floor, clean_wall=clean_wall,
                        excluded_object_bounds=excluded, sample_original_x=map_x, sample_original_y=map_y, residual=residual)
    render_overlay(photo, raw_floor, raw_wall, excluded, clean_floor, clean_wall, labels, residual, threshold, planes, target, case_id)
    if check_sources(semantic, frozen, semantic_path) != sources:
        raise ValueError("Capture sources changed during case evaluation")
    report["hashes"]["sourceHashMatchEnd"] = sources == {p: digest(ROOT / p) for p in sources}
    report["hashes"]["savedCaptureIntegrityEnd"] = True
    report["artifacts"] = {"labels": str((target / "support-labels.npz").relative_to(ROOT)), "overlay": str((target / "overlay.png").relative_to(ROOT))}
    report["elapsedSeconds"] = time.perf_counter() - started
    write_json(target / "report.json", report)
    return report


def self_test():
    rng = np.random.default_rng(5)
    xz = rng.uniform(-1, 1, size=(2000, 2))
    floor = np.column_stack([xz[:, 0], np.full(2000, .8), xz[:, 1] + 3])
    floor += rng.normal(0, .001, floor.shape)
    normals = np.tile([0., -1., 0.], (2000, 1))
    outliers = rng.uniform(-3, 3, size=(400, 3))
    points = np.vstack([floor, outliers])
    ns = np.vstack([normals, np.tile([1., 0., 0.], (400, 1))])
    fit = ransac(points, ns, .01, rng)
    assert fit is not None and fit["inliers"].sum() >= 1950
    assert (np.abs(points[fit["inliers"]] @ fit["normal"] + fit["offset"]) <= .01 + 1e-10).all()
    assert abs(abs(fit["normal"][1]) - 1) < .001 and abs(abs(fit["offset"]) - .8) < .002
    wall = floor[:, [1, 0, 2]]
    fit_wall = ransac(wall, np.tile([-1., 0., 0.], (2000, 1)), .01, rng, gravity=np.array([0., -1., 0.]))
    assert fit_wall is not None and angle_unsigned(fit_wall["normal"], fit["normal"]) > 89
    assert ransac(floor, normals, .01, rng, gravity=np.array([0., -1., 0.])) is None
    p = np.zeros((7, 11, 3)); n = p.copy(); mask = np.ones((7, 11), bool)
    _, _, mapped, xx, yy = map_to_semantic(p, n, mask, 5, 3)
    assert mapped.shape == (3, 5) and xx.tolist() == [1, 3, 5, 7, 9] and yy.tolist() == [1, 3, 5]
    print(json.dumps({"selfTest": "passed", "checks": ["plane-with-outliers", "orthogonal-wall", "floor-rejected-as-wall", "full-frame-center-mapping"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geometry", type=Path, default=ROOT / "test-results/reconstruction-moge2-20260913")
    parser.add_argument("--semantic", type=Path, default=ROOT / "test-results/reconstruction-floor-geometry-20260913/semantic")
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/reconstruction-floor-geometry-20260913/planes")
    parser.add_argument("--case", action="append")
    parser.add_argument("--saved-inputs-manifest", type=Path)
    parser.add_argument("--inventory-exclusions", action="store_true")
    parser.add_argument("--merge-patches", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    no_network()
    if args.self_test:
        self_test()
        return 0
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / "test-results"):
        parser.error("Private results must stay in test-results")
    manifest = json.loads((args.geometry / "manifest.json").read_text(encoding="utf-8"))
    model_summary = json.loads((args.geometry / "summary.json").read_text(encoding="utf-8"))
    if model_summary["scriptSha256"] != digest(ROOT / "tests/reconstruction-moge2-probe.py"):
        raise ValueError("MoGe inference script no longer matches saved model run")
    cases = [case for case in manifest["cases"] if not args.case or case["id"] in args.case]
    frozen = None
    if args.saved_inputs_manifest:
        frozen = json.loads(args.saved_inputs_manifest.read_text(encoding="utf-8-sig"))
        if frozen.get("schemaVersion") != 1 or any(case["id"] not in frozen.get("cases", {}) for case in cases):
            raise ValueError("Frozen replay manifest version/cases mismatch")
    if args.inventory_exclusions and frozen is None:
        parser.error("--inventory-exclusions requires --saved-inputs-manifest")
    if args.saved_inputs_manifest and any((output / case["id"]).exists() for case in cases):
        parser.error("Frozen replay requires a new per-case output directory")
    summary = {"schemaVersion": 1, "scope": "Offline plane observations only; all numeric thresholds are development diagnostics, not calibrated confidence or physical measurement.",
               "config": CONFIG, "scriptSha256": digest(__file__),
               "helperSha256": digest(ROOT / "tests/reconstruction_plane_evidence.py"),
               "savedInputsManifestSha256": digest(args.saved_inputs_manifest) if args.saved_inputs_manifest else None,
               "inventoryExclusions": args.inventory_exclusions, "mergePatches": args.merge_patches,
               "mogeSummarySha256": digest(args.geometry / "summary.json"),
               "modelRevision": model_summary["modelRevision"], "modelSourceRevision": model_summary["sourceRevision"],
               "cases": [], "errors": [], "status": "running"}
    output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    for case in cases:
        try:
            case_seed = CONFIG["seed"] + int(hashlib.sha256(case["id"].encode()).hexdigest()[:8], 16)
            report = evaluate_case(case, args.geometry, args.semantic, output / case["id"], np.random.default_rng(case_seed),
                                   frozen["cases"][case["id"]] if frozen else None,
                                   args.inventory_exclusions, args.merge_patches)
            brief = {"id": case["id"], "split": case["split"], "status": "evaluated", "floors": len(report["floors"]),
                     "walls": len(report["walls"]), "wallAxes": len(report["wallOrientationClusters"]),
                     "orthogonalPairs": report["approximatelyOrthogonalWallPairs"],
                     "floorAndTwoWallPatches": report["hasFloorAndTwoApproximatelyOrthogonalWallPatches"],
                     "floorGravityCandidate": report["floorGravityCandidate"],
                     "floorMedianResidual": report["floors"][0]["residual"]["inlierMedian"] if report["floors"] else None,
                     "filteredFloorPixels": report["candidateFiltering"]["cleanFloorPixels"],
                     "filteredWallPixels": report["candidateFiltering"]["cleanWallPixels"], "elapsedSeconds": report["elapsedSeconds"]}
            summary["cases"].append(brief)
        except Exception as error:
            brief = {"id": case["id"], "status": "failed", "error": str(error), "traceback": traceback.format_exc()}
            summary["errors"].append(brief)
            write_json(output / case["id"] / "failure.json", brief)
        write_json(output / "summary.json", summary)
        print(json.dumps(brief), flush=True)
    summary["status"] = "evaluated" if not summary["errors"] else "failed"
    summary["totalSeconds"] = time.perf_counter() - started
    write_json(output / "summary.json", summary)
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())