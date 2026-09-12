"""Bounded image transfer inside the authenticated parser response, never HTML URLs."""
import base64
import hashlib
import uuid

from . import ParseError

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024
MAX_IMAGES = 100
EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}


class EmbeddedImages:
    def __init__(self, output: list[dict] | None = None):
        self.output = output if output is not None else []
        self.by_checksum: dict[str, str] = {}
        self.total = 0

    def add(self, data: bytes, mime: str) -> str | None:
        if mime not in EXTENSIONS:
            return None
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ParseError("embedded image exceeds the 10 MiB import limit")
        checksum = hashlib.sha256(data).hexdigest()
        if checksum in self.by_checksum:
            return self.by_checksum[checksum]
        if len(self.output) >= MAX_IMAGES or self.total + len(data) > MAX_TOTAL_IMAGE_BYTES:
            raise ParseError("embedded images exceed the 100-image / 40 MiB import budget")
        asset_id = str(uuid.uuid4())
        self.output.append({"id": asset_id, "filename": f"imported-{len(self.output) + 1}.{EXTENSIONS[mime]}",
                            "mimeType": mime, "sizeBytes": len(data), "checksumSha256": checksum,
                            "contentBase64": base64.b64encode(data).decode("ascii")})
        self.by_checksum[checksum] = asset_id
        self.total += len(data)
        return asset_id
