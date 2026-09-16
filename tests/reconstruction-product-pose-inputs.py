"""Export frozen real semantic/MoGe samples for the TypeScript pose experiment.

No inference, invented product surfaces, case-specific dimensions, or manual poses.
Private reports remain under ignored test-results. Camera-space-only cases stay held.
"""
import hashlib
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SURFACES = ROOT / "test-results/reconstruction-object-surfaces-20260913/surfaces"
GEOMETRY = ROOT / "test-results/reconstruction-floor-geometry-20260913/placement"
OUT = ROOT / "test-results/reconstruction-product-pose-20260913/inputs"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def rotation(q):
    x, y, z, w = q
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
    ])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    summary = []
    for path in sorted(SURFACES.glob("user-*/report.json")):
        report = load(path)
        case_id = report["id"]
        placement_path = GEOMETRY / case_id / "report.json"
        placement = load(placement_path)
        semantic_path = GEOMETRY.parent / "semantic" / case_id / "report.json"
        semantic = load(semantic_path)
        points_path = path.with_name("surface-points.npz")
        if digest(placement_path) != report["provenance"]["placementReportSha256"]:
            raise ValueError(f"{case_id}: source camera report changed; explicitly regenerate surface diagnostic first")
        if placement["observation"]["inputFingerprint"] != report["provenance"]["inputSha256"]:
            raise ValueError(f"{case_id}: image identity mismatch")
        if semantic["inputSha256"] != report["provenance"]["inputSha256"]:
            raise ValueError(f"{case_id}: room settings belong to a different image")
        camera = report["camera"].get("camera")
        usable = report["camera"]["status"] == "estimated" and camera is not None
        walls = []
        if usable:
            matrix = rotation(camera["quaternion"]) @ np.diag([1, -1, -1])
            position = np.array(camera["positionMm"])
            selected = placement["camera"].get("selected", {})
            for wall in placement["observation"]["walls"]:
                if wall["id"] not in (selected.get("backId"), selected.get("sideId")):
                    continue
                normal = matrix @ wall["normalCamera"]
                walls.append({
                    "id": wall["id"],
                    "normalWorld": normal.tolist(),
                    "offsetMm": float(wall["offset"] * 1000 - normal @ position),
                    "medianPointWorldMm": (position + matrix @ np.array(wall["medianPointCamera"]) * 1000).tolist(),
                    "inlierCount": wall["inlierCount"],
                    "rmsResidualMm": wall["rmsResidual"] * 1000,
                })
        candidates = []
        with np.load(points_path, allow_pickle=False) as npz:
            for c in report["candidates"]:
                cid = c["candidateId"]
                key = cid + "_pointsWorldMm"
                samples = []
                if usable and key in npz:
                    pts, normals, labels = npz[key], npz[cid + "_normalsWorld"], npz[cid + "_labels"]
                    if not (len(pts) == len(normals) == len(labels)):
                        raise ValueError("Sample arrays have different lengths")
                    # Preserve every retained sample; sampling must not bias large end/side faces.
                    samples = [
                        {"pointWorldMm": p.tolist(), "normalWorld": n.tolist(), "semanticLabel": int(label)}
                        for p, n, label in zip(pts, normals, labels)
                    ]
                candidates.append({
                    "candidateId": cid, "kind": c["kind"], "samples": samples,
                    "sourceStatus": c["status"],
                    "sourceCoordinates": "model-world-mm" if usable else "opencv-camera-metres",
                    "evidence": {
                        "association": "same-kind-mask-in-candidate",
                        "reflections": "known-regions-excluded",
                        "contamination": "unassessed",
                    },
                })
        output = {
            "version": 1, "id": case_id,
            "inputFingerprint": report["provenance"]["inputSha256"],
            "cameraStatus": report["camera"]["status"],
            "room": semantic["room"],
            "camera": camera, "walls": walls, "candidates": candidates,
            "observation": placement["observation"],
            "frozenComparison": placement["comparison"],
            "provenance": {
                "surfaceReportSha256": digest(path), "pointsSha256": digest(points_path),
                "placementReportSha256": digest(placement_path), "exporterSha256": digest(Path(__file__)),
                "roomReportSha256": digest(semantic_path),
                "sources": report["provenance"],
                "newInference": False, "manualPlacement": False,
                "scope": "Frozen real observations; model-world is estimated, not measured. No room pose is generated for held cases.",
            },
        }
        (OUT / (case_id + ".json")).write_text(json.dumps(output, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        summary.append({"id": case_id, "cameraStatus": output["cameraStatus"], "candidates": [
            {"id": c["candidateId"], "kind": c["kind"], "samples": len(c["samples"])} for c in candidates
        ]})
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
