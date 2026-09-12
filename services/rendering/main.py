"""EPUB/PDF rendering service. Deterministic artifacts + preflight."""
import base64
import hmac
import os
import sys
from io import BytesIO
from pathlib import Path
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent))

from editions import (  # noqa: E402
    cover_requires_unsupported_rtl_typography,
    parse_edition,
    print_requires_unsupported_rtl_typography,
)
from cover_renderer import COVER_RENDERER_VERSION, compose_front_cover  # noqa: E402
from epub_renderer import render_epub, RENDERER_VERSION as EPUB_RENDERER_VERSION  # noqa: E402
from pdf_renderer import render_pdf, RENDERER_VERSION as PDF_RENDERER_VERSION  # noqa: E402
from preflight import run_preflight  # noqa: E402
from rules import load_ruleset  # noqa: E402

app = FastAPI(title="bookworm-rendering")


class RenderRequest(BaseModel):
    editionConfig: dict
    bookModel: dict
    coverBase64: str | None = None
    assetImagesBase64: dict[str, str] = Field(default_factory=dict)


class RenderResponse(BaseModel):
    format: str
    artifactBase64: str
    sha256: str
    rendererVersion: str
    coverArtifactBase64: str | None = None
    coverSha256: str | None = None
    coverRendererVersion: str | None = None


class PreflightRequest(BaseModel):
    editionConfig: dict
    bookModel: dict
    channel: str | None = None
    includeArtifact: bool = True  # render first so artifact-level rules run
    coverBase64: str | None = None
    assetImagesBase64: dict[str, str] = Field(default_factory=dict)


def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    configured = os.getenv("RENDERING_SERVICE_TOKEN") or os.getenv("SERVICE_AUTH_TOKEN")
    if configured and (not x_service_token or not hmac.compare_digest(x_service_token, configured)):
        raise HTTPException(401, "invalid service token")


def _cover_bytes(value: str | None) -> bytes | None:
    if not value:
        return None
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, "coverBase64 is not valid base64") from error
    if not data or len(data) > 25 * 1024 * 1024:
        raise HTTPException(422, "cover image must be between 1 byte and 25 MB")
    return data


def _composed_cover(req, edition) -> tuple[bytes | None, str | None]:
    source = _cover_bytes(req.coverBase64)
    if edition.cover.asset_id and source is None:
        raise HTTPException(422, "the configured cover asset bytes are required")
    if source is not None and not edition.cover.asset_id:
        raise HTTPException(422, "cover bytes require editionConfig.cover.asset_id")
    if source is None:
        return None, None
    try:
        UUID(edition.cover.asset_id)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, "cover asset id must be a UUID") from error
    try:
        return compose_front_cover(source, req.bookModel, edition)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


