"""EPUB/PDF rendering service. Deterministic artifacts + preflight."""
import base64
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent))

from editions import parse_edition  # noqa: E402
from epub_renderer import render_epub  # noqa: E402
from pdf_renderer import render_pdf  # noqa: E402
from preflight import run_preflight  # noqa: E402
from rules import load_ruleset  # noqa: E402

app = FastAPI(title="bookworm-rendering")


class RenderRequest(BaseModel):
    editionConfig: dict
    bookModel: dict
    coverBase64: str | None = None


class RenderResponse(BaseModel):
    format: str
    artifactBase64: str
    sha256: str
    rendererVersion: str


class PreflightRequest(BaseModel):
    editionConfig: dict
    bookModel: dict
    channel: str | None = None
    includeArtifact: bool = True  # render first so artifact-level rules run


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/render", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    try:
        edition = parse_edition(req.editionConfig)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if edition.kind == "ebook":
        cover = base64.b64decode(req.coverBase64) if req.coverBase64 else None
        blob, sha = render_epub(req.bookModel, edition, cover)
        return RenderResponse(format="epub", artifactBase64=base64.b64encode(blob).decode(),
                              sha256=sha, rendererVersion="epub-1.0.0")
    blob, sha = render_pdf(req.bookModel, edition)
    return RenderResponse(format="pdf", artifactBase64=base64.b64encode(blob).decode(),
                          sha256=sha, rendererVersion="pdf-1.0.0")


@app.post("/preflight")
def preflight(req: PreflightRequest) -> dict:
    try:
        edition = parse_edition(req.editionConfig)
        ruleset = load_ruleset(req.channel)
    except (ValueError, KeyError) as e:
        raise HTTPException(422, str(e)) from e
    artifact = None
    if req.includeArtifact and edition.kind == "ebook":
        artifact, _ = render_epub(req.bookModel, edition)
    ctx = {"book": req.bookModel, "edition": req.editionConfig, "artifact": artifact,
           "channel": req.channel, "image_bytes": {}}
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
