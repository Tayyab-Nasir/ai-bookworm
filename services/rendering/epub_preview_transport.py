"""Bounded private transport for reading immutable saved EPUB bytes, never rendering."""
import asyncio
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from threading import BoundedSemaphore

from fastapi import HTTPException, Request, Response

MAX_SOURCE_BYTES = 150 * 1024 * 1024
MAX_REQUEST_BYTES = ((MAX_SOURCE_BYTES + 2) // 3) * 4 + 4096
MAX_RESPONSE_BYTES = 36 * 1024 * 1024
INGRESS_TIMEOUT_SECONDS = 20
PREVIEW_TIMEOUT_SECONDS = 10
# ponytail: one memory-heavy preview per service worker; add a shared admission
# budget if deployment ever runs multiple workers in a memory-constrained host.
_preview_slot = BoundedSemaphore(1)
_space = re.compile(rb"[ \t\r\n]*")
_field = re.compile(rb'"(bytesBase64|expectedSha256|spineIndex|resourceIndex)"[ \t\r\n]*:[ \t\r\n]*')
_source_text = re.compile(rb'"[A-Za-z0-9+/=]*"')
_digest_text = re.compile(rb'"[a-f0-9]{64}"')
_index_text = re.compile(rb'(?:0|[1-9][0-9]{0,3})(?![0-9])')
_base64_digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def _preview_command(mode: str, index: int, digest: str) -> list[str]:
    return [sys.executable, "-I", str(Path(__file__).resolve()), mode, str(index), digest]


def _flat_protocol(body: bytearray) -> None:
    """Validate the producer's four-field ASCII protocol before JSON allocation.

    No arrays, nested values, escaped field names, or unbounded numeric tokens
    are valid in this private protocol. Native linear token scans avoid walking
    a 200 MiB base64 value character-by-character in Python.
    """
    position = _space.match(body).end()
    if body[position:position + 1] != b"{":
        raise ValueError("invalid request structure")
    position += 1
    seen = set()
    for _ in range(4):
        position = _space.match(body, position).end()
        field = _field.match(body, position)
        if not field or field[1] in seen:
            raise ValueError("unknown or repeated field")
        key = field[1]
        seen.add(key)
        pattern = _source_text if key == b"bytesBase64" else _digest_text if key == b"expectedSha256" else _index_text
        value = pattern.match(body, field.end())
        if not value:
            raise ValueError("invalid field value")
        position = _space.match(body, value.end()).end()
        delimiter = body[position:position + 1]
        position += 1
        if delimiter == b"}":
            if _space.match(body, position).end() != len(body):
                raise ValueError("trailing request data")
            return
        if delimiter != b",":
            raise ValueError("invalid request structure")
    raise ValueError("too many request fields")


def _one_header(request: Request, name: str) -> str | None:
    values = request.headers.getlist(name)
    if len(values) > 1:
        raise ValueError("ambiguous request header")
    return values[0] if values else None


def _media_type(request: Request) -> str:
    return (_one_header(request, "content-type") or "").split(";", 1)[0].strip().lower()


async def _read_body(request: Request, limit: int) -> bytearray:
    if (_one_header(request, "content-encoding") or "identity").lower() != "identity":
        raise HTTPException(415, "compressed saved EPUB requests are not supported")
    declared = _one_header(request, "content-length")
    if declared is not None:
        if not 1 <= len(declared) <= 20 or not declared.isascii() or not declared.isdecimal():
            raise ValueError("invalid content length")
        if int(declared) > limit:
            raise HTTPException(413, "saved EPUB preview request exceeds input limit")
    body = bytearray()
    async with asyncio.timeout(INGRESS_TIMEOUT_SECONDS):
        async for chunk in request.stream():
            if len(body) + len(chunk) > limit:
                raise HTTPException(413, "saved EPUB preview request exceeds input limit")
            body.extend(chunk)
    if declared is not None and int(declared) != len(body):
        raise ValueError("inconsistent content length")
    return body


async def _read_payload(request: Request) -> dict:
    if _media_type(request) != "application/json":
        raise HTTPException(415, "saved EPUB preview requires JSON or EPUB bytes")
    if any(_one_header(request, name) is not None for name in
           ("x-epub-sha256", "x-epub-spine-index", "x-epub-resource-index")):
        raise ValueError("ambiguous request protocol")
    body = await _read_body(request, MAX_REQUEST_BYTES)
    _flat_protocol(body)
    return json.loads(body.decode("ascii"))


async def _read_raw_request(request: Request) -> tuple[bytearray, str, int, str]:
    digest = _one_header(request, "x-epub-sha256")
    spine = _one_header(request, "x-epub-spine-index")
    resource = _one_header(request, "x-epub-resource-index")
    if not digest or not re.fullmatch(r"[a-f0-9]{64}", digest) or spine is not None and resource is not None:
        raise ValueError("invalid or ambiguous source identity")
    mode = "resource" if resource is not None else "spine"
    selected = resource if resource is not None else spine if spine is not None else "0"
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,3})", selected):
        raise ValueError("invalid index")
    index = int(selected)
    if index >= (10000 if mode == "resource" else 2500):
        raise ValueError("invalid index")
    # Keep the streamed buffer as-is: no full-sized base64, JSON or bytes copy.
    data = await _read_body(request, MAX_SOURCE_BYTES)
    if not data or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("unbound source")
    return data, mode, index, digest


