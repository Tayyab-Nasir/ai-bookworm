"""Generate local, deterministic print-layout samples for visual inspection.

Requires the project's rendering dependencies and pdftoppm on PATH. No network
or real manuscripts. Outputs to a new temporary directory; deletes nothing.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/rendering"))
from editions import PrintEdition
from pdf_renderer import render_pdf


def main():
    output = Path(tempfile.mkdtemp(prefix="bookworm-print-contents-"))
    book = {"metadata": {"title": "Letters from the Harbor", "subtitle": "A story of journeys and returns",
                         "author": "Ada Finch", "language": "en"},
            "chapters": [{"id": f"ch-{index}", "order": index, "title": title,
                          "nodes": [{"id": f"p-{index}", "type": "paragraph",
                                     "text": "The harbor lights shimmered as the last letter arrived. " * 18}]}
                         for index, title in enumerate([
                             "The first letter and the distant lighthouse",
                             "An unexpectedly long chapter title about the boats, the changing seasons, and the keeper who waited",
                             "Home, at last: a letter returned"])], "assets": []}
    results = []
    for name, settings in [
        ("standard", {}),
        ("large-roman", {"trim_size": "5x8", "page_numbering": {"style": "roman", "start_at": 9999},
                         "typography": {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold",
                                        "body_size_pt": 20, "heading_size_pt": 24, "leading": 26}}),
    ]:
        config = {"include_table_of_contents": True,
                  "typography": {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"}, **settings}
        blob, checksum = render_pdf(book, PrintEdition(**config))
        pdf = output / f"{name}.pdf"
        pdf.write_bytes(blob)
        prefix = output / name
        subprocess.run(["pdftoppm", "-f", "2", "-l", "2", "-scale-to", "1200", "-singlefile", "-png", str(pdf), str(prefix)], check=True)
        results.append({"name": name, "pdf": str(pdf), "preview": str(prefix.with_suffix('.png')), "sha256": checksum})
    print(json.dumps(results))


if __name__ == "__main__":
    main()
