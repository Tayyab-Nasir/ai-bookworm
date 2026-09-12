"""Publishing channel adapters service (export-first)."""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

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


class PackageRequest(BaseModel):
    channel: str
    editionConfig: dict
    bookModel: dict
    artifactsBase64: dict[str, str] = Field(default_factory=dict)


def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    configured = os.getenv("PUBLISHING_SERVICE_TOKEN") or os.getenv("SERVICE_AUTH_TOKEN")
    if configured and (not x_service_token or not hmac.compare_digest(x_service_token, configured)):
        raise HTTPException(401, "invalid service token")


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
        "canCheckStatus": a.capabilities().can_check_status,
        "requiredMetadata": list(a.capabilities().required_metadata),
    } for name, a in sorted(_ADAPTERS.items())}


@app.post("/v1/publishing/validate", dependencies=[Depends(require_service_token)])
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


def build_package(req: PackageRequest) -> dict:
    """Package exact, already-rendered private artifacts supplied by the API.

    The API authorizes the book and verifies the source render/preflight jobs.
    This service still constrains names, formats, signatures, and package size,
    then reruns the versioned rules before producing a deterministic ZIP.
    """
    try:
        adapter = get_adapter(req.channel)
        edition = parse_edition(req.editionConfig)
    except (KeyError, ValueError) as error:
        raise HTTPException(422, str(error)) from error

    expected_format = "epub" if edition.kind == "ebook" else "pdf"
    if expected_format not in adapter.capabilities().formats:
        raise HTTPException(422, f"{req.channel} does not accept {expected_format} editions")
    primary_name = f"book.{expected_format}"
    names = set(req.artifactsBase64)
    if primary_name not in names or not names.issubset({primary_name, "cover.png"}):
        raise HTTPException(422, f"artifacts must contain {primary_name} and optional cover.png")

    artifacts: dict[str, bytes] = {}
    total = 0
    for name in sorted(names):
        encoded = req.artifactsBase64[name]
        if not encoded or len(encoded) > 280_000_000:
            raise HTTPException(422, "an encoded publishing artifact exceeds the supported size")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise HTTPException(422, "publishing artifacts must be valid base64") from error
        total += len(data)
        if not data or total > 175 * 1024 * 1024:
            raise HTTPException(422, "publishing artifacts exceed the 175 MB package limit")
        signature = b"PK" if name.endswith(".epub") else b"%PDF-" if name.endswith(".pdf") else b"\x89PNG"
        if not data.startswith(signature):
            raise HTTPException(422, f"{name} has an invalid file signature")
        artifacts[name] = data

    primary = artifacts[primary_name]
    ctx = {
        "book": req.bookModel,
        "edition": req.editionConfig,
        # EPUB structure rules only inspect EPUB bytes. Channel package-size
        # rules use package_bytes for either EPUB or PDF.
        "artifact": primary if expected_format == "epub" else None,
        "package_bytes": primary,
        "channel": req.channel,
        "image_bytes": {},
        "cover_bytes": artifacts.get("cover.png"),
    }
    validation = adapter.validate(ctx)
    if validation["errors"]:
        raise HTTPException(422, "the saved artifacts no longer pass channel validation")
    try:
        packages = adapter.build_package(ctx, artifacts)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {
        "channel": req.channel,
        "ruleVersion": validation["ruleVersion"],
        "errors": validation["errors"],
        "packages": [{
            "path": package.path,
            "sha256": package.sha256,
            "dataBase64": base64.b64encode(package.data).decode(),
        } for package in packages],
    }


@app.post("/v1/publishing/package", dependencies=[Depends(require_service_token)])
def create_package(req: PackageRequest) -> dict:
    return build_package(req)


@app.post("/v1/publishing/jobs", status_code=201, dependencies=[Depends(require_service_token)])
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