def _illustrations(req, edition) -> dict[str, bytes]:
    if len(req.assetImagesBase64) > 100:
        raise HTTPException(422, "at most 100 illustration assets may be rendered at once")
    images: dict[str, bytes] = {}
    total = 0
    max_width = edition.image_policy.max_width_px if edition.kind == "ebook" else 2400
    for asset_id, encoded in sorted(req.assetImagesBase64.items()):
        try:
            UUID(asset_id)
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise HTTPException(422, "illustration map contains invalid data") from error
        total += len(raw)
        if not raw or len(raw) > 25 * 1024 * 1024 or total > 100 * 1024 * 1024:
            raise HTTPException(422, "illustration assets exceed rendering limits")
        try:
            with Image.open(BytesIO(raw)) as source:
                source.load()
                image = source.convert("RGB")
                if image.width > max_width:
                    height = max(1, round(image.height * max_width / image.width))
                    image = image.resize((max_width, height), Image.Resampling.LANCZOS)
                output = BytesIO()
                image.save(output, "PNG", optimize=False, compress_level=9)
                images[asset_id] = output.getvalue()
        except (UnidentifiedImageError, OSError, ValueError) as error:
            raise HTTPException(422, f"illustration {asset_id} is not a supported image") from error
    return images


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/render", response_model=RenderResponse, dependencies=[Depends(require_service_token)])
def render(req: RenderRequest) -> RenderResponse:
    try:
        edition = parse_edition(req.editionConfig)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    metadata = req.bookModel.get("metadata") or {}
    if edition.kind == "print" and print_requires_unsupported_rtl_typography(edition, metadata):
        raise HTTPException(422, "RTL print PDF requires an embedded shaping-capable font; the base-font renderer cannot produce it safely")
    if cover_requires_unsupported_rtl_typography(edition, metadata):
        raise HTTPException(422, "RTL cover text requires an embedded shaping-capable font; the base-font cover renderer cannot produce it safely")
    cover, cover_sha = _composed_cover(req, edition)
    illustrations = _illustrations(req, edition)
    cover_output = base64.b64encode(cover).decode() if cover else None
    if edition.kind == "ebook":
        blob, sha = render_epub(req.bookModel, edition, cover, illustrations if edition.image_policy.embed else {})
        return RenderResponse(format="epub", artifactBase64=base64.b64encode(blob).decode(),
                              sha256=sha, rendererVersion=EPUB_RENDERER_VERSION,
                              coverArtifactBase64=cover_output, coverSha256=cover_sha,
                              coverRendererVersion=COVER_RENDERER_VERSION if cover else None)
    blob, sha = render_pdf(req.bookModel, edition, illustrations)
    return RenderResponse(format="pdf", artifactBase64=base64.b64encode(blob).decode(),
                          sha256=sha, rendererVersion=PDF_RENDERER_VERSION,
                          coverArtifactBase64=cover_output, coverSha256=cover_sha,
                          coverRendererVersion=COVER_RENDERER_VERSION if cover else None)


@app.post("/preflight", dependencies=[Depends(require_service_token)])
def preflight(req: PreflightRequest) -> dict:
    try:
        edition = parse_edition(req.editionConfig)
        ruleset = load_ruleset(req.channel)
    except (ValueError, KeyError) as e:
        raise HTTPException(422, str(e)) from e
    metadata = req.bookModel.get("metadata") or {}
    rtl_render_blocked = (
        (edition.kind == "print" and print_requires_unsupported_rtl_typography(edition, metadata))
        or cover_requires_unsupported_rtl_typography(edition, metadata)
    )
    # Return actionable findings before a known-unsupported renderer can emit an
    # unreadable PDF or raster cover. Supplied base64 remains validated here.
    if rtl_render_blocked:
        ctx = {"book": req.bookModel, "edition": req.editionConfig,
               "artifact": None, "package_bytes": None, "channel": req.channel,
               "image_bytes": {}, "cover_bytes": _cover_bytes(req.coverBase64)}
        findings = run_preflight(ctx, ruleset)
        return {
            "ruleVersion": ruleset.version,
            "channel": req.channel,
            "errors": sum(1 for f in findings if f.severity == "error"),
            "warnings": sum(1 for f in findings if f.severity == "warning"),
            "findings": [f.to_dict() for f in findings],
        }
    cover, _ = _composed_cover(req, edition)
    illustrations = _illustrations(req, edition)
    artifact = None
    if req.includeArtifact:
        artifact, _ = render_epub(req.bookModel, edition, cover, illustrations if edition.image_policy.embed else {}) if edition.kind == "ebook" else render_pdf(req.bookModel, edition, illustrations)
    ctx = {"book": req.bookModel, "edition": req.editionConfig,
           "artifact": artifact if edition.kind == "ebook" else None,
           "package_bytes": artifact,
           "channel": req.channel, "image_bytes": illustrations, "cover_bytes": cover}
    findings = run_preflight(ctx, ruleset)
    return {
        "ruleVersion": ruleset.version,
        "channel": req.channel,
        "errors": sum(1 for f in findings if f.severity == "error"),
        "warnings": sum(1 for f in findings if f.severity == "warning"),
        "findings": [f.to_dict() for f in findings],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8002)
