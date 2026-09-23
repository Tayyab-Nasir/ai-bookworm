"""P0 critical journey, service-level E2E (PRD section 28 / Step 15).

Drives all four FastAPI services via TestClient (in-process, no ports):
create book payload -> document parse (import) -> AI job (mock provider) ->
apply suggestion -> render EPUB -> deterministic preflight -> deterministic
exact-artifact package. Durable job idempotency is tested in API/SQL suites.
The artifact matrix carries parsed text into real EPUB/PDF bytes
and checks the exact bytes inside retailer ZIPs. AI operation application is
simulated here; database persistence, live providers and retailer submission
are not covered by this in-process suite.

Run: pytest tests/e2e -q
"""
from __future__ import annotations

import base64
import hashlib
import importlib
import json
import os
import sys
import zipfile
import shutil
from io import BytesIO
from pathlib import Path

import pytest

from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]

# Each service uses flat imports (from agents..., from parsers...); its dir
# must precede shadowed module names (main, rules). Order is collision-safe:
# ai (agents/gateway/prompts/tools) -> publishing (adapters; its main inserts
# rendering before itself) -> rendering (editions/*_renderer/preflight/rules)
# -> document (parsers).
for rel in ("services/ai", "services/publishing", "services/rendering", "services/document"):
    p = str(REPO / rel)
    if p not in sys.path:
        sys.path.insert(0, p)

_apps: dict = {}


def _client(name: str) -> TestClient:
    if not _apps:
        for n in ("ai", "document", "rendering", "publishing"):
            sys.modules.pop("main", None)  # `main` collides across services; alias each
            sys.path.insert(0, str(REPO / "services" / n))  # ensure THIS service's main wins
            mod = importlib.import_module("main")
            sys.path.pop(0)
            sys.modules[f"{n}_main"] = sys.modules.pop("main")
            _apps[n] = mod.app
    if name == "ai":
        # Internal AI endpoints fail closed unless their private service token
        # is configured. Keep E2E provider-free with the deterministic mock.
        os.environ.setdefault("AI_SERVICE_TOKEN", "e2e-private-service-token")
        os.environ.setdefault("DEFAULT_AI_PROVIDER", "mock")
        return TestClient(_apps[name], headers={"x-service-token": os.environ["AI_SERVICE_TOKEN"]})
    if name in ("publishing", "rendering"):
        token_name = f"{name.upper()}_SERVICE_TOKEN"
        os.environ.setdefault(token_name, f"e2e-{name}-token")
        return TestClient(_apps[name], headers={"x-service-token": os.environ[token_name]})
    return TestClient(_apps[name])


WORKSPACE_ID = "11111111-1111-1111-1111-111111111111"
BOOK_ID = "22222222-2222-2222-2222-222222222222"
CHAPTER_ID = "33333333-3333-3333-3333-333333333333"

# Manuscript with one doubled word the mock provider "fixes".
TEXT = "The the night was quiet. Mara counted her coins twice."

BOOK_MODEL = {
    "schemaVersion": "1.0",
    "bookId": BOOK_ID,
    "metadata": {"title": "Critical Journey", "author": "E2E Author", "language": "en",
                 "description": "E2E fixture book."},
    "styleGuide": {"spellingVariant": "en-US"},
    "bookBible": {"entities": []},
    "chapters": [{
        "id": CHAPTER_ID, "order": 0, "title": "Chapter 1",
        "nodes": [{"id": "n1", "type": "paragraph", "text": TEXT}],
    }],
    "assets": [],
}

EDITION = {"kind": "ebook", "flow": "reflowable", "navigation": "toc"}


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="native Poppler required")
@pytest.mark.parametrize("channel", ["kdp", "apple", "barnesnoble"])
def test_fixed_epub_survives_real_render_preflight_and_package(monkeypatch, channel):
    for name in ("RENDERING_SERVICE_TOKEN", "PUBLISHING_SERVICE_TOKEN"):
        monkeypatch.setenv(name, "fixed-journey-token")
    headers = {"x-service-token": "fixed-journey-token"}
    model = json.loads(json.dumps(BOOK_MODEL))
    model["metadata"].update(description="A collection of letters and memories from a quiet coastal harbor.",
                             categories=["FICTION / General"])
    edition = {"kind": "ebook", "flow": "fixed", "include_title_page": True, "navigation": "toc+landmarks"}
    payload = {"bookModel": model, "editionConfig": edition}
    rendered = _client("rendering").post("/render", headers=headers, json=payload)
    assert rendered.status_code == 200, rendered.text
    artifact = rendered.json()["artifactBase64"]
    preflight = _client("rendering").post("/preflight", headers=headers, json={**payload, "channel": channel})
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["errors"] == 0, preflight.json()["findings"]
    packaged = _client("publishing").post("/v1/publishing/package", headers=headers,
        json={**payload, "channel": channel, "artifactsBase64": {"book.epub": artifact}})
    assert packaged.status_code == 200, packaged.text
    with zipfile.ZipFile(BytesIO(base64.b64decode(packaged.json()["packages"][0]["dataBase64"]))) as package:
        assert package.read("book.epub") == base64.b64decode(artifact)


