"""Lulu file order for a right-bound paperback reading-order proof."""
from io import BytesIO

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, RectangleObject


def lulu_rtl_page_count(reading_pages: int) -> int:
    # Lulu puts odd file pages on the right. With an even final count, the
    # original odd reading pages keep their left side and inner margin.
    return reading_pages + (reading_pages % 2)


def prepare_lulu_rtl_interior(interior: bytes) -> tuple[bytes, int]:
    """Write a printer copy and return the original page count."""
    try:
        reader = PdfReader(BytesIO(interior))
        if reader.is_encrypted:
            raise ValueError("encrypted interior")
        count = len(reader.pages)
        if not 32 <= lulu_rtl_page_count(count) <= 800:
            raise ValueError("unsupported Lulu page count")
        writer = PdfWriter()
        if count % 2:
            last = reader.pages[-1]
            blank = writer.add_blank_page(float(last.mediabox.width), float(last.mediabox.height))
            for key in ("/MediaBox", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox"):
                if key in last:
                    blank[NameObject(key)] = RectangleObject(last[key])
        writer.append(reader, pages=list(range(count - 1, -1, -1)))
        if reader.metadata:
            writer.add_metadata({key: reader.metadata[key] for key in ("/Title", "/Author", "/Subject", "/Keywords")
                                 if isinstance(reader.metadata.get(key), str)})
        result = BytesIO()
        writer.write(result)
        return result.getvalue(), count
    except Exception as error:
        raise ValueError("Lulu upload pages could not be prepared from the saved PDF. Render again and recheck the cover template.") from error
