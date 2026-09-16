"""Shared plane fitting extracted from the offline probe. Estimates, not room boundaries."""
import math
import numpy as np
from scipy.spatial import ConvexHull

CONFIG = {
    "seed": 20260913, "erosionGridPixels": 2, "objectMarginGridPixels": 2,
    "ransacTrials": 384, "normalSeedTrials": 96, "maximumScoringPoints": 6000, "maximumRefinedHypotheses": 12,
    "distanceThresholdMedianDepthRatio": 0.008, "maximumNormalAngleDegrees": 15,
    "wallVerticalToleranceDegrees": 15, "parallelClusterToleranceDegrees": 10,
    "minimumInlierPixels": 300, "minimumImageAreaRatio": 0.0025,
    "minimumRemainingInlierRatio": 0.12, "minimumPcaSecondToFirstSpread": 0.01,
    "maximumFloorPlanes": 3, "maximumWallPlanes": 6,
}


def unit(vector):
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 1e-12 else np.zeros(3)


def angle_unsigned(a, b):
    return math.degrees(math.acos(float(np.clip(abs(np.dot(a, b)), 0, 1))))


def orient_to_camera(normal, offset, center):
    if np.dot(normal, center) > 0:
        return -normal, -offset
    return normal, offset


def pca_plane(points):
    center = points.mean(axis=0)
    delta = points - center
    values, vectors = np.linalg.eigh(delta.T @ delta / len(points))
    normal = vectors[:, 0]
    normal, offset = orient_to_camera(normal, -np.dot(normal, center), center)
    return normal, float(offset), center, values, vectors


