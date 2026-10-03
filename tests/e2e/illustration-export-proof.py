"""Render the exact browser-saved artwork placement with deterministic test pixels.

Usage: node scripts/run-python.mjs tests/e2e/illustration-export-proof.py NODE_JSON
Requires EPUBCHECK_JAR; no provider or hosted calls. This proves renderer fidelity,
not native Storage or approval behavior (covered separately by API/SQL tests).
"""
import io
import json
import sys
import tempfile
import zipfile
from dataclasses import asdict
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "rendering"))
from editions import EbookEdition, PrintEdition
from epub_renderer import render_epub
from epubcheck_runner import run_epubcheck
from pdf_renderer import render_pdf
from PIL import Image, ImageDraw
from pypdf import PdfReader


def main():
    node = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    assert node["assetVersionNumber"] == 4
    assert node["altText"] == "The approved harbor lantern crest"
    # Distinct quadrants detect missing, mirrored, substituted or blank images.
    pixels = Image.new("RGB", (600, 400), "#123456")
    draw = ImageDraw.Draw(pixels)
    draw.rectangle((300, 0, 599, 199), fill="#cc8844")
    draw.rectangle((0, 200, 299, 399), fill="#448866")
    draw.rectangle((300, 200, 599, 399), fill="#eeeecc")
    encoded = io.BytesIO()
    pixels.save(encoded, format="PNG")
    book = json.loads((ROOT / "tests/fixtures/books/valid_book.json").read_text())
    book["chapters"] = [{**book["chapters"][0], "nodes": [
        {"id": "before", "type": "paragraph", "text": "Approved artwork proof."}, node]}]
    book["assets"] = [{"id": node["assetId"], "role": "illustration"}]
    images = {node["assetId"]: encoded.getvalue()}
    epub, epub_hash = render_epub(book, EbookEdition(kind="ebook"), image_bytes=images)
    pdf, pdf_hash = render_pdf(book, PrintEdition(kind="print", trim_size="6x9"), image_bytes=images)
    with zipfile.ZipFile(io.BytesIO(epub)) as archive:
        root = ET.fromstring(archive.read("OEBPS/ch0000.xhtml"))
        image = root.find(".//{http://www.w3.org/1999/xhtml}img")
        assert image is not None and image.attrib["alt"] == node["altText"]
        embedded = Image.open(io.BytesIO(archive.read("OEBPS/" + image.attrib["src"]))).convert("RGB")
        assert embedded.size == pixels.size and embedded.tobytes() == pixels.tobytes()
    reader = PdfReader(io.BytesIO(pdf))
    embedded_pdf = [entry.image.convert("RGB") for page in reader.pages for entry in page.images]
    assert len(embedded_pdf) == 1
    assert embedded_pdf[0].size == pixels.size and embedded_pdf[0].tobytes() == pixels.tobytes()
    result = run_epubcheck(epub)
    assert result.status == "valid" and result.errors == 0 and result.warnings == 0, result
    output = Path(tempfile.mkdtemp(prefix="bookworm-illustration-export-"))
    (output / "book.epub").write_bytes(epub)
    (output / "book.pdf").write_bytes(pdf)
    print(json.dumps({"status": "passed", "placedVersion": node["assetVersionNumber"],
                      "epubcheck": asdict(result), "epubSha256": epub_hash,
                      "pdfSha256": pdf_hash, "output": str(output)}))


if __name__ == "__main__":
    main()
