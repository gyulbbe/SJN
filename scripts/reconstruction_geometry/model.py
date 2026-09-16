"""Pinned local MoGe-2 loader shared by probe and development runtime."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import threading
import time
import zipfile
ROOT = Path(__file__).resolve().parents[2]

SOURCE_REVISION = "925b8ed835a7a9cdb7578ba15c658a0afc969030"


UTILS_REVISION = "3fab839f0be9931dac7c8488eb0e1600c236e183"


MODEL_REVISION = "26b477f41595707c5db6770294c0d1721e8ed4ed"


MODEL_REPO = "Ruicheng/moge-2-vits-normal"


PINNED_FILES = [
    (f"https://codeload.github.com/microsoft/MoGe/zip/{SOURCE_REVISION}",
     f"MoGe-{SOURCE_REVISION}.zip", "b496132b7e36e95f407df2c6fc3021c84023d2d7d30d8c7c9d0b50f61ad00e1d"),
    (f"https://codeload.github.com/EasternJournalist/utils3d/zip/{UTILS_REVISION}",
     f"utils3d-{UTILS_REVISION}.zip", "ad4dbdf7605c31806194374189051cf4c82a3b6bd186ec2bc9b53c81d301d520"),
    (f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/model.pt?download=true",
     "model.pt", "79a16621928c2bf0ed04659218c55c01075e950507f40bb3332fb4c873d3e1dc"),
    (f"https://huggingface.co/{MODEL_REPO}/raw/{MODEL_REVISION}/README.md",
     "model-README.md", "a0ff9e295aa3b2401702d4bfacb9011f1d3611b94169f9135d5edda92b47279d"),
]


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configure_local_cache(work):
    settings = {
        "HF_HOME": str(work / "cache/hf"),
        "HF_HUB_CACHE": str(work / "cache/hf/hub"),
        "TORCH_HOME": str(work / "cache/torch"),
        "XDG_CACHE_HOME": str(work / "cache/xdg"),
        "MPLCONFIGDIR": str(work / "cache/matplotlib"),
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "XFORMERS_DISABLED": "1",
    }
    for key, value in settings.items():
        os.environ[key] = value
    sys.dont_write_bytecode = True
    return settings


def verify_local_files(work):
    files = []
    for url, name, expected in PINNED_FILES:
        path = work / name
        actual = sha256(path)
        if actual != expected:
            raise ValueError(f"Pinned file checksum mismatch: {name}")
        files.append({"url": url, "path": str(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path), "bytes": path.stat().st_size, "sha256": actual})
        if name.endswith(".zip"):
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    target = (work / entry.filename).resolve()
                    if not target.is_relative_to(work):
                        raise ValueError("Unsafe source archive path")
                    if not entry.is_dir() and hashlib.sha256(archive.read(entry)).hexdigest() != sha256(target):
                        raise ValueError(f"Extracted source differs from pinned archive: {entry.filename}")
    return files


def forbid_network(attempts):
    """Fail closed on Python networking, including DNS and loopback (not an OS firewall)."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    blocked = {"socket.connect", "socket.getaddrinfo", "socket.sendto", "urllib.Request"}

    def audit(event, args):
        if event in blocked:
            attempts.append({"event": event, "argumentTypes": [type(value).__name__ for value in args]})
            raise RuntimeError(f"Offline inference forbids {event}")

    sys.addaudithook(audit)
    import socket
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=0.01)
    except RuntimeError:
        if not attempts:
            raise AssertionError("Offline guard was not exercised")
    else:
        raise AssertionError("Offline guard failed")
    attempts.clear()


class RssSampler:
    """Observed process working-set maximum at 20 ms; not a guaranteed OS high-water mark."""
    def __init__(self, process):
        self.process = process
        self.start_bytes = process.memory_info().rss
        self.peak_bytes = self.start_bytes
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stop_event.wait(0.02):
            self.peak_bytes = max(self.peak_bytes, self.process.memory_info().rss)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.peak_bytes = max(self.peak_bytes, self.process.memory_info().rss)
        self.stop_event.set()
        self.thread.join()

    def report(self):
        return {"startBytes": self.start_bytes, "sampledPeakBytes": self.peak_bytes,
                "endBytes": self.process.memory_info().rss, "sampleIntervalMs": 20}


def import_existing_cv2(site):
    if importlib.util.find_spec("cv2") is not None:
        import cv2
        return cv2
    if site is None or not (site / "cv2/__init__.py").is_file():
        raise RuntimeError("OpenCV is missing; provide --extra-cv2-site for an existing compatible installation. No automatic install.")
    # Remove the external site immediately, so unrelated packages cannot silently shadow this environment.
    sys.path.append(str(site))
    try:
        import cv2
    finally:
        sys.path.remove(str(site))
    return cv2