def ransac(points, normals, threshold, rng, gravity=None, parallel=None, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else {}
    if len(points) < CONFIG["minimumInlierPixels"]:
        diagnostics["termination"] = "insufficient-remaining-candidate-pixels"
        return None
    chosen = rng.choice(len(points), min(len(points), CONFIG["maximumScoringPoints"]), replace=False)
    p, ns = points[chosen], normals[chosen]
    triples = rng.integers(0, len(p), size=(CONFIG["ransacTrials"], 3))
    tri = p[triples]
    proposal_n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    lengths = np.linalg.norm(proposal_n, axis=1)
    valid = lengths > threshold * threshold
    proposal_n = proposal_n[valid] / lengths[valid, None]
    proposal_d = -np.einsum("ij,ij->i", proposal_n, tri[valid, 0])
    seeds = rng.choice(len(p), min(len(p), CONFIG["normalSeedTrials"]), replace=False)
    proposal_n = np.concatenate([proposal_n, ns[seeds]], axis=0)
    proposal_d = np.concatenate([proposal_d, -np.einsum("ij,ij->i", ns[seeds], p[seeds])])
    pca_n, pca_d, _, _, _ = pca_plane(p)
    proposal_n = np.vstack([proposal_n, pca_n])
    proposal_d = np.append(proposal_d, pca_d)
    permitted = np.ones(len(proposal_n), dtype=bool)
    if gravity is not None:
        permitted &= np.abs(proposal_n @ gravity) <= math.sin(math.radians(CONFIG["wallVerticalToleranceDegrees"]))
    if parallel is not None:
        permitted &= np.abs(proposal_n @ parallel) >= math.cos(math.radians(CONFIG["maximumNormalAngleDegrees"]))
    diagnostics["hypothesesBeforeOrientation"] = len(proposal_n)
    proposal_n, proposal_d = proposal_n[permitted], proposal_d[permitted]
    diagnostics["hypothesesAfterOrientation"] = len(proposal_n)
    if not len(proposal_n):
        diagnostics["termination"] = "no-orientation-compatible-hypothesis"
        return None
    scores = np.zeros(len(proposal_n), dtype=np.int64)
    cos_normal = math.cos(math.radians(CONFIG["maximumNormalAngleDegrees"]))
    for begin in range(0, len(proposal_n), 48):
        pn, pd = proposal_n[begin:begin + 48], proposal_d[begin:begin + 48]
        residual = np.abs(p @ pn.T + pd)
        compatible = np.abs(ns @ pn.T) >= cos_normal
        scores[begin:begin + len(pn)] = ((residual <= threshold) & compatible).sum(axis=0)
    diagnostics["bestJointDistanceNormalConsensusOnSample"] = int(scores.max())
    # Test distinct high-ranked hypotheses: a failed first PCA fit must not hide other walls.
    ranked = []
    for index in np.argsort(-scores, kind="stable"):
        if scores[index] < 3:
            break
        normal, offset = proposal_n[index], proposal_d[index]
        duplicate = False
        for previous in ranked:
            same_sign = 1 if np.dot(normal, proposal_n[previous]) >= 0 else -1
            if angle_unsigned(normal, proposal_n[previous]) < 5 and abs(offset - same_sign * proposal_d[previous]) < 2 * threshold:
                duplicate = True
                break
        if not duplicate:
            ranked.append(int(index))
        if len(ranked) == CONFIG["maximumRefinedHypotheses"]:
            break
    evaluations, best_fit = [], None
    for index in ranked:
        normal, offset = proposal_n[index], proposal_d[index]
        inliers = (np.abs(points @ normal + offset) <= threshold) & (np.abs(normals @ normal) >= cos_normal)
        initial_count = int(inliers.sum())
        converged, reason = False, None
        for _ in range(12):
            if inliers.sum() < 3:
                reason = "pca-refinement-lost-normal-distance-consensus"
                break
            normal, offset, _, _, _ = pca_plane(points[inliers])
            refined = (np.abs(points @ normal + offset) <= threshold) & (np.abs(normals @ normal) >= cos_normal)
            if np.array_equal(refined, inliers):
                converged = True
                break
            inliers = refined
        if inliers.sum() < 3:
            reason = "pca-refinement-lost-normal-distance-consensus"
        if reason is None and gravity is not None and abs(np.dot(normal, gravity)) > math.sin(math.radians(CONFIG["wallVerticalToleranceDegrees"])):
            reason = "pca-refinement-lost-verticality"
        if reason is None and parallel is not None and abs(np.dot(normal, parallel)) < cos_normal:
            reason = "pca-refinement-lost-floor-parallelism"
        if reason is None:
            # Keep the tested equation. Updating n,d after membership would invalidate the residual contract.
            _, _, center, eigenvalues, eigenvectors = pca_plane(points[inliers])
            if eigenvalues[1] / max(eigenvalues[2], 1e-12) < CONFIG["minimumPcaSecondToFirstSpread"]:
                reason = "near-collinear-refined-support"
        evaluation = {"sampleScore": int(scores[index]), "initialInliers": initial_count,
                      "finalInliers": int(inliers.sum()), "refinementConverged": converged, "rejection": reason}
        evaluations.append(evaluation)
        if reason is None and (best_fit is None or inliers.sum() > best_fit["inliers"].sum()):
            assert (np.abs(points[inliers] @ normal + offset) <= threshold + 1e-10).all()
            assert (np.abs(normals[inliers] @ normal) >= cos_normal - 1e-10).all()
            best_fit = {"normal": normal, "offset": offset, "inliers": inliers, "eigenvalues": eigenvalues,
                        "center": center, "eigenvectors": eigenvectors, "refinementConverged": converged}
    diagnostics["rankedHypothesisEvaluations"] = evaluations
    if best_fit is None:
        diagnostics["termination"] = "all-ranked-hypotheses-failed-refined-consensus"
        return None
    diagnostics["termination"] = "consensus-found"
    diagnostics["refinementConverged"] = best_fit["refinementConverged"]
    best_fit["diagnostics"] = diagnostics
    return best_fit


def summarize_plane(fit, points, normals, coords, image_shape, threshold, denominator, kind, index, gravity):
    chosen = fit["inliers"]
    p, n, xy = points[chosen], normals[chosen], coords[chosen]
    normal, offset = fit["normal"], fit["offset"]
    residual = np.abs(p @ normal + offset)
    all_residual = np.abs(points @ normal + offset)
    cosine = np.clip(np.abs(n @ normal), 0, 1)
    angles = np.degrees(np.arccos(cosine))
    h, w = image_shape
    left, top = xy.min(axis=0)
    right, bottom = xy.max(axis=0) + 1
    covariance = fit["eigenvalues"]
    spread_ratio = float(covariance[1] / max(covariance[2], 1e-12))
    plane_ratio = float(covariance[0] / max(covariance[1], 1e-12))
    median = np.median(p, axis=0)
    median_on_plane = median - (np.dot(median, normal) + offset) * normal
    grid = np.stack([np.floor((xy[:, 0] + .5) / w * 8), np.floor((xy[:, 1] + .5) / h * 8)], axis=1)
    occupied = np.unique(grid, axis=0)
    area_ratio = len(p) / (w * h)
    support = {"pixels": len(p), "remainingCandidateRatio": float(len(p) / len(points)),
               "originalCandidateRatio": float(len(p) / denominator), "imageAreaRatio": area_ratio,
               "bboxGridPixels": {"left": int(left), "top": int(top), "rightExclusive": int(right), "bottomExclusive": int(bottom)},
               "bboxNormalized": {"left": float(left / w), "top": float(top / h), "right": float(right / w), "bottom": float(bottom / h)},
               "occupied8x8Cells": int(len(occupied)), "occupied8x8Rows": len(np.unique(occupied[:, 1])),
               "occupied8x8Columns": len(np.unique(occupied[:, 0])),
               "medianPointCamera": median.tolist(), "medianPointProjectedOntoPlaneCamera": median_on_plane.tolist(),
               "robustPointBoundsCameraP2P98": {"lower": np.percentile(p, 2, axis=0).tolist(), "upper": np.percentile(p, 98, axis=0).tolist()},
               "boundsMeaning": "Inlier sample support only; not full physical floor/room extent"}
    projected = (p - fit["center"]) @ fit["eigenvectors"][:, 1:]
    hull_sample = projected[::max(1, len(projected) // 4000)]
    try:
        support["inlierHullAreaModelUnitsSquared"] = float(ConvexHull(hull_sample).volume)
    except Exception:
        support["inlierHullAreaModelUnitsSquared"] = None
    reasons = []
    if len(p) < CONFIG["minimumInlierPixels"]:
        reasons.append("insufficient-inlier-pixels")
    if area_ratio < CONFIG["minimumImageAreaRatio"]:
        reasons.append("insufficient-image-area-support")
    if support["remainingCandidateRatio"] < CONFIG["minimumRemainingInlierRatio"]:
        reasons.append("low-inlier-ratio")
    if spread_ratio < CONFIG["minimumPcaSecondToFirstSpread"]:
        reasons.append("near-collinear-support")
    if support["occupied8x8Rows"] < 2 or support["occupied8x8Columns"] < 2:
        reasons.append("support-concentrated-in-single-grid-row-or-column")
    if kind == "wall" and gravity is not None and abs(np.dot(normal, gravity)) > math.sin(math.radians(CONFIG["wallVerticalToleranceDegrees"])):
        reasons.append("not-vertical-relative-to-observed-floor")
    return {"id": f"{kind}-{index}", "kind": kind,
            "status": "supported-observed-plane" if not reasons else "insufficient-support",
            "reasons": reasons, "equation": {"form": "n dot p + d = 0", "normal": normal.tolist(), "d": offset,
                "normalOrientation": "Toward camera origin; unit length", "coordinateSystem": "OpenCV x-right, y-down, z-forward",
                "units": "Model-predicted metric units, not independently measured"},
            "support": support,
            "residual": {"thresholdModelUnits": threshold, "thresholdBasis": "0.8% of valid scene median model depth; fixed all-photo heuristic, not a metric accuracy tolerance",
                "inlierMedian": float(np.median(residual)), "inlierP95": float(np.percentile(residual, 95)),
                "inlierMax": float(residual.max()), "allRemainingCandidateMedian": float(np.median(all_residual)),
                "outlierPixels": int((~chosen).sum()), "normalAngleMedianDegrees": float(np.median(angles)),
                "normalAngleP95Degrees": float(np.percentile(angles, 95)),
                "pcaEigenvaluesAscending": covariance.tolist(), "pcaNormalToSecondVarianceRatio": plane_ratio,
                "pcaSecondToFirstSpreadRatio": spread_ratio},
            "fitDiagnostics": fit["diagnostics"],
            "angleToFloorNormalDegreesUnsigned": angle_unsigned(normal, gravity) if gravity is not None else None}


def extract_planes(points, normals, candidate, threshold, rng, kind, gravity=None):
    h, w = candidate.shape
    yy, xx = np.nonzero(candidate)
    coords = np.column_stack([xx, yy])
    p, n = points[yy, xx].astype(np.float64), normals[yy, xx].astype(np.float64)
    labels = np.zeros((h, w), dtype=np.int16)
    denominator = len(p)
    planes, rejected, attempts = [], [], []
    max_planes = CONFIG["maximumFloorPlanes"] if kind == "floor" else CONFIG["maximumWallPlanes"]
    floor_axis = None
    for index in range(1, max_planes + 1):
        diagnostics = {"iteration": index, "candidatePixels": len(p)}
        fit = ransac(p, n, threshold, rng, gravity=gravity, parallel=floor_axis, diagnostics=diagnostics)
        attempts.append(diagnostics)
        if fit is None:
            break
        report = summarize_plane(fit, p, n, coords, (h, w), threshold, denominator, kind, index, gravity)
        chosen = fit["inliers"]
        if report["status"] == "supported-observed-plane":
            planes.append(report)
            xy = coords[chosen]
            labels[xy[:, 1], xy[:, 0]] = index if kind == "floor" else 10 + index
            if kind == "floor" and floor_axis is None:
                floor_axis = fit["normal"]
        else:
            rejected.append(report)
        p, n, coords = p[~chosen], n[~chosen], coords[~chosen]
    return planes, rejected, labels, {"candidatePixels": denominator, "unassignedCandidatePixels": len(p), "attempts": attempts}


def map_to_semantic(points, normals, mask, width, height):
    original_h, original_w = mask.shape
    x = np.floor((np.arange(width) + .5) / width * original_w).astype(np.int32)
    y = np.floor((np.arange(height) + .5) / height * original_h).astype(np.int32)
    assert x.min() >= 0 and x.max() < original_w and y.min() >= 0 and y.max() < original_h
    return points[y[:, None], x], normals[y[:, None], x], mask[y[:, None], x], x, y


def object_exclusions(report):
    h, w = report["height"], report["width"]
    excluded = np.zeros((h, w), dtype=bool)
    records = []
    margin = CONFIG["objectMarginGridPixels"]
    for obj in report.get("objects", []):
        bounds = obj.get("bounds")
        if not bounds:
            continue
        vals = [bounds[k] for k in ("left", "top", "right", "bottom")]
        if not all(math.isfinite(v) for v in vals) or not 0 <= vals[0] < vals[2] <= 1 or not 0 <= vals[1] < vals[3] <= 1:
            raise ValueError(f"Invalid stored object bounds: {obj.get('id')}")
        left, top = max(0, math.floor(vals[0] * w) - margin), max(0, math.floor(vals[1] * h) - margin)
        right, bottom = min(w, math.ceil(vals[2] * w) + margin), min(h, math.ceil(vals[3] * h) + margin)
        excluded[top:bottom, left:right] = True
        records.append({"id": obj.get("id"), "kind": obj.get("kind"), "bounds": bounds, "source": obj.get("source"),
                        "requiresReview": bool(obj.get("requiresReview")), "exclusion": "whole-bounding-rectangle-plus-2-grid-pixels"})
    return excluded, records

