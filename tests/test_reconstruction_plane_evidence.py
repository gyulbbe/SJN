"""Contract tests for cached optical evidence and disjoint plane patch consensus."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import numpy as np
from reconstruction_plane_evidence import inventory_exclusions, joint_patch_fit

spec = importlib.util.spec_from_file_location("plane_probe", Path(__file__).with_name("reconstruction-geometry-plane-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def inventory(kinds=("glassPartition", "mirror", "window", "door", "basin", "unknown")):
    items, candidates = [], []
    for index, kind in enumerate(kinds):
        bbox = [100 + index * 100, 200, 180 + index * 100, 600]
        items.append({"kind": kind, "bbox_2d": bbox, "view": "direct", "note": "observed"})
        candidates.append({"id": f"item_{index}", "kind": kind, "reflection": "physical", "evidence": ["observed"],
                           "bounds": dict(zip(("left", "top", "right", "bottom"), [v / 1000 for v in bbox]))})
    return {"inputFingerprint": "a" * 64, "input": {"width": 100, "height": 80},
            "pipeline": {"automaticUnderstanding": {"candidates": candidates}, "model": {
                "outputContract": "fixture-inventory-v2", "modelId": "saved-model", "modelRevision": "saved-revision",
                "completion": {"done": True, "doneReason": "stop"}, "rawText": json.dumps({"items": items})}}}


def patches():
    yy, xx = np.mgrid[:40, :40]
    points = np.stack([(xx - 20) / 20, (yy - 20) / 20, np.full(xx.shape, 2)], axis=-1)
    normals = np.zeros_like(points, dtype=float)
    normals[..., 2] = -1
    labels = np.where(xx < 20, 11, 12)
    members = [{"id": f"wall-{i}", "equation": {"normal": [0., 0., -1.], "d": 2.},
                "support": {"pixels": 800}} for i in (1, 2)]
    return members, labels, points, normals


class InventoryEvidenceTests(unittest.TestCase):
    def test_only_structured_optical_opening_or_reflected_evidence_excludes(self):
        data = inventory()
        original = copy.deepcopy(data)
        mask, records, provenance = inventory_exclusions(data, "a" * 64, (100, 80), (100, 80), 0)
        self.assertEqual([r["kind"] for r in records], ["glassPartition", "mirror", "window", "door"])
        self.assertTrue(mask[30, 12])
        self.assertFalse(mask[30, 52])  # A normal basin cannot exclude more wall support here.
        self.assertFalse(mask[30, 62])  # Unknown/free text is not an optical observation.
        self.assertEqual(len(provenance["skipped"]), 2)
        self.assertEqual(data, original)

    def test_reflected_fixture_uses_raw_view_not_a_prose_keyword(self):
        data = inventory(("basin",))
        model = data["pipeline"]["model"]
        raw = json.loads(model["rawText"])
        raw["items"][0]["view"] = "mirror_image"
        model["rawText"] = json.dumps(raw)
        data["pipeline"]["automaticUnderstanding"]["candidates"][0]["reflection"] = "reflected"
        _, records, _ = inventory_exclusions(data, "a" * 64, (100, 80), (100, 80))
        self.assertEqual(records[0]["category"], "reflected-image")

    def test_rejects_another_photo_or_grid_contract(self):
        for fingerprint, image in (("b" * 64, (100, 80)), ("a" * 64, (80, 100))):
            with self.assertRaises(ValueError):
                inventory_exclusions(inventory(), fingerprint, image, (100, 80))

    def test_rejects_corrected_bounds_or_raw_identity_mismatch(self):
        for field, value in (("bounds", {"left": .11, "top": .2, "right": .18, "bottom": .6}),
                             ("kind", "window"), ("reflection", "reflected")):
            data = inventory()
            data["pipeline"]["automaticUnderstanding"]["candidates"][0][field] = value
            with self.assertRaises(ValueError):
                inventory_exclusions(data, "a" * 64, (100, 80), (100, 80))

    def test_rejects_incomplete_raw_response(self):
        data = inventory()
        data["pipeline"]["model"]["completion"]["doneReason"] = "length"
        with self.assertRaises(ValueError):
            inventory_exclusions(data, "a" * 64, (100, 80), (100, 80))

    def test_missing_observation_does_not_remove_pixels(self):
        data = inventory(("glassPartition",))
        data["pipeline"]["automaticUnderstanding"]["candidates"][0]["evidence"] = []
        mask, records, _ = inventory_exclusions(data, "a" * 64, (100, 80), (100, 80))
        self.assertFalse(mask.any())
        self.assertFalse(records)


class PatchConsensusTests(unittest.TestCase):
    def fit(self, data):
        return joint_patch_fit(*data, .01, np.array([0., -1., 0.]), probe.pca_plane, probe.CONFIG)

    def test_same_plane_disjoint_adjacent_support_merges_without_dropping_pixels(self):
        data = patches()
        originals = [x.copy() for x in data[1:]]
        result, check = self.fit(data)
        self.assertEqual(check["status"], "accepted")
        self.assertEqual(len(result["points"]), 1600)
        self.assertEqual(result["fit"]["diagnostics"]["discardedPixels"], 0)
        for now, original in zip(data[1:], originals):
            np.testing.assert_array_equal(now, original)

    def test_parallel_different_depth_is_not_one_wall(self):
        data = patches()
        data[0][1]["equation"]["d"] = 2.5
        self.assertEqual(self.fit(data)[1]["reason"], "different-plane-offsets")

    def test_opposing_normal_is_not_same_boundary(self):
        data = patches()
        data[0][1]["equation"]["normal"] = [0., 0., 1.]
        self.assertEqual(self.fit(data)[1]["reason"], "different-normal-directions")

    def test_disconnected_coplanar_surfaces_remain_distinct(self):
        data = patches()
        data[1][:, 15:25] = 0
        for member in data[0]:
            member["support"]["pixels"] = 600
        self.assertEqual(self.fit(data)[1]["reason"], "disconnected-image-support")

    def test_same_pixels_cannot_count_as_two_independent_patches(self):
        data = patches()
        data[0][1]["id"] = "wall-1"
        self.assertEqual(self.fit(data)[1]["reason"], "shared-pixels-are-not-independent-support")

    def test_joint_consensus_does_not_discard_inconvenient_surface_points(self):
        data = patches()
        data[2][:, 20:, 2] += .03
        data[0][1]["equation"]["d"] = 2.015
        self.assertEqual(self.fit(data)[1]["reason"], "joint-refit-loses-independent-support")

    def test_bad_stored_support_count_rejected(self):
        data = patches()
        data[0][1]["support"]["pixels"] = 801
        self.assertEqual(self.fit(data)[1]["reason"], "missing-or-duplicate-independent-support")


if __name__ == "__main__":
    unittest.main()