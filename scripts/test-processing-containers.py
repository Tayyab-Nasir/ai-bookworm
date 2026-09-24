"""Disposable Docker acceptance. Fixture-only, no mounts/ports/external network."""
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import time
import uuid
import zipfile

TOKEN = "disposable-processing-acceptance-only"
HTTP_DRIVER = """
import base64,json,sys,urllib.request,urllib.error
v=json.load(sys.stdin)
headers={'Content-Type':'application/json'}
if v.get('token') is not None: headers['x-service-token']=v['token']
req=urllib.request.Request('http://127.0.0.1:8000'+v['path'],
    data=None if v['body'] is None else json.dumps(v['body']).encode(),headers=headers)
try:
    res=urllib.request.urlopen(req,timeout=90)
except urllib.error.HTTPError as error:
    res=error
print(json.dumps({'status':res.status,'body':base64.b64encode(res.read()).decode()}))
"""


def docker(*args, data=None, timeout=120):
    result = subprocess.run(["docker", *args], input=data, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Docker command failed: {result.stderr[:2000]}")
    return result.stdout.strip()


def request(container, path, body=None, token=TOKEN):
    result = json.loads(docker("exec", "-i", container, "python", "-c", HTTP_DRIVER,
                              data=json.dumps({"path": path, "body": body, "token": token})))
    return result["status"], base64.b64decode(result["body"])


def run_service(role, configured, action):
    name = f"bookworm-acceptance-{role}-{uuid.uuid4().hex}"
    container = docker("run", "-d", "--name", name, "--network", "none", "--read-only",
                       "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                       "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m", "--memory", "512m", "--pids-limit", "128",
                       "-e", f"{role.upper()}_SERVICE_TOKEN={TOKEN if configured else ''}", f"bookworm-ci-{role}")
    try:
        for _ in range(40):
            try:
                if request(container, "/health")[0] == 200:
                    break
            except (RuntimeError, ValueError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError(f"{role} failed readiness: {docker('logs', container)[:2000]}")
        assert docker("exec", container, "id", "-u") == "65532"
        result = action(container)
        print(f"PASS {role}: {'authenticated processing' if configured else 'missing credentials denied'}", flush=True)
        return result
    finally:
        # Exact ID returned by this run only; no existing containers touched.
        docker("rm", "-f", container)


def check_json(container, path, body):
    assert request(container, path, body, token=None)[0] == 401
    assert request(container, path, body, token="wrong")[0] == 401
    status, raw = request(container, path, body)
    assert status == 200, (path, status, raw[:1000])
    return json.loads(raw)


def main():
    for role, path in (("document", "/parse"), ("rendering", "/render"), ("publishing", "/v1/publishing/package")):
        def denied(container, path=path):
            assert request(container, path, {})[0] == 503
        run_service(role, False, denied)

    def parse(container):
        result = check_json(container, "/parse", {"assetId": "fixture", "format": "txt",
            "contentBase64": base64.b64encode(b"A private fixture manuscript.").decode()})
        assert "A private fixture manuscript." in json.dumps(result)
    run_service("document", True, parse)
    book = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/books/valid_book.json").read_text())
    book["assets"] = []
    for chapter in book["chapters"]:
        chapter["nodes"] = [node for node in chapter["nodes"] if node["type"] != "image"]

    def render(container):
        result = check_json(container, "/render", {"bookModel": book, "editionConfig": {"kind": "ebook"}})
        artifact = base64.b64decode(result["artifactBase64"])
        assert hashlib.sha256(artifact).hexdigest() == result["sha256"]
        with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
            assert archive.read("mimetype") == b"application/epub+zip"
        fixed = check_json(container, "/render", {"bookModel": book, "editionConfig": {"kind": "ebook", "flow": "fixed"}})
        assert base64.b64decode(fixed["artifactBase64"]).startswith(b"PK")
        check_json(container, "/preflight", {"bookModel": book, "editionConfig": {"kind": "ebook"}, "channel": "kdp"})
        artwork = docker("exec", container, "python", "-c",
            "import base64,io; from PIL import Image; "
            "image=Image.new('RGB',(1200,1800),'#43536a'); data=io.BytesIO(); "
            "image.save(data,'PNG'); print(base64.b64encode(data.getvalue()).decode())")
        google_edition = {"kind": "ebook", "cover": {"asset_id": "44444444-4444-4444-8444-444444444444"}}
        google_request = {"bookModel": book, "editionConfig": google_edition, "coverBase64": artwork}
        google = check_json(container, "/render", google_request)
        google_epub = base64.b64decode(google["artifactBase64"])
        assert hashlib.sha256(google_epub).hexdigest() == google["sha256"]
        preflight = check_json(container, "/preflight", {**google_request, "channel": "googleplay"})
        assert preflight["errors"] == 0, preflight["findings"]
        assert preflight["ruleVersion"] == "core-1.0.8+google-play-1.1.0"
        mp3 = docker("exec", container, "python", "-c",
            "import base64,subprocess; from audio_assembly import ffmpeg_executable; "
            "r=subprocess.run([ffmpeg_executable(),'-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',"
            "'-ar','44100','-ac','1','-b:a','192k','-f','mp3','pipe:1'],capture_output=True,check=True,timeout=15); "
            "print(base64.b64encode(r.stdout).decode())")
        status, audio = request(container, "/audio/assemble", {"segmentsBase64": [mp3]})
        assert status == 200, (status, audio[:1000])
        assert len(audio) > 1000
        return result["artifactBase64"], google["artifactBase64"], google_edition
    rendered = run_service("rendering", True, render)

    def package(container):
        result = check_json(container, "/v1/publishing/package", {"bookModel": book, "editionConfig": {"kind": "ebook"},
            "channel": "kdp", "artifactsBase64": {"book.epub": rendered[0]}})
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["packages"][0]["dataBase64"]))) as archive:
            assert archive.read("book.epub") == base64.b64decode(rendered[0])
            assert json.loads(archive.read("metadata.json"))["metadata"]["title"] == book["metadata"]["title"]
        google = check_json(container, "/v1/publishing/package", {"bookModel": book,
            "editionConfig": rendered[2], "channel": "googleplay",
            "artifactsBase64": {"book.epub": rendered[1]}})
        assert google["errors"] == 0
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(google["packages"][0]["dataBase64"]))) as archive:
            assert archive.read("book.epub") == base64.b64decode(rendered[1])
        assert request(container, "/v1/publishing/jobs", {})[0] == 410
    run_service("publishing", True, package)


if __name__ == "__main__":
    main()
