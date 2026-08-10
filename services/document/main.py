"""Document import/normalization service: DOCX/EPUB/TXT/PDF -> canonical Book Model.

All uploaded content is untrusted: parsers never exec, guard zip-slip, cap sizes.
"""
import base64
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from parsers import MAX_FILE_BYTES, ParseError
from parsers.docx_parser import parse_docx
from parsers.epub_parser import parse_epub
from parsers.pdf_parser import parse_pdf
from parsers.txt_parser import parse_txt

app = FastAPI(title="bookworm-document")

PARSERS = {"docx": parse_docx, "epub": parse_epub, "txt": parse_txt, "pdf": parse_pdf}


class ParseRequest(BaseModel):
    assetId: str = Field(min_length=1)
    format: str = Field(pattern="^(docx|epub|txt|pdf)$")
    storagePath: str | None = None
    contentBase64: str | None = None
    title: str = "Untitled"

    @model_validator(mode="after")
    def one_source(self):
        if bool(self.storagePath) == bool(self.contentBase64):
            raise ValueError("provide exactly one of storagePath or contentBase64")
        return self

    @field_validator("storagePath")
    @classmethod
    def path_safety(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v.startswith(("/", "\\")) or ".." in v.split("/"):
            raise ValueError("unsafe storagePath")
        return v


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/parse")
def parse(req: ParseRequest) -> dict:
    try:
        if req.contentBase64 is not None:
            data = base64.b64decode(req.contentBase64, validate=True)
        else:
            p = Path(req.storagePath)
            if not p.is_file() or p.stat().st_size > MAX_FILE_BYTES:
                raise ParseError("storagePath missing or exceeds size cap")
            data = p.read_bytes()
        book, report = PARSERS[req.format](data, title=req.title)
    except ParseError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"cannot read input: {e}") from e
    return {"bookModel": book, "report": report}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
