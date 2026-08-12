"""Publishing channel adapters service (export-first)."""
import base64
import hashlib
import json
import sys
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "rendering"))

from adapters import get_adapter  # noqa: E402
from editions import parse_edition  # noqa: E402
from epub_renderer import render_epub  # noqa: E402
from pdf_renderer import render_pdf  # noqa: E402

app = FastAPI(title="bookworm-publishing")

_JOBS_DIR = Path(__file__).resolve().parent / ".jobs"  # ponytail: local fs store; DB in Step 14 admin
_JOBS_DIR.mkdir(exist_ok=True)


class ValidateRequest(BaseModel):
    channel: str
    editionConfig: dict
    bookModel: dict


class JobRequest(BaseModel):
    channel: str
    editionConfig: dict
    bookModel: dict
    idempotencyKey: str


def _job_path(key: str) -> Path:
    # reject (not strip): stripping silently aliases distinct keys (e.g. "../../evil" -> "evil")
    if not key or not all(c.isalnum() or c in "-_" for c in key):
        raise HTTPException(422, "idempotencyKey must be alphanumeric/-/_, non-empty")
    return _JOBS_DIR / f"{key}.json"


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/v1/publishing/channels")
def channels() -> dict:
    from adapters import _ADAPTERS
    return {name: {
        "formats": list(a.capabilities().formats),
        "canSubmit": a.capabilities().can_submit,
        "requiredMetadata": list(a.capabilities().required_metadata),
    } for name, a in sorted(_ADAPTERS.items())}


@app.post("/v1/publishing/validate")
def validate(req: ValidateRequest) -> dict:
    try:
        adapter = get_adapter(req.channel)
        edition = parse_edition(req.editionConfig)
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e)) from e
    artifact = None
    if edition.kind == "ebook":
        artifact, _ = render_epub(req.bookModel, edition)
    ctx = {"book": req.bookModel, "edition": req.editionConfig, "artifact": artifact,
           "channel": req.channel, "image_bytes": {}}
    return adapter.validate(ctx)


@app.post("/v1/publishing/jobs", status_code=201)
def create_job(req: JobRequest) -> dict:
    """Export-package job. Idempotent on idempotencyKey: replay returns stored result."""
    try:
        adapter = get_adapter(req.channel)
        edition = parse_edition(req.editionConfig)
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e)) from e

    path = _job_path(req.idempotencyKey)
    if path.exists():
        stored = json.loads(path.read_text())
        stored["replayed"] = True
        return stored

    if edition.kind == "ebook":
        blob, _ = render_epub(req.bookModel, edition)
        artifacts = {"book.epub": blob}
    else:
        blob, _ = render_pdf(req.bookModel, edition)
        artifacts = {"book.pdf": blob}

    ctx = {"book": req.bookModel, "edition": req.editionConfig,
           "artifact": artifacts.get("book.epub"), "channel": req.channel, "image_bytes": {}}
    packages = adapter.build_package(ctx, artifacts)
    result = {
        "jobId": hashlib.sha256(req.idempotencyKey.encode()).hexdigest()[:16],
        "channel": req.channel,
        "status": "exported",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "packages": [{"path": p.path, "sha256": p.sha256,
                      "dataBase64": base64.b64encode(p.data).decode()} for p in packages],
        "replayed": False,
    }
    path.write_text(json.dumps(result))
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8003)
