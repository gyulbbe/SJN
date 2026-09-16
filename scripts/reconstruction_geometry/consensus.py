"""Conservative observed-plane patch consensus. No source inference or case inputs."""
import math
import numpy as np
from scipy import ndimage
from reconstruction_geometry.planes import CONFIG, pca_plane, summarize_plane

def joint_patch_fit(members, labels, points, normals, threshold, gravity, pca_plane, config):
    """Retain every member's independent support; do not merge by normal alone.

    Strict complete-link direction/offset checks prevent chains bridging different walls.
    Image adjacency and a refit of the disjoint pixel sets are additional requirements.
    No point is moved, and no outlier is discarded to make a merge pass.
    """
    checks = {"members": [p["id"] for p in members], "status": "rejected"}
    if len(members) < 2:
        return None, {**checks, "reason": "requires-multiple-patches"}
    masks = []
    for member in members:
        code = 10 + int(member["id"].split("-")[-1])
        selected = labels == code
        if int(selected.sum()) != member["support"]["pixels"] or int(selected.sum()) < config["minimumInlierPixels"]:
            return None, {**checks, "reason": "missing-or-duplicate-independent-support"}
        masks.append(selected)
    for i, first in enumerate(members):
        for j in range(i + 1, len(members)):
            second = members[j]
            a, b = np.array(first["equation"]["normal"]), np.array(second["equation"]["normal"])
            dot = float(np.clip(np.dot(a, b), -1, 1))
            # Both normals face the camera: opposite normals are distinct boundaries.
            if math.degrees(math.acos(dot)) > 5:
                return None, {**checks, "reason": "different-normal-directions"}
            if abs(first["equation"]["d"] - second["equation"]["d"]) > 2 * threshold:
                return None, {**checks, "reason": "different-plane-offsets"}
            if np.any(masks[i] & masks[j]):
                return None, {**checks, "reason": "shared-pixels-are-not-independent-support"}
    # Each group must be connected through observed neighbouring pixels, not bounding boxes.
    visited = {0}
    while True:
        added = {j for j in range(len(masks)) if j not in visited and any(
            np.any(ndimage.binary_dilation(masks[i], np.ones((3, 3)), iterations=2) & masks[j]) for i in visited)}
        if not added:
            break
        visited |= added
    if len(visited) != len(masks):
        return None, {**checks, "reason": "disconnected-image-support"}
    union = np.logical_or.reduce(masks)
    yy, xx = np.nonzero(union)
    p, n = points[union].astype(np.float64), normals[union].astype(np.float64)
    normal, offset, center, values, vectors = pca_plane(p)
    residuals = np.abs(p @ normal + offset)
    compatible = np.abs(n @ normal) >= math.cos(math.radians(config["maximumNormalAngleDegrees"]))
    if not np.all(residuals <= threshold + 1e-10) or not np.all(compatible):
        return None, {**checks, "reason": "joint-refit-loses-independent-support", "maximumResidual": float(residuals.max())}
    if gravity is not None and abs(np.dot(normal, gravity)) > math.sin(math.radians(config["wallVerticalToleranceDegrees"])):
        return None, {**checks, "reason": "joint-plane-not-vertical"}
    fit = {"normal": normal, "offset": float(offset), "inliers": np.ones(len(p), dtype=bool),
           "center": center, "eigenvalues": values, "eigenvectors": vectors, "refinementConverged": True,
           "diagnostics": {"termination": "disjoint-observed-patches-joint-consensus", "members": checks["members"],
                           "independentPixelCounts": [int(m.sum()) for m in masks], "discardedPixels": 0}}
    return {"fit": fit, "points": p, "normals": n, "coords": np.column_stack([xx, yy]), "mask": union}, {
        **checks, "status": "accepted", "reason": "direction-offset-adjacency-and-all-support-agree", "maximumResidual": float(residuals.max())}

def merge_wall_patches(walls, labels, points, normals, threshold, gravity, denominator):
    """Complete-link grouping, with every raw member's support still validated."""
    groups, diagnostics = [], []
    for wall in walls:
        accepted = False
        for group in groups:
            members = group["members"] + [wall]
            joint, check = joint_patch_fit(members, labels, points, normals, threshold, gravity, pca_plane, CONFIG)
            diagnostics.append(check)
            if joint is None:
                continue
            index = int(members[0]["id"].split("-")[-1])
            report = summarize_plane(joint["fit"], joint["points"], joint["normals"], joint["coords"],
                                     labels.shape, threshold, denominator, "wall", index, gravity)
            if report["status"] != "supported-observed-plane":
                check.update(status="rejected", reason="joint-summary-has-insufficient-support")
                continue
            report["groupedFrom"] = [m["id"] for m in members]
            group.update(members=members, joint=joint, report=report)
            accepted = True
            break
        if not accepted:
            groups.append({"members": [wall], "joint": None, "report": wall})
    merged_labels = labels.copy()
    for group in groups:
        if group["joint"] is not None:
            code = 10 + int(group["report"]["id"].split("-")[-1])
            merged_labels[group["joint"]["mask"]] = code
    return [g["report"] for g in groups], merged_labels, diagnostics

