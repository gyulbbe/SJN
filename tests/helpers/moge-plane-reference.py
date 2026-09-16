"""Offline plane-extraction reference for browser parity; no model loading or inference."""
import base64
import hashlib
from pathlib import Path
from reconstruction_geometry.model import MODEL_REPO, MODEL_REVISION
ROOT = Path(__file__).resolve().parents[2]
REVISION = "moge2-semantic-planes-v2-consensus-support"
def source_revision():
    paths = [Path(__file__), ROOT / "scripts/reconstruction_geometry/planes.py",
             ROOT / "scripts/reconstruction_geometry/consensus.py"]
    return hashlib.sha256("".join(hashlib.sha256(p.read_bytes()).hexdigest() for p in paths).encode()).hexdigest()

def compact_support(label, code, bounds):
    import numpy as np
    h, w = label.shape
    yy, xx = np.nonzero(label == code)
    cells = np.zeros((64, 64), dtype=np.uint8)
    if len(xx):
        cells[np.minimum(63, yy * 64 // h), np.minimum(63, xx * 64 // w)] = 1
    return {"bounds": bounds, "width": 64, "height": 64, "occupied": "".join(map(str, cells.ravel()))}


def create_observation(arrays, metadata, fingerprint):
    import numpy as np
    from scipy import ndimage
    from reconstruction_geometry.planes import CONFIG, map_to_semantic, object_exclusions, extract_planes
    from reconstruction_geometry.consensus import merge_wall_patches
    w, h = metadata["mask"]["width"], metadata["mask"]["height"]
    points, normals, valid_mask, _, _ = map_to_semantic(
        arrays["points"], arrays["normal"], arrays["mask"], w, h)
    k = arrays["intrinsics"]
    raw_floor = np.frombuffer(base64.b64decode(metadata["floor"], validate=True), np.uint8).reshape(h, w) > 0
    raw_wall = np.frombuffer(base64.b64decode(metadata["wall"], validate=True), np.uint8).reshape(h, w) > 0
    lengths = np.linalg.norm(normals, axis=-1)
    valid = valid_mask & np.isfinite(points).all(axis=-1) & np.isfinite(normals).all(axis=-1)
    valid &= (points[..., 2] > 0) & (lengths > .9) & (lengths < 1.1)
    normals = normals / np.where(valid, lengths, 1)[..., None]
    excluded, records = object_exclusions({"width": w, "height": h, "objects": metadata["regions"]})
    floor_eroded = ndimage.binary_erosion(raw_floor, np.ones((3, 3)), iterations=CONFIG["erosionGridPixels"])
    wall_eroded = ndimage.binary_erosion(raw_wall, np.ones((3, 3)), iterations=CONFIG["erosionGridPixels"])
    floor_mask = floor_eroded & ~excluded & valid & ~raw_wall
    wall_mask = wall_eroded & ~excluded & valid & ~raw_floor
    rng = np.random.default_rng(CONFIG["seed"])
    threshold = float(np.median(points[..., 2][valid])) * CONFIG["distanceThresholdMedianDepthRatio"] if valid.any() else 0.01
    floors, bad_floor, floor_labels, floor_count = extract_planes(points, normals, floor_mask, threshold, rng, "floor")
    gravity = np.array(floors[0]["equation"]["normal"]) if floors else None
    walls, bad_wall, wall_labels, wall_count = extract_planes(points, normals, wall_mask, threshold, rng, "wall", gravity=gravity)
    original_walls = walls
    walls, wall_labels, merge_checks = merge_wall_patches(
        walls, wall_labels, points, normals, threshold, gravity, int(wall_mask.sum()))
    def plane(item):
        code = int(item["id"].split("-")[-1]) + (0 if item["kind"] == "floor" else 10)
        return {"id": item["id"], "normalCamera": item["equation"]["normal"], "offset": item["equation"]["d"],
                "medianPointCamera": item["support"]["medianPointProjectedOntoPlaneCamera"],
                "inlierCount": item["support"]["pixels"], "inlierFraction": item["support"]["originalCandidateRatio"],
                "imageAreaFraction": item["support"]["imageAreaRatio"],
                "rmsResidual": float(np.sqrt(max(0, item["residual"]["pcaEigenvaluesAscending"][0]))),
                "imageSupport": compact_support(floor_labels if item["kind"] == "floor" else wall_labels, code,
                                                 item["support"]["bboxNormalized"])}
    observation = {
        "version": 1, "inputFingerprint": fingerprint, "image": metadata["image"],
        "model": {"id": MODEL_REPO, "revision": MODEL_REVISION},
        "coordinateSystem": "opencv-camera", "scale": "model-estimated-metres",
        "intrinsics": {"fx": float(k[0, 0]), "fy": float(k[1, 1]), "cx": float(k[0, 2]), "cy": float(k[1, 2])},
        "floor": plane(floors[0]) if floors else None, "walls": [plane(p) for p in walls],
    }
    def summary(p):
        return {key: p[key] for key in ("id", "kind", "status", "reasons", "support", "residual", "groupedFrom") if key in p}
    evidence = {
        "revision": REVISION, "sourceRevision": source_revision(), "scope": "observed-model-planes-not-physical-room-boundaries",
        "maskSize": metadata["mask"], "geometryAnalysisSize": {"width": arrays["depth"].shape[1], "height": arrays["depth"].shape[0]},
        "coordinateMapping": "full-frame normalized nearest pixel centres; no crop",
        "model": observation["model"], "candidateFiltering": {
            "validGeometryPixels": int(valid.sum()), "rawFloorPixels": int(raw_floor.sum()), "rawWallPixels": int(raw_wall.sum()),
            "excludedFloorPixels": int((floor_eroded & excluded).sum()), "excludedWallPixels": int((wall_eroded & excluded).sum()),
            "cleanFloorPixels": int(floor_mask.sum()), "cleanWallPixels": int(wall_mask.sum()),
            "overlappingSemanticPixels": int((raw_floor & raw_wall).sum()),
        },
        "excludedRegions": records, "planes": [summary(p) for p in floors + walls],
        "unmergedWalls": [summary(p) for p in original_walls],
        "wallPatchGrouping": {"enabled": True, "maximumNormalDegrees": 5, "maximumOffsetThresholdMultiple": 2,
                              "adjacencyGridPixels": 2, "allOriginalPointsRequired": True,
                              "discardedPixels": 0, "checks": merge_checks},
        "rejectedPlanes": [summary(p) for p in bad_floor + bad_wall],
        "unassigned": {"floor": floor_count, "wall": wall_count},
        "warnings": [
            "모델이 추정한 거리이며 실측값이 아닙니다.",
            "설비·거울·유리·개구부의 사각 영역을 보수적으로 제외하여 그 뒤 실제 벽 지지도 일부 제거될 수 있습니다.",
            "관측 평면 조각을 전체 방 경계로 승격하지 않습니다.",
            "유리 뒤의 깊이, 반사, 미검출 물체와 인접 공간은 여전히 오인될 수 있습니다.",
        ],
    }
    return observation, evidence, {"floorLabels": floor_labels, "wallLabels": wall_labels, "excluded": excluded}


