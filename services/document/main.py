"""Document import/normalization service: DOCX/EPUB/TXT/PDF -> canonical Book Model.

All uploaded content is untrusted: parsers never exec, guard zip-slip, cap sizes.
"""
import base64
import hmac
import os
from pathlib import Path, PureWindowsPath

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from parsers import MAX_FILE_BYTES, ParseError
from parsers.docx_parser import parse_docx
from parsers.epub_parser import parse_epub
from parsers.pdf_parser import parse_pdf
from parsers.txt_parser import parse_txt

app = FastAPI(title="bookworm-document")

PARSERS = {"docx": parse_docx, "epub": parse_epub, "txt": parse_txt, "pdf": parse_pdf}


def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    configured = (os.getenv("DOCUMENT_SERVICE_TOKEN") or os.getenv("SERVICE_AUTH_TOKEN") or "").strip()
    if not configured:
        raise HTTPException(503, "document service authentication is not configured")
    if not x_service_token or not hmac.compare_digest(x_service_token.encode("utf-8"), configured.encode("utf-8")):
        raise HTTPException(401, "invalid service token")


class ParseRequest(BaseModel):
    assetId: str = Field(min_length=1)
    format: str = Field(pattern="^(docx|epub|txt|pdf)$")
    storagePath: str | None = None
    contentBase64: str | None = Field(default=None, max_length=((MAX_FILE_BYTES + 2) // 3) * 4)
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
        if v.startswith(("/", "\\")) or PureWindowsPath(v).drive or ".." in v.replace("\\", "/").split("/") or "\x00" in v:
            raise ValueError("unsafe storagePath")
        return v


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/parse", dependencies=[Depends(require_service_token)])
def parse(req: ParseRequest) -> dict:
    try:
        if req.contentBase64 is not None:
            data = base64.b64decode(req.contentBase64, validate=True)
        else:
            configured_root = os.getenv("DOCUMENT_IMPORT_ROOT")
            if not configured_root:
                raise ParseError("filesystem import is disabled; provide contentBase64")
            root = Path(configured_root).resolve()
            p = (root / req.storagePath.replace("\\", "/")).resolve()
            if not p.is_relative_to(root):
                raise ParseError("storagePath escapes the import folder")
            if not p.is_file() or p.stat().st_size > MAX_FILE_BYTES:
                raise ParseError("storagePath missing or exceeds size cap")
            data = p.read_bytes()
        embedded_assets: list[dict] = []
        options = {"embedded_assets": embedded_assets} if req.format in ("docx", "epub") else {}
        book, report = PARSERS[req.format](data, title=req.title, **options)
    except ParseError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=422, detail="cannot read input") from e
    return {"bookModel": book, "report": report, "embeddedAssets": embedded_assets}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
