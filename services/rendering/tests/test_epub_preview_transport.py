"""Private saved-EPUB HTTP boundary: auth, bounded ingress/process/output, no generation."""
import asyncio
import base64
import hashlib
import importlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture
def client(monkeypatch):
    spec = importlib.util.spec_from_file_location("bookworm_epub_preview_http", ROOT / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "preview-http-fixture")
    with TestClient(module.app, raise_server_exceptions=False) as value:
        yield value


def payload(data=b"not an epub"):
    return {"bytesBase64": base64.b64encode(data).decode(), "expectedSha256": hashlib.sha256(data).hexdigest(), "spineIndex": 0}


def post(client, value, **kwargs):
    return client.post("/epub/preview", headers={"x-service-token": "preview-http-fixture"}, json=value, **kwargs)


def test_auth_precedes_even_invalid_json_or_type(client):
    response = client.post("/epub/preview", content=b"private fixture invalid JSON", headers={"content-type": "text/plain"})
    assert response.status_code == 401
    assert response.json() == {"detail": "invalid service token"}


def test_missing_service_configuration_fails_closed(client, monkeypatch):
    monkeypatch.delenv("RENDERING_SERVICE_TOKEN")
    monkeypatch.delenv("SERVICE_AUTH_TOKEN", raising=False)
    assert post(client, payload()).status_code == 503


@pytest.mark.parametrize("change", [
    {"spineIndex": True}, {"spineIndex": -1}, {"spineIndex": 2500},
    {"resourceIndex": 0}, {"resourceIndex": True}, {"spineIndex": 0.0},
    {"expectedSha256": "bad"}, {"url": "https://private.invalid/"},
    {"bytesBase64": "AAAA==="}, {"bytesBase64": ""}, {"bytesBase64": "AB=="},
])
def test_invalid_input_is_generic_and_never_echoed(client, change):
    value = {**payload(), **change}
    response = post(client, value)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid or unbound saved EPUB preview request"}
    assert "private.invalid" not in response.text


