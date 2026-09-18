"""EPUB/PDF rendering service. Deterministic artifacts + preflight."""
import base64
import hmac
import os
import sys
from math import ceil
from io import BytesIO
from pathlib import Path
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Response
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
from print_fonts import print_font_issues  # noqa: E402
from wrap_cover import VERSION as WRAP_VERSION, render_wrap_cover  # noqa: E402
from preflight import Finding  # noqa: E402
from audio_assembly import assemble_audio  # noqa: E402

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
    coverFormat: str | None = None


class PreflightRequest(BaseModel):
    editionConfig: dict
    bookModel: dict
    channel: str | None = None
    includeArtifact: bool = True  # render first so artifact-level rules run
    coverBase64: str | None = None
    assetImagesBase64: dict[str, str] = Field(default_factory=dict)


class AudioAssemblyRequest(BaseModel):
    segmentsBase64: list[str] = Field(min_length=1, max_length=250)


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


@app.post("/audio/assemble", dependencies=[Depends(require_service_token)])
def assemble_chapter(req: AudioAssemblyRequest):
    if sum(len(value) for value in req.segmentsBase64) > 140 * 1024 * 1024:
        raise HTTPException(422, "chapter audio exceeds input limit")
    try:
        segments = [base64.b64decode(value, validate=True) for value in req.segmentsBase64]
        audio, checksum = assemble_audio(segments)
    except ValueError as error:
        raise HTTPException(422, "invalid or oversized chapter audio") from error
    except RuntimeError as error:
        raise HTTPException(503, "audio assembly is unavailable or busy") from error
    return Response(audio, media_type="audio/mpeg", headers={"x-artifact-sha256": checksum, "cache-control": "no-store"})


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
    max_width = edition.image_policy.max_width_px if edition.kind == "ebook" else None
    print_target = None if edition.kind == "ebook" else (
        ceil((edition.trim_in[0] + edition.bleed_in + (edition.bleed_in if edition.bleed_edges == "all" else 0)) * 300),
        ceil((edition.trim_in[1] + 2 * edition.bleed_in) * 300),
    )
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
                if max_width is not None and image.width > max_width:
                    height = max(1, round(image.height * max_width / image.width))
                    image = image.resize((max_width, height), Image.Resampling.LANCZOS)
                elif print_target and image.width > print_target[0] and image.height > print_target[1]:
                    scale = max(print_target[0] / image.width, print_target[1] / image.height)
                    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
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
    font_issues = print_font_issues(req.bookModel, edition.model_dump())
    if font_issues:
        raise HTTPException(422, font_issues[0]["message"])
    cover, cover_sha = _composed_cover(req, edition)
    illustrations = _illustrations(req, edition)
    cover_output = base64.b64encode(cover).decode() if cover else None
    if edition.kind == "ebook":
        blob, sha = render_epub(req.bookModel, edition, cover, illustrations if edition.image_policy.embed else {})
        return RenderResponse(format="epub", artifactBase64=base64.b64encode(blob).decode(),
                              sha256=sha, rendererVersion=EPUB_RENDERER_VERSION,
                              coverArtifactBase64=cover_output, coverSha256=cover_sha,
                              coverRendererVersion=COVER_RENDERER_VERSION if cover else None)
    try:
        blob, sha = render_pdf(req.bookModel, edition, illustrations)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if edition.wrap_cover.enabled:
        try:
            cover, cover_sha = render_wrap_cover(cover, blob, edition)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        cover_output = base64.b64encode(cover).decode()
    return RenderResponse(format="pdf", artifactBase64=base64.b64encode(blob).decode(),
                          sha256=sha, rendererVersion=PDF_RENDERER_VERSION,
                          coverArtifactBase64=cover_output, coverSha256=cover_sha,
                          coverRendererVersion=(WRAP_VERSION if edition.wrap_cover.enabled else COVER_RENDERER_VERSION) if cover else None,
                          coverFormat=("pdf" if edition.wrap_cover.enabled else "png") if cover else None)


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
    if rtl_render_blocked or print_font_issues(req.bookModel, edition.model_dump()):
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
    initial_ctx = {"book": req.bookModel, "edition": req.editionConfig,
                   "artifact": None, "package_bytes": None, "channel": req.channel,
                   "image_bytes": illustrations, "cover_bytes": cover}
    initial_findings = run_preflight(initial_ctx, ruleset)
    if any(f.code.startswith("PRINT_FULL_BLEED_") or f.rule_id == "CORE-LAYOUT-001" for f in initial_findings):
        return {
            "ruleVersion": ruleset.version,
            "channel": req.channel,
            "errors": sum(1 for f in initial_findings if f.severity == "error"),
            "warnings": sum(1 for f in initial_findings if f.severity == "warning"),
            "findings": [f.to_dict() for f in initial_findings],
        }
    artifact = None
    cover_pdf = None
    wrap_error = None
    if req.includeArtifact:
        try:
            artifact, _ = render_epub(req.bookModel, edition, cover, illustrations if edition.image_policy.embed else {}) if edition.kind == "ebook" else render_pdf(req.bookModel, edition, illustrations)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        if edition.kind == "print" and edition.wrap_cover.enabled:
            try:
                cover_pdf, _ = render_wrap_cover(cover, artifact, edition)
            except ValueError as error:
                wrap_error = str(error)
    ctx = {"book": req.bookModel, "edition": req.editionConfig,
           "artifact": artifact if edition.kind == "ebook" else None,
           "package_bytes": artifact,
           "channel": req.channel, "image_bytes": illustrations, "cover_bytes": cover,
           "cover_pdf_bytes": cover_pdf}
    findings = run_preflight(ctx, ruleset)
    if wrap_error:
        findings.append(Finding(code="PRINT_WRAP_LAYOUT", message=wrap_error,
                                location="edition.wrap_cover", severity="error", category="channel",
                                rule_id="CORE-COVER-002", rule_version=ruleset.version))
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
