"""Check EPUB identification against local ZIP headers, not directory order."""
import io
import struct
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rules.core_v1 import check_mimetype_first


def archive(entries, *, extra=b""):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as writer:
        for name in entries:
            info = zipfile.ZipInfo(name)
            if name == "mimetype":
                info.extra = extra
            writer.writestr(info, b"application/epub+zip" if name == "mimetype" else b"content")
    return output.getvalue()


def directory_entries(data):
    end = data.rfind(b"PK\x05\x06")
    size, offset = struct.unpack_from("<II", data, end + 12)
    entries = []
    position = offset
    while position < offset + size:
        assert data[position:position + 4] == b"PK\x01\x02"
        name, extra, comment = struct.unpack_from("<HHH", data, position + 28)
        length = 46 + name + extra + comment
        entries.append(data[position:position + length])
        position += length
    assert position == offset + size
    return end, offset, size, entries


def reversed_directory(data):
    end, offset, size, entries = directory_entries(data)
    assert len(entries) == 2
    return data[:offset] + b"".join(reversed(entries)) + data[end:]


def codes(data):
    return [finding.code for finding in check_mimetype_first({"artifact": data})]


def test_physical_mimetype_first_is_accepted_regardless_of_directory_order():
    data = archive(["mimetype", "other.txt"])
    assert codes(data) == []
    assert codes(reversed_directory(data)) == []


def test_reordered_directory_cannot_hide_nonfirst_physical_mimetype():
    data = reversed_directory(archive(["other.txt", "mimetype"]))
    assert zipfile.ZipFile(io.BytesIO(data)).infolist()[0].filename == "mimetype"
    assert codes(data) == ["MIMETYPE"]


def test_prefixed_zip_is_not_an_epub_with_mimetype_at_byte_zero():
    data = b"prefix" + archive(["mimetype", "other.txt"])
    assert zipfile.ZipFile(io.BytesIO(data)).infolist()[0].header_offset == 6
    assert codes(data) == ["MIMETYPE"]


@pytest.mark.parametrize("location", ["both", "local", "central"])
def test_mimetype_extra_field_is_rejected_in_both_headers(location):
    extra = b"\x34\x12\x00\x00"  # syntactically valid unknown extra field
    data = archive(["mimetype"], extra=extra if location != "central" else b"")
    end, offset, size, entries = directory_entries(data)
    entry = bytearray(entries[0])
    name_length = struct.unpack_from("<H", entry, 28)[0]
    if location == "local":
        struct.pack_into("<H", entry, 30, 0)
        entry = entry[:46 + name_length] + entry[46 + name_length + len(extra):]
    elif location == "central":
        struct.pack_into("<H", entry, 30, len(extra))
        entry = entry[:46 + name_length] + extra + entry[46 + name_length:]
    adjusted = bytearray(data[:offset] + bytes(entry) + data[end:])
    new_end = len(adjusted) - 22
    struct.pack_into("<I", adjusted, new_end + 12, len(entry))
    with zipfile.ZipFile(io.BytesIO(adjusted)) as parsed:
        assert parsed.read("mimetype") == b"application/epub+zip"
    assert codes(bytes(adjusted)) == ["MIMETYPE"]


def test_different_local_and_central_flags_are_rejected():
    data = bytearray(archive(["mimetype"]))
    struct.pack_into("<H", data, 6, 0x0800)
    with zipfile.ZipFile(io.BytesIO(data)) as parsed:
        assert parsed.read("mimetype") == b"application/epub+zip"
    assert codes(bytes(data)) == ["MIMETYPE"]