def test_source_digest_rechecked_before_child(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    async def forbidden(*args):
        raise AssertionError("unbound input reached child")
    monkeypatch.setattr(boundary, "run_preview", forbidden)
    value = {**payload(), "expectedSha256": "a" * 64}
    assert post(client, value).status_code == 422


def test_content_type_and_encoding_rejected_before_read(client):
    headers = {"x-service-token": "preview-http-fixture", "content-type": "text/plain"}
    assert client.post("/epub/preview", headers=headers, content="private fixture").status_code == 415
    headers["content-type"] = "application/json"
    headers["content-encoding"] = "gzip"
    assert client.post("/epub/preview", headers=headers, content="private fixture").status_code == 415


def test_declared_and_streamed_body_limits(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setattr(boundary, "MAX_REQUEST_BYTES", 64)
    headers = {"x-service-token": "preview-http-fixture", "content-type": "application/json"}
    assert client.post("/epub/preview", headers=headers, content=b"x" * 65).status_code == 413
    assert client.post("/epub/preview", headers=headers, content=iter([b"x" * 40, b"x" * 40])).status_code == 413


def test_busy_admission_does_not_decode_input(client):
    boundary = importlib.import_module("epub_preview_transport")
    assert boundary._preview_slot.acquire(blocking=False)
    try:
        assert post(client, {"bytesBase64": "private fixture"}).status_code == 503
    finally:
        boundary._preview_slot.release()


def test_real_saved_epub_read_only_preview_and_source_identity(client):
    from editions import EbookEdition
    from epub_renderer import render_epub
    book = json.loads((ROOT.parents[1] / "tests/fixtures/books/valid_book.json").read_text())
    data, digest = render_epub(book, EbookEdition())
    response = post(client, payload(data))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["sourceSha256"] == digest
    assert response.json()["sourceSizeBytes"] == len(data)
    assert response.json()["formatVersion"] == "epub-reader-1.0.0"
    assert "document" in response.json()


def test_invalid_zip_is_not_reported_as_internal_failure(client):
    response = post(client, payload())
    assert response.status_code == 422
    assert "Traceback" not in response.text


def test_child_timeout_is_bounded_and_safe(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setattr(boundary, "PREVIEW_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(boundary, "_preview_command", lambda *_: [sys.executable, "-I", "-c", "import time;time.sleep(5)"])
    assert post(client, payload()).status_code == 503
    assert boundary._preview_slot.acquire(blocking=False), "timeout leaked admission slot"
    boundary._preview_slot.release()


def test_child_output_cap_and_error_details_never_exposed(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setattr(boundary, "MAX_RESPONSE_BYTES", 64)
    monkeypatch.setattr(boundary, "_preview_command", lambda *_: [sys.executable, "-I", "-c", "import sys;sys.stdout.write('x'*1000);sys.stderr.write('private child detail')"])
    response = post(client, payload())
    assert response.status_code == 422
    assert "private child detail" not in response.text


def test_child_receives_no_operator_keys_and_cancellation_reaps_it(monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-never-forward")
    seen = []
    original = asyncio.create_subprocess_exec
    async def launch(*args, **kwargs):
        assert "OPENAI_API_KEY" not in kwargs["env"]
        assert "RENDERING_SERVICE_TOKEN" not in kwargs["env"]
        process = await original(*args, **kwargs)
        seen.append(process)
        return process
    monkeypatch.setattr(boundary.asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(boundary, "_preview_command", lambda *_: [sys.executable, "-I", "-c", "import time;time.sleep(5)"])
    async def check():
        task = asyncio.create_task(boundary.run_preview(b"fixture", "spine", 0, "a" * 64))
        while not seen:
            await asyncio.sleep(0.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert seen[0].returncode is not None
    asyncio.run(check())


@pytest.mark.parametrize("body", [
    b'{"bytesBase64":' + b'[' * 3000 + b'0' + b']' * 3000 + b'}',
    b'{"unexpected":[' + b'0,' * 10000 + b'0]}',
    b'{' + b'"unexpected":0,' * 10000 + b'"spineIndex":0}',
], ids=["deep-array", "wide-array", "wide-object"])
def test_flat_protocol_shape_rejected_before_json_allocation(client, monkeypatch, body):
    boundary = importlib.import_module("epub_preview_transport")
    def forbidden(*args, **kwargs):
        raise AssertionError("hostile structure reached JSON allocation")
    monkeypatch.setattr(boundary.json, "loads", forbidden)
    response = client.post("/epub/preview", content=body, headers={
        "x-service-token": "preview-http-fixture", "content-type": "application/json"})
    assert response.status_code == 422


@pytest.mark.parametrize("during_creation", [False, True])
def test_repeated_cancellation_keeps_admission_until_child_and_io_settle(monkeypatch, during_creation):
    boundary = importlib.import_module("epub_preview_transport")
    async def check():
        created, proceed, killed, reaped = (asyncio.Event() for _ in range(4))
        io = set()
        class Input:
            def write(self, value):
                created.set()
            async def drain(self):
                io.add(asyncio.current_task())
                try:
                    await reaped.wait()
                finally:
                    io.discard(asyncio.current_task())
            def close(self):
                pass
            async def wait_closed(self):
                pass
        class Output:
            async def read(self, size):
                io.add(asyncio.current_task())
                try:
                    await reaped.wait()
                    return b""
                finally:
                    io.discard(asyncio.current_task())
        class Process:
            stdin, stdout, returncode = Input(), Output(), None
            def kill(self):
                killed.set()
            async def wait(self):
                await reaped.wait()
                self.returncode = -1
                return -1
        process = Process()
        async def launch(*args, **kwargs):
            if during_creation:
                created.set()
                await proceed.wait()
            return process
        monkeypatch.setattr(boundary.asyncio, "create_subprocess_exec", launch)
        data = json.dumps(payload()).encode()
        async def receive():
            return {"type": "http.request", "body": data, "more_body": False}
        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        task = asyncio.create_task(boundary.preview_epub_request(request))
        await asyncio.wait_for(created.wait(), 1)
        task.cancel()
        if during_creation:
            await asyncio.sleep(0)
            task.cancel()
            assert not task.done(), "creation ownership was lost on cancellation"
            proceed.set()
        await asyncio.wait_for(killed.wait(), 1)
        task.cancel()
        await asyncio.sleep(0.01)
        try:
            assert not task.done(), "cleanup was interrupted by a repeated cancellation"
            assert not boundary._preview_slot.acquire(blocking=False), "admission released before child settlement"
        finally:
            reaped.set()
            await asyncio.gather(task, return_exceptions=True)
        assert process.returncode is not None
        assert not io
        assert task.cancelled()
        assert boundary._preview_slot.acquire(blocking=False)
        boundary._preview_slot.release()
    asyncio.run(check())


def test_protocol_accepts_reordered_whitespace_and_default_spine():
    boundary = importlib.import_module("epub_preview_transport")
    value = payload(b"saved bytes")
    for body in [
        (' {\n "expectedSha256": "' + value["expectedSha256"] + '",\t"bytesBase64":"' + value["bytesBase64"] + '"\r\n} ').encode(),
        json.dumps({"resourceIndex": 9999, "bytesBase64": value["bytesBase64"], "expectedSha256": value["expectedSha256"]}).encode(),
    ]:
        boundary._flat_protocol(bytearray(body))
        parsed = json.loads(body)
        data, mode, index, digest = boundary._decode_request(parsed)
        assert data == b"saved bytes" and digest == value["expectedSha256"]
        assert (mode, index) == (("resource", 9999) if "resourceIndex" in parsed else ("spine", 0))


@pytest.mark.parametrize("body", [
    b'{"spineIndex":0,"spineIndex":0}', b'{"spineIndex":0,}',
    b'{"spineIndex":0}{}', b'{"spineIndex":10000}',
    b'{"spineIndex":0.0}', b'{"spineIndex":1e0}',
    b'{"spineIndex":"0"}', b'{"spineIndex":null}',
    b'{"\\u0073pineIndex":0}', b'{"bytesBase64":"AA\\u003d\\u003d"}',
    b'{"bytesBase64":{}}', b'{"bytesBase64":[]}',
], ids=["duplicate", "trailing-comma", "trailing-object", "long-number",
        "float", "exponent", "quoted-index", "null", "escaped-key",
        "escaped-source", "nested-object", "nested-array"])
def test_flat_protocol_rejects_non_producer_grammar(body):
    boundary = importlib.import_module("epub_preview_transport")
    with pytest.raises(ValueError):
        boundary._flat_protocol(bytearray(body))


def test_canonical_padding_check_matches_standard_encoder_without_reencoding():
    boundary = importlib.import_module("epub_preview_transport")
    alphabet = boundary._base64_digits
    for size in range(1, 97):
        data = bytes(range(size))
        value = payload(data)
        assert boundary._decode_request(value)[0] == data
        padding = (-size) % 3
        if padding:
            encoded = value["bytesBase64"]
            index = len(encoded) - padding - 1
            # The decoder accepts nonzero unused bits; the canonical gate must not.
            changed = encoded[:index] + alphabet[alphabet.index(encoded[index]) + 1] + encoded[index + 1:]
            assert base64.b64decode(changed, validate=True) == data
            with pytest.raises(ValueError):
                boundary._decode_request({**value, "bytesBase64": changed})


def test_ingress_timeout_releases_admission_without_creating_child(monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setattr(boundary, "INGRESS_TIMEOUT_SECONDS", 0.01)
    async def receive():
        await asyncio.sleep(5)
    async def forbidden(*args):
        raise AssertionError("timed-out ingress reached child")
    monkeypatch.setattr(boundary, "run_preview", forbidden)
    async def check():
        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        with pytest.raises(boundary.HTTPException) as error:
            await boundary.preview_epub_request(request)
        assert error.value.status_code == 503
        assert boundary._preview_slot.acquire(blocking=False)
        boundary._preview_slot.release()
    asyncio.run(check())


def raw_post(client, data, selection=None, headers=None):
    return client.post("/epub/preview", content=data, headers={
        "x-service-token": "preview-http-fixture", "content-type": "application/epub+zip",
        "x-epub-sha256": hashlib.sha256(data).hexdigest(), **(selection or {}), **(headers or {}),
    })


def test_raw_document_preview_uses_verified_bytes_without_json_or_base64(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    data = b"unchanged private EPUB bytes"
    async def child(received, mode, index, digest):
        assert isinstance(received, bytearray), "raw ingress made another full source copy"
        assert received == data
        assert (mode, index, digest) == ("spine", 0, hashlib.sha256(data).hexdigest())
        return b'{"privateFixture":true}'
    def forbidden(*args, **kwargs):
        raise AssertionError("raw ingress decoded JSON/base64")
    monkeypatch.setattr(boundary, "run_preview", child)
    monkeypatch.setattr(boundary, "_flat_protocol", forbidden)
    monkeypatch.setattr(boundary, "_decode_request", forbidden)
    response = raw_post(client, data)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("selection,expected", [
    ({"x-epub-spine-index": "2499"}, ("spine", 2499)),
    ({"x-epub-resource-index": "9999"}, ("resource", 9999)),
])
def test_raw_canonical_selection_reaches_only_owned_child(client, monkeypatch, selection, expected):
    boundary = importlib.import_module("epub_preview_transport")
    async def child(data, mode, index, digest):
        assert (mode, index) == expected
        return b'{}'
    monkeypatch.setattr(boundary, "run_preview", child)
    assert raw_post(client, b"saved", selection).status_code == 200


@pytest.mark.parametrize("headers", [
    {"x-epub-spine-index": "00"}, {"x-epub-spine-index": "-1"},
    {"x-epub-spine-index": "1.0"}, {"x-epub-spine-index": "1e0"},
    {"x-epub-spine-index": " 1"}, {"x-epub-spine-index": "2500"},
    {"x-epub-resource-index": "10000"}, {"x-epub-resource-index": ""},
    {"x-epub-resource-index": "0", "x-epub-spine-index": "0"},
    {"x-epub-sha256": "A" * 64}, {"x-epub-sha256": "a" * 64},
    {"x-epub-sha256": "private-invalid"},
])
def test_raw_invalid_headers_or_hash_never_launch_child(client, monkeypatch, headers):
    boundary = importlib.import_module("epub_preview_transport")
    async def forbidden(*args):
        raise AssertionError("invalid raw request reached child")
    monkeypatch.setattr(boundary, "run_preview", forbidden)
    response = raw_post(client, b"saved", headers=headers)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid or unbound saved EPUB preview request"}


def test_raw_missing_and_duplicate_identity_headers_fail_closed(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    async def forbidden(*args):
        raise AssertionError("ambiguous request reached child")
    monkeypatch.setattr(boundary, "run_preview", forbidden)
    base = [("x-service-token", "preview-http-fixture"), ("content-type", "application/epub+zip")]
    digest = hashlib.sha256(b"saved").hexdigest()
    for additions in [[], [("x-epub-sha256", digest)] * 2,
                      [("x-epub-sha256", digest), ("x-epub-spine-index", "0"), ("x-epub-spine-index", "0")]]:
        assert client.post("/epub/preview", headers=base + additions, content=b"saved").status_code == 422


def test_raw_declared_streamed_empty_and_encoding_bounds(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setattr(boundary, "MAX_SOURCE_BYTES", 64)
    assert raw_post(client, b"x" * 65).status_code == 413
    headers = {"x-service-token": "preview-http-fixture", "content-type": "application/epub+zip",
               "x-epub-sha256": hashlib.sha256(b"x" * 80).hexdigest()}
    assert client.post("/epub/preview", headers=headers, content=iter([b"x" * 40, b"x" * 40])).status_code == 413
    assert raw_post(client, b"").status_code == 422
    assert raw_post(client, b"saved", headers={"content-encoding": "gzip"}).status_code == 415
    assert raw_post(client, b"saved", headers={"content-length": "0"}).status_code == 422


@pytest.mark.parametrize("image_format,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_raw_native_document_and_raster_http_preserve_saved_artifact(client, image_format, mime):
    import io
    import zipfile
    from PIL import Image
    from editions import EbookEdition
    from epub_renderer import render_epub
    from epub_preview import preview_epub
    image = io.BytesIO()
    Image.new("RGB", (120, 180), "#234567").save(image, image_format)
    art = image.getvalue()
    book = json.loads((ROOT.parents[1] / "tests/fixtures/books/valid_book.json").read_text())
    art_id = "33333333-3333-4333-8333-333333333333"
    png = io.BytesIO()
    Image.new("RGB", (120, 180), "#234567").save(png, "PNG")
    data, digest = render_epub(book, EbookEdition(cover={"asset_id": art_id}), cover_bytes=png.getvalue())
    if image_format == "JPEG":
        # The renderer embeds normalized PNG. A standards-valid imported JPEG
        # EPUB also has matching manifest MIME, href and unchanged raster bytes.
        saved = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(data)) as original, zipfile.ZipFile(saved, "w") as changed:
            for item in original.infolist():
                name, content = item.filename, original.read(item)
                if name.endswith(art_id + ".png"):
                    name, content = name.removesuffix(".png") + ".jpg", art
                elif name.endswith((".opf", ".xhtml")):
                    content = content.replace((art_id + ".png").encode(), (art_id + ".jpg").encode()).replace(b'media-type="image/png"', b'media-type="image/jpeg"')
                changed.writestr(name, content, compress_type=zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED)
        data = saved.getvalue()
        digest = hashlib.sha256(data).hexdigest()
    response = raw_post(client, data)
    assert response.status_code == 200, response.text
    assert response.json() == preview_epub(data, spine_index=0)
    resource = raw_post(client, data, {"x-epub-resource-index": "0"})
    assert resource.status_code == 200, resource.text
    actual = resource.json()
    assert actual == preview_epub(data, resource_index=0)
    assert actual["sourceSha256"] == digest and actual["sourceSizeBytes"] == len(data)
    assert actual["resource"]["mimeType"] == mime
    assert (actual["resource"]["width"], actual["resource"]["height"]) == (120, 180)
    assert base64.b64decode(actual["resource"]["base64"]) == art


def test_json_compatibility_rejects_a_second_raw_header_identity(client):
    value = payload()
    response = client.post("/epub/preview", json=value, headers={
        "x-service-token": "preview-http-fixture", "x-epub-sha256": value["expectedSha256"],
    })
    assert response.status_code == 422


@pytest.mark.parametrize("header", ["content-type", "content-encoding", "content-length", "x-epub-resource-index"])
def test_duplicate_raw_protocol_headers_are_not_first_value_wins(client, header):
    values = {"content-type": "application/epub+zip", "content-encoding": "identity",
              "content-length": "5", "x-epub-resource-index": "0"}
    headers = [("x-service-token", "preview-http-fixture"), ("x-epub-sha256", hashlib.sha256(b"saved").hexdigest())]
    if header != "content-type":
        headers.append(("content-type", "application/epub+zip"))
    headers.extend([(header, values[header])] * 2)
    assert client.post("/epub/preview", headers=headers, content=b"saved").status_code == 422


@pytest.mark.parametrize("field,value", [("formatVersion", "private-wrong"), ("sourceSha256", "a" * 64), ("sourceSizeBytes", 1)])
def test_child_wrong_result_identity_is_generic_and_releases_slot(client, monkeypatch, field, value):
    boundary = importlib.import_module("epub_preview_transport")
    result = {"formatVersion": "epub-reader-1.0.0", "sourceSha256": payload()["expectedSha256"],
              "sourceSizeBytes": len(b"not an epub"), field: value}
    code = "import sys;sys.stdout.write(" + repr(json.dumps(result)) + ")"
    monkeypatch.setattr(boundary, "_preview_command", lambda *_: [sys.executable, "-I", "-c", code])
    response = post(client, payload())
    assert response.status_code == 422
    assert "private-wrong" not in response.text
    assert boundary._preview_slot.acquire(blocking=False)
    boundary._preview_slot.release()


def test_child_creation_failure_is_generic_and_does_not_leak_slot(client, monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    async def launch(*args, **kwargs):
        raise OSError("private executable detail")
    monkeypatch.setattr(boundary.asyncio, "create_subprocess_exec", launch)
    response = raw_post(client, b"saved")
    assert response.status_code == 503
    assert "private executable detail" not in response.text
    assert boundary._preview_slot.acquire(blocking=False)
    boundary._preview_slot.release()


@pytest.mark.parametrize("creation_fails", [False, True])
def test_delayed_creation_timeout_keeps_ownership_until_terminal(monkeypatch, creation_fails):
    boundary = importlib.import_module("epub_preview_transport")
    monkeypatch.setattr(boundary, "PREVIEW_TIMEOUT_SECONDS", 0.005)
    async def check():
        entered, proceed, killed, reaped = (asyncio.Event() for _ in range(4))
        class Process:
            returncode = None
            def kill(self):
                killed.set()
            async def wait(self):
                self.returncode = -1
                reaped.set()
                return -1
        process = Process()
        async def launch(*args, **kwargs):
            entered.set()
            await proceed.wait()
            if creation_fails:
                raise OSError("private creation failure")
            return process
        monkeypatch.setattr(boundary.asyncio, "create_subprocess_exec", launch)
        data = b"saved"
        async def receive():
            return {"type": "http.request", "body": data, "more_body": False}
        request = Request({"type": "http", "headers": [(b"content-type", b"application/epub+zip"),
            (b"x-epub-sha256", hashlib.sha256(data).hexdigest().encode())]}, receive)
        task = asyncio.create_task(boundary.preview_epub_request(request))
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.sleep(0.02)
        assert not task.done(), "timed-out creation was abandoned"
        assert not boundary._preview_slot.acquire(blocking=False), "admission released before creation settled"
        proceed.set()
        with pytest.raises(boundary.HTTPException) as error:
            await task
        assert error.value.status_code == 503
        assert creation_fails or killed.is_set() and reaped.is_set()
        assert boundary._preview_slot.acquire(blocking=False)
        boundary._preview_slot.release()
    asyncio.run(check())


def test_repeated_cancellation_during_creation_failure_settles_owned_task(monkeypatch):
    boundary = importlib.import_module("epub_preview_transport")
    async def check():
        entered, proceed, terminal = (asyncio.Event() for _ in range(3))
        async def launch(*args, **kwargs):
            entered.set()
            try:
                await proceed.wait()
                raise OSError("private creation failure")
            finally:
                terminal.set()
        monkeypatch.setattr(boundary.asyncio, "create_subprocess_exec", launch)
        data = json.dumps(payload()).encode()
        async def receive():
            return {"type": "http.request", "body": data, "more_body": False}
        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        task = asyncio.create_task(boundary.preview_epub_request(request))
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0.01)
        try:
            assert not task.done()
            assert not boundary._preview_slot.acquire(blocking=False)
        finally:
            proceed.set()
            await asyncio.gather(task, return_exceptions=True)
        assert terminal.is_set() and task.cancelled()
        assert boundary._preview_slot.acquire(blocking=False)
        boundary._preview_slot.release()
    asyncio.run(check())
