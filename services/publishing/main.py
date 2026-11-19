"""Publishing channel adapters service (export-first)."""
import base64
import hashlib
import hmac
import os
import sys
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "rendering"))

from adapters import _assert_saved_epub_metadata, get_adapter, publishing_metadata  # noqa: E402
from editions import parse_edition  # noqa: E402
from epub_renderer import render_epub  # noqa: E402
from manuscript import image_print_placement  # noqa: E402
from preflight import Finding  # noqa: E402
from publication_metadata import effective_publication_metadata  # noqa: E402
from rules import load_ruleset  # noqa: E402

app = FastAPI(title="bookworm-publishing")

class ValidateRequest(BaseModel):
    channel: str
    editionConfig: dict
    bookModel: dict
    artifactsBase64: dict[str, str] | None = None
    assetImagesBase64: dict[str, str] = Field(default_factory=dict)


class PackageRequest(ValidateRequest):
    artifactsBase64: dict[str, str] = Field(default_factory=dict)


def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    configured = (os.getenv("PUBLISHING_SERVICE_TOKEN") or os.getenv("SERVICE_AUTH_TOKEN") or "").strip()
    if not configured:
        raise HTTPException(503, "Publishing service authentication is not configured.")
    if not x_service_token or not hmac.compare_digest(x_service_token.encode("utf-8"), configured.encode("utf-8")):
        raise HTTPException(401, "invalid service token")


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
    adapter, edition = _publication_edition(req)
    if req.artifactsBase64 is not None:
        ctx, artifacts = _saved_artifact_context(req, edition, adapter)
        result = adapter.validate(ctx)
        if edition.kind == "ebook" and result["errors"] == 0:
            try:
                listing = publishing_metadata(req.bookModel, req.editionConfig)
                _assert_saved_epub_metadata(artifacts["book.epub"], listing["metadata"])
            except ValueError as error:
                result["errors"] += 1
                result["findings"].append(Finding(code="SAVED_EPUB_METADATA", message=str(error),
                    location="book.epub/metadata", category="metadata", rule_id="CORE-META-SAVED",
                    rule_version=result["ruleVersion"]).to_dict())
        result["artifactSha256"] = hashlib.sha256(ctx["package_bytes"]).hexdigest()
        if edition.kind == "print":
            cover = artifacts.get("cover.pdf") or artifacts.get("cover.png")
            result["coverSha256"] = hashlib.sha256(cover).hexdigest() if cover else None
        return result

    artifact = None
    if edition.kind == "ebook":
        artifact, _ = render_epub(req.bookModel, edition)
    ctx = {"book": req.bookModel, "edition": req.editionConfig, "artifact": artifact,
           "channel": req.channel, "image_bytes": {}}
    return adapter.validate(ctx)


def _publication_edition(req: ValidateRequest):
    try:
        adapter = get_adapter(req.channel)
        edition = parse_edition(req.editionConfig)
        effective_publication_metadata(req.bookModel.get("metadata", {}),
                                       edition.metadata_overrides if edition.kind == "ebook" else None)
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e)) from e
    return adapter, edition


def _print_proof_images(req: ValidateRequest) -> dict[str, bytes]:
    if not req.assetImagesBase64:
        return {}
    full_bleed = {
        node["assetId"] for chapter in req.bookModel.get("chapters", []) for node in chapter.get("nodes", [])
        if node.get("type") == "image" and image_print_placement(node) == "fullBleed" and isinstance(node.get("assetId"), str)
    }
    if len(req.assetImagesBase64) > 100 or not full_bleed.issuperset(req.assetImagesBase64):
        raise HTTPException(422, "invalid full-bleed illustration map")
    images = {}
    total = 0
    max_image_size = 25 * 1024 * 1024
    for asset_id, encoded in req.assetImagesBase64.items():
        if len(encoded) > ((max_image_size + 2) // 3) * 4:
            raise HTTPException(422, "full-bleed illustration exceeds the supported size")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise HTTPException(422, "full-bleed illustrations must be valid base64") from error
        total += len(data)
        if not data or len(data) > max_image_size or total > 100 * 1024 * 1024:
            raise HTTPException(422, "full-bleed illustrations exceed the supported size")
        images[asset_id] = data
    return images


def _saved_artifact_context(req: ValidateRequest, edition, adapter) -> tuple[dict, dict[str, bytes]]:
    """Use the same bounded artifact intake for preflight and for the ZIP."""
    if edition.kind not in {"ebook", "print"}:
        raise HTTPException(422, "Saved artifacts require an EPUB or print edition")
    expected_format = "epub" if edition.kind == "ebook" else "pdf"
    if expected_format not in adapter.capabilities().formats:
        raise HTTPException(422, f"{req.channel} does not accept {expected_format} editions")
    primary_name = f"book.{expected_format}"
    encoded_artifacts = req.artifactsBase64 or {}
    names = set(encoded_artifacts)
    cover_name = "cover.pdf" if edition.kind == "print" and edition.wrap_cover.enabled else "cover.png"
    if primary_name not in names or not names.issubset({primary_name, cover_name}):
        raise HTTPException(422, f"artifacts must contain {primary_name} and optional {cover_name}")

    artifacts: dict[str, bytes] = {}
    total = 0
    for name in sorted(names):
        encoded = encoded_artifacts[name]
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
        "image_bytes": _print_proof_images(req) if edition.kind == "print" else {},
        "cover_bytes": artifacts.get("cover.png"),
        "cover_pdf_bytes": artifacts.get("cover.pdf"),
    }
    return ctx, artifacts


def build_package(req: PackageRequest) -> dict:
    """Package exact, already-rendered private artifacts supplied by the API."""
    adapter, edition = _publication_edition(req)
    ctx, artifacts = _saved_artifact_context(req, edition, adapter)
    # EPUB-checked channels validate inside build_package against ZIP-bound bytes.
    # Running it here as well doubles the potentially long EPUBCheck process.
    validation = None if req.channel in {"apple", "googleplay"} else adapter.validate(ctx)
    if validation is not None and validation["errors"]:
        raise HTTPException(422, "The saved artifacts no longer pass channel validation. Review findings. Render again before packaging.")
    try:
        packages = adapter.build_package(ctx, artifacts)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if validation is None:
        # A returned package is possible only after its own zero-error
        # validation; its version comes from the same immutable ruleset.
        validation = {"ruleVersion": load_ruleset(req.channel).version, "errors": 0}
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


@app.post("/v1/publishing/jobs", dependencies=[Depends(require_service_token)])
def retired_local_job() -> None:
    """Do not revive the unscoped local-file job cache or silently rerender."""
    raise HTTPException(410, "Local publishing jobs are retired. Use the authenticated Bookworm API durable publishing queue.")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8003)
