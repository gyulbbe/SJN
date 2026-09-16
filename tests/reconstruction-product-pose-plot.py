"""Scientific diagnostic of real sampled surfaces and the current rejected standard-model box."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "test-results/reconstruction-product-pose-20260913"
PHOTOS = ROOT / "test-results/user-reconstruction-improvement-20260913/inputs"


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
    plots = DATA / "plots"
    plots.mkdir(parents=True, exist_ok=True)
    outputs = []
    for result_path in sorted((DATA / "results").glob("user-*.json")):
        report = load(result_path)
        source = load(DATA / "inputs" / (report["id"] + ".json"))
        for candidate in report["candidates"]:
            if "result" not in candidate:
                continue
            observed = next(c for c in source["candidates"] if c["candidateId"] == candidate["candidateId"])
            samples = observed["samples"]
            points = np.array([s["pointWorldMm"] for s in samples])
            labels = np.array([s["semanticLabel"] for s in samples])
            # Downsample only the displayed points. The calculation uses all retained samples.
            selected = np.arange(0, len(points), max(1, len(points) // 5000))
            displayed = points[selected]
            colors = np.where(labels[selected] == 11, "#078e9c", "#ed8500")
            camera = source["camera"]
            k = source["observation"]["intrinsics"]
            image = source["observation"]["image"]

            def project(world):
                cam = (np.asarray(world) - camera["positionMm"]) @ rotation(camera["quaternion"])
                cv = cam * [1, -1, -1]
                return np.c_[
                    (k["fx"] * cv[:, 0] / cv[:, 2] + k["cx"]) * image["width"],
                    (k["fy"] * cv[:, 1] / cv[:, 2] + k["cy"]) * image["height"],
                ]

            fig, axes = plt.subplots(1, 3, figsize=(16, 6.5))
            photo = Image.open(PHOTOS / (report["id"] + ".jpg"))
            for ax in (axes[0], axes[2]):
                ax.imshow(photo)
                ax.set_xlim(0, image["width"])
                ax.set_ylim(image["height"], 0)
                ax.axis("off")
            pixels = project(displayed)
            axes[0].scatter(pixels[:, 0], pixels[:, 1], c=colors, s=0.7, alpha=0.55, linewidths=0)
            axes[0].set_title("Actual retained surfaces\nTeal: cabinet / orange: sink")
            axes[1].scatter(displayed[:, 0], displayed[:, 2], c=colors, s=1, alpha=0.4, linewidths=0)
            room = source["room"]
            axes[1].plot([-room["widthMm"]/2, room["widthMm"]/2, room["widthMm"]/2, -room["widthMm"]/2, -room["widthMm"]/2],
                         [0, 0, room["depthMm"], room["depthMm"], 0], color="#555", linewidth=1)
            axes[1].set_aspect("equal")
            axes[1].invert_yaxis()
            axes[1].set_xlabel("Model-world X (mm, estimated)")
            axes[1].set_ylabel("Model-world Z (mm, estimated)")
            axes[1].set_title("Observed points and room boundary\nDashed red: rejected default footprint")
            check = candidate.get("currentModelCheck") or {}
            plan = check.get("proposedPlacement")
            if plan and plan["face"] == "floor":
                angle = np.deg2rad(plan.get("yawDegrees", 0))
                ry = np.array([[np.cos(angle), 0, np.sin(angle)], [0, 1, 0], [-np.sin(angle), 0, np.cos(angle)]])
                center = np.array([(plan["u"]-0.5)*room["widthMm"], plan["baseHeightMm"], plan["v"]*room["depthMm"]])
                vertices = np.array([[x, y, z] for y in [0, plan["heightMm"]]
                                     for x, z in [(-plan["widthMm"]/2, -plan["depthMm"]/2), (plan["widthMm"]/2, -plan["depthMm"]/2),
                                                  (plan["widthMm"]/2, plan["depthMm"]/2), (-plan["widthMm"]/2, plan["depthMm"]/2)]]) @ ry.T + center
                projected = project(vertices)
                for start, end in [(0,1),(1,2),(2,3),(3,0),(4,5),(5,6),(6,7),(7,4),(0,4),(1,5),(2,6),(3,7)]:
                    axes[2].plot(projected[[start,end],0], projected[[start,end],1], "--", color="#da3548", linewidth=1.6)
                ring = vertices[[0,1,2,3,0]]
                axes[1].plot(ring[:,0], ring[:,2], "--", color="#da3548", linewidth=1.8)
                axes[2].set_title(f"Current rejected box reprojection\n{plan['widthMm']} x {plan['depthMm']} x {plan['heightMm']} mm; yaw {plan.get('yawDegrees', 0)}")
            pose = candidate["result"]
            axes_info = pose.get("axes")
            if axes_info:
                origin = np.median(points[labels == 11], axis=0)
                for axis in axes_info["horizontalWorld"]:
                    axes[1].arrow(origin[0], origin[2], axis[0]*300, axis[2]*300, color="#6633aa", width=8, head_width=50, length_includes_head=True)
            reasons = ", ".join(r["code"] for r in pose["reasons"])
            fig.suptitle(f"{report['id']} / {candidate['candidateId']} — {pose['status']}\n{reasons}", fontsize=12)
            fig.text(0.02, 0.025, "Frozen real model observations. Points/axes are not measured dimensions or verified object bounds. No pose applied; no new AI.", fontsize=9)
            fig.tight_layout(rect=[0, .12, 1, .90])
            output = plots / f"{report['id']}-{candidate['candidateId']}.png"
            fig.savefig(output, dpi=150)
            plt.close(fig)
            outputs.append(str(output.relative_to(ROOT)))
    (plots / "manifest.json").write_text(json.dumps(outputs, indent=2), encoding="utf-8")
    print(json.dumps(outputs))


if __name__ == "__main__":
    main()