def test_fixed_render_missing_converter_returns_actionable_http_error(monkeypatch):
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "missing-converter-token")
    monkeypatch.setenv("BOOKWORM_PDFTOPPM", "bookworm-no-such-converter")
    response = _client("rendering").post("/render", headers={"x-service-token": "missing-converter-token"},
        json={"bookModel": BOOK_MODEL, "editionConfig": {"kind": "ebook", "flow": "fixed"}})
    assert response.status_code == 422
    assert "requires local Poppler" in response.json()["detail"]


@pytest.mark.parametrize("channel,kind", [
    ("kdp", "ebook"), ("apple", "ebook"), ("barnesnoble", "ebook"),
    ("kdp", "print"), ("barnesnoble", "print"), ("lulu", "print"),
])
def test_imported_manuscript_survives_render_and_retailer_package(monkeypatch, channel, kind):
    token = "local-artifact-journey-token"
    for name in ("DOCUMENT_SERVICE_TOKEN", "RENDERING_SERVICE_TOKEN", "PUBLISHING_SERVICE_TOKEN"):
        monkeypatch.setenv(name, token)
    headers = {"x-service-token": token}
    text = "Chapter 1\n\nMara counted seven silver coins beside the harbor.\n\nChapter 2\n\nThe lighthouse keeper returned her letter."
    if kind == "print":
        text += "".join(f"\n\nChapter {index}\n\nHarbor letter {index} arrived safely." for index in range(3, 33))
    imported = _client("document").post("/parse", headers=headers, json={
        "assetId": "artifact-source", "format": "txt", "title": "Harbor Letters",
        "contentBase64": base64.b64encode(text.encode()).decode(),
    })
    assert imported.status_code == 200, imported.text
    model = imported.json()["bookModel"]
    assert len(model["chapters"]) == (32 if kind == "print" else 2)
    model["metadata"].update({"title": "Harbor Letters", "author": "Fixture Author", "language": "en",
                              "description": "A mystery told through letters at a coastal harbor.",
                              "categories": ["FICTION / Mystery & Detective / General"]})
    edition = {"kind": kind, "navigation": "toc+landmarks"} if kind == "ebook" else {
        "kind": "print", "trim_size": "6x9", "bleed_in": 0.125, "bleed_edges": "all" if channel == "lulu" else "outer",
        "include_table_of_contents": True,
        "typography": {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"},
        "cover": {"asset_id": "44444444-4444-4444-8444-444444444444"},
        "wrap_cover": {"enabled": True, "profile": "kdp-white" if channel == "kdp" else "custom",
                       "expected_page_count": 36, "spine_width_in": 0.1},
        "page_numbering": {"style": "arabic", "start_at": 7, "position": "bottom-center"},
    }
    edition["front_matter"] = {"copyright_notice": "Copyright Fixture Author. Permission required.", "publisher": "Harbor Press"}
    request = {"bookModel": model, "editionConfig": edition}
    if kind == "print":
        from PIL import Image
        artwork = BytesIO()
        Image.new("RGB", (1800, 2700), "#204050").save(artwork, "PNG")
        request["coverBase64"] = base64.b64encode(artwork.getvalue()).decode()
    rendered = _client("rendering").post("/render", headers=headers, json=request)
    assert rendered.status_code == 200, rendered.text
    data = rendered.json()
    artifact = base64.b64decode(data["artifactBase64"], validate=True)
    assert hashlib.sha256(artifact).hexdigest() == data["sha256"]
    if kind == "ebook":
        with zipfile.ZipFile(BytesIO(artifact)) as archive:
            assert archive.read("mimetype") == b"application/epub+zip"
            content = "\n".join(archive.read(name).decode() for name in archive.namelist() if name.endswith(".xhtml"))
    else:
        from pypdf import PdfReader
        reader = PdfReader(BytesIO(artifact))
        assert len(reader.pages) == 36
        assert len(reader.outline) == 32
        assert "Contents" in reader.pages[2].extract_text()
        content = "\n".join(page.extract_text() for page in reader.pages)
        assert "7" in reader.pages[0].extract_text(), "starting page number not rendered"
    assert "Mara counted seven silver coins" in content
    assert "The lighthouse keeper returned her letter." in content
    assert "Harbor Press" in content
    assert "Copyright Fixture Author. Permission required." in content
    preflight = _client("rendering").post("/preflight", headers=headers, json={**request, "channel": channel})
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["errors"] == 0, preflight.json()["findings"]
    filename = "book.epub" if kind == "ebook" else "book.pdf"
    payload = {"channel": channel, "editionConfig": edition, "bookModel": model,
               "artifactsBase64": {filename: data["artifactBase64"]}}
    if kind == "print":
        payload["artifactsBase64"]["cover.pdf"] = data["coverArtifactBase64"]
    packaged = _client("publishing").post("/v1/publishing/package", headers=headers, json=payload)
    assert packaged.status_code == 200, packaged.text
    package = packaged.json()["packages"][0]
    blob = base64.b64decode(package["dataBase64"], validate=True)
    assert hashlib.sha256(blob).hexdigest() == package["sha256"]
    with zipfile.ZipFile(BytesIO(blob)) as archive:
        assert archive.read(filename) == artifact, "retailer package replaced the verified render"
        if kind == "print":
            assert archive.read("cover.pdf") == base64.b64decode(data["coverArtifactBase64"])
        assert json.loads(archive.read("manifest.json"))["channel"] == channel
        assert json.loads(archive.read("metadata.json"))["metadata"]["description"] == model["metadata"]["description"]
        assert "NOT been submitted" in archive.read("README.txt").decode()
    replay = _client("publishing").post("/v1/publishing/package", headers=headers, json=payload)
    assert replay.status_code == 200
    assert replay.json()["packages"][0]["sha256"] == package["sha256"]

# What the mock provider returns: one schema-valid propose_edit suggestion.
MOCK_SUGGESTION = {
    "toolCalls": [{
        "name": "propose_edit",
        "input": {
            "chapterId": CHAPTER_ID,
            "nodeId": "n1",
            "operation": {
                "operationId": "op-e2e-1",
                "type": "replace_text",
                "target": {"chapterId": CHAPTER_ID, "nodeId": "n1"},
                "payload": {"nodeId": "n1", "from": 0, "to": 7, "text": "The"},
                "expectedVersion": 1,
            },
            "rationale": "doubled word",
            "confidence": 0.95,
        },
    }],
    "usage": {"inputTokens": 10, "outputTokens": 5},
}


def test_p0_journey(monkeypatch, tmp_path):
    monkeypatch.setenv("DOCUMENT_SERVICE_TOKEN", "fixture-journey-document-token")
    # Document service: import TXT manuscript -> canonical Book Model.
    doc = _client("document")
    parsed = doc.post("/parse", headers={"x-service-token": "fixture-journey-document-token"}, json={
        "assetId": "a-1", "format": "txt", "title": "Critical Journey",
        "contentBase64": base64.b64encode(TEXT.encode()).decode(),
    })
    assert parsed.status_code == 200, parsed.text
    assert parsed.json()["bookModel"]["chapters"], "import produced no chapters"
    model = parsed.json()["bookModel"]
    model["bookId"] = BOOK_ID
    model["metadata"].update(BOOK_MODEL["metadata"])
    chapter = model["chapters"][0]
    chapter["id"] = CHAPTER_ID
    chapter["nodes"][0]["id"] = "n1"
    assert chapter["nodes"][0]["text"] == TEXT

    # AI service: create job (mock provider -> one valid suggestion).
    import gateway
    from gateway import MockProvider
    monkeypatch.setenv("DEFAULT_AI_PROVIDER", "mock")
    monkeypatch.setattr(gateway, "_REGISTRY",
                        {**gateway._REGISTRY, "mock": lambda: MockProvider([MOCK_SUGGESTION])})

    ai = _client("ai")
    job = ai.post("/v1/ai/jobs", json={
        "workspaceId": WORKSPACE_ID, "bookId": BOOK_ID, "agentType": "proofreader",
        "idempotencyKey": "e2e-job-1",
        "input": {"chapterIds": [CHAPTER_ID],
                  "chapters": {CHAPTER_ID: chapter},
                  "styleGuide": {"spellingVariant": "en-US"}},
    })
    assert job.status_code == 201, job.text
    body = job.json()
    assert body["status"] == "succeeded"
    assert len(body["suggestions"]) == 1

    # Idempotency: replay returns the same job.
    replay = ai.post("/v1/ai/jobs", json={
        "workspaceId": WORKSPACE_ID, "bookId": BOOK_ID, "agentType": "proofreader",
        "idempotencyKey": "e2e-job-1", "input": {}})
    assert replay.json()["jobId"] == body["jobId"]

    # Apply suggestion: returns the validated operation for the API to submit
    # to POST /v1/chapters/{id}/operations (expectedVersion/409 covered in API tests).
    sid = body["suggestions"][0]["id"]
    applied = ai.post(f"/v1/ai/suggestions/{sid}/apply")
    assert applied.status_code == 200, applied.text
    assert applied.json()["operation"]["type"] == "replace_text"
    # Simulate the API's text application, not its database/concurrency layer.
    operation = applied.json()["operation"]
    assert operation["target"] == {"chapterId": CHAPTER_ID, "nodeId": "n1"}
    replacement = operation["payload"]
    node = chapter["nodes"][0]
    node["text"] = node["text"][:replacement["from"]] + replacement["text"] + node["text"][replacement["to"]:]
    # Second apply conflicts (already accepted).
    assert ai.post(f"/v1/ai/suggestions/{sid}/apply").status_code == 409

    # Rendering service: render EPUB (deterministic sha256).
    rend = _client("rendering")
    epub = rend.post("/render", json={"editionConfig": EDITION, "bookModel": model})
    assert epub.status_code == 200, epub.text
    epub_body = epub.json()
    assert epub_body["format"] == "epub" and len(epub_body["sha256"]) == 64
    with zipfile.ZipFile(BytesIO(base64.b64decode(epub_body["artifactBase64"]))) as archive:
        content = "\n".join(archive.read(name).decode() for name in archive.namelist() if name.endswith(".xhtml"))
        assert "The night was quiet. Mara counted her coins twice." in content
        assert TEXT not in content
    epub2 = rend.post("/render", json={"editionConfig": EDITION, "bookModel": model})
    assert epub2.json()["sha256"] == epub_body["sha256"], "render not reproducible"

    # Deterministic preflight: zero errors on a valid model.
    pf = rend.post("/preflight", json={
        "editionConfig": EDITION, "bookModel": model, "channel": "kdp"})
    assert pf.status_code == 200, pf.text
    assert pf.json()["errors"] == 0, pf.json()["findings"]

    # Publishing service packages the exact reviewed artifact; job identity and
    # durable storage belong to the API/worker, not this private service.
    pub = _client("publishing")
    payload = {
        "channel": "kdp", "editionConfig": EDITION, "bookModel": model,
        "artifactsBase64": {"book.epub": epub_body["artifactBase64"]}}
    export = pub.post("/v1/publishing/package", json=payload)
    assert export.status_code == 200, export.text
    assert export.json()["packages"], "no export artifacts"
    with zipfile.ZipFile(BytesIO(base64.b64decode(export.json()["packages"][0]["dataBase64"]))) as archive:
        assert archive.read("book.epub") == base64.b64decode(epub_body["artifactBase64"])
    replay = pub.post("/v1/publishing/package", json=payload)
    assert replay.json() == export.json()


def test_validation_failure_paths():
    ai = _client("ai")
    rend = _client("rendering")
    pub = _client("publishing")

    # Missing required fields -> 422
    assert ai.post("/v1/ai/jobs", json={}).status_code == 422
    # Unknown agent type -> 422
    bad_agent = ai.post("/v1/ai/jobs", json={
        "workspaceId": "w", "bookId": "b", "agentType": "admin_override",
        "idempotencyKey": "k-bad", "input": {}})
    assert bad_agent.status_code == 422
    # Unknown suggestion -> 404
    assert ai.post("/v1/ai/suggestions/nope/apply").status_code == 404
    # Unknown job -> 404
    assert ai.get("/v1/ai/jobs/nope").status_code == 404
    # Bad edition kind -> 422
    assert rend.post("/render", json={
        "editionConfig": {"kind": "audiobook"}, "bookModel": BOOK_MODEL}).status_code == 422
    # Unknown channel -> 422
    assert pub.post("/v1/publishing/validate", json={
        "channel": "darkweb", "editionConfig": EDITION, "bookModel": BOOK_MODEL}).status_code == 422
    # Retired local-file route cannot consume caller-controlled job keys.
    assert pub.post("/v1/publishing/jobs", json={
        "channel": "kdp", "editionConfig": EDITION, "bookModel": BOOK_MODEL,
        "idempotencyKey": "../../evil"}).status_code == 410