def _decode_request(value: dict) -> tuple[bytes, str, int, str]:
    keys = set(value)
    if not {"bytesBase64", "expectedSha256"} <= keys or not keys <= {"bytesBase64", "expectedSha256", "spineIndex", "resourceIndex"}:
        raise ValueError("unknown or missing fields")
    if "spineIndex" in value and "resourceIndex" in value:
        raise ValueError("ambiguous selection")
    mode = "resource" if "resourceIndex" in value else "spine"
    index = value.get("resourceIndex" if mode == "resource" else "spineIndex", 0)
    if type(index) is not int or not 0 <= index < (10000 if mode == "resource" else 2500):
        raise ValueError("invalid index")
    encoded, digest = value["bytesBase64"], value["expectedSha256"]
    if not isinstance(encoded, str) or not 4 <= len(encoded) <= ((MAX_SOURCE_BYTES + 2) // 3) * 4:
        raise ValueError("invalid source")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("invalid digest")
    data = base64.b64decode(encoded, validate=True)
    # Validate canonical padding without making two more 200 MiB encodings.
    padding = (-len(data)) % 3
    if not data or len(data) > MAX_SOURCE_BYTES or len(encoded) != ((len(data) + 2) // 3) * 4 or (
        padding and (not encoded.endswith("=" * padding) or
                     _base64_digits.find(encoded[-padding - 1]) & (15 if padding == 2 else 3))
    ):
        raise ValueError("invalid source")
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("unbound source")
    return data, mode, index, digest


async def run_preview(data: bytes | bytearray, mode: str, index: int, digest: str) -> bytes:
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
        "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    }}
    environment["PYTHONUTF8"] = "1"
    creation = asyncio.create_task(asyncio.create_subprocess_exec(*_preview_command(mode, index, digest),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=environment))
    process = None
    workers = []

    async def send():
        try:
            for offset in range(0, len(data), 65536):
                process.stdin.write(data[offset:offset + 65536])
                await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()
            try:
                await process.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def receive():
        output = bytearray()
        while chunk := await process.stdout.read(65536):
            if len(output) + len(chunk) > MAX_RESPONSE_BYTES:
                raise ValueError("oversized preview")
            output.extend(chunk)
        return bytes(output)

    try:
        async with asyncio.timeout(PREVIEW_TIMEOUT_SECONDS):
            process = await asyncio.shield(creation)
            workers = [asyncio.create_task(send()), asyncio.create_task(receive()), asyncio.create_task(process.wait())]
            _, output, code = await asyncio.gather(*workers)
        if code == 2:
            raise ValueError("invalid saved EPUB")
        if code != 0:
            raise RuntimeError("preview unavailable")
        result = json.loads(output)
        if not isinstance(result, dict) or result.get("formatVersion") != "epub-reader-1.0.0" or result.get("sourceSha256") != digest or result.get("sourceSizeBytes") != len(data):
            raise ValueError("unbound preview result")
        return output
    finally:
        async def settle():
            try:
                owned = await creation
            except (Exception, asyncio.CancelledError):
                return
            try:
                if owned.returncode is None:
                    try:
                        owned.kill()
                    except ProcessLookupError:
                        pass
                await owned.wait()
            finally:
                for task in workers:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
        cleanup = asyncio.create_task(settle())
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        await cleanup
        if cancelled:
            raise asyncio.CancelledError


async def preview_epub_request(request: Request) -> Response:
    if not _preview_slot.acquire(blocking=False):
        raise HTTPException(503, "saved EPUB preview is busy")
    try:
        data, mode, index, digest = (await _read_raw_request(request)
            if _media_type(request) == "application/epub+zip" else _decode_request(await _read_payload(request)))
        output = await run_preview(data, mode, index, digest)
        return Response(output, media_type="application/json",
            headers={"cache-control": "private, no-store", "x-content-type-options": "nosniff"})
    except HTTPException:
        raise
    except (ValueError, TypeError, UnicodeError) as error:
        raise HTTPException(422, "invalid or unbound saved EPUB preview request") from error
    except (TimeoutError, RuntimeError, OSError) as error:
        raise HTTPException(503, "saved EPUB preview is unavailable or timed out") from error
    finally:
        _preview_slot.release()


def _child() -> int:
    try:
        if len(sys.argv) != 4 or sys.argv[1] not in {"spine", "resource"}:
            return 2
        mode, index, digest = sys.argv[1], int(sys.argv[2]), sys.argv[3]
        data = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
        if not data or len(data) > MAX_SOURCE_BYTES or hashlib.sha256(data).hexdigest() != digest:
            return 2
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from epub_preview import preview_epub
        result = preview_epub(data, spine_index=index) if mode == "spine" else preview_epub(data, resource_index=index)
        output = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(output) > MAX_RESPONSE_BYTES:
            return 2
        sys.stdout.buffer.write(output)
        return 0
    except (ValueError, TypeError, UnicodeError):
        return 2
    except Exception:
        return 3


if __name__ == "__main__":
    raise SystemExit(_child())
