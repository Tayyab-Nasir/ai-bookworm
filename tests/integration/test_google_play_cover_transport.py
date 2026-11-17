"""Synthetic worker-to-Pillow integration; no hosted services or real files."""
import os
import importlib.util
from pathlib import Path
import socket
import subprocess
import threading
import time

from PIL import Image
import uvicorn


def test_google_play_worker_inspects_real_cover_before_archive(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "services" / "rendering"))
    spec = importlib.util.spec_from_file_location("bookworm_cover_integration", root / "services" / "rendering" / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    for kind, image_format in (("png", "PNG"), ("jpeg", "JPEG")):
        valid = tmp_path / f"valid.{kind}"
        Image.new("RGB", (1024, 1024), "navy").save(valid, format=image_format)
        content = valid.read_bytes()
        if kind == "png":
            truncated = content[:24]  # Header-only PNG passes the cheap size probe.
        else:
            frame = content.find(b"\xff\xc0")
            assert frame >= 0
            length = int.from_bytes(content[frame + 2:frame + 4], "big")
            truncated = content[:frame + 2 + length]  # No compressed image data or end marker.
        (tmp_path / f"truncated.{kind}").write_bytes(truncated)

    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "synthetic-cover-token")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(module.app, host="127.0.0.1", port=port, log_level="error", lifespan="off"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 20
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert server.started and thread.is_alive(), "isolated renderer did not start"
        allowed = {"PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA",
                   "APPDATA", "PATHEXT", "COMSPEC", "PROGRAMFILES", "PROGRAMDATA"}
        env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        env.update({"RENDERING_SERVICE_URL": f"http://127.0.0.1:{port}", "RENDERING_SERVICE_TOKEN": "synthetic-cover-token",
                    "BOOKWORM_COVER_FIXTURES": str(tmp_path)})
        result = subprocess.run(["node", "--import", "tsx", "--test", "tests/integration/google-play-cover-worker.mjs"],
                                cwd=root, env=env, text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=90)
        assert result.returncode == 0, f"synthetic worker integration failed:\n{result.stdout}\n{result.stderr}"
        for kind in ("png", "jpeg"):
            for case in ("valid", "malformed", "hash-mismatch", "receipt-mismatch"):
                assert f"{kind}: {case} cover uses real decoding before upload" in result.stdout
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
    assert not thread.is_alive(), "isolated renderer did not stop"
