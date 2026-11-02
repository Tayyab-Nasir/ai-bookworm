"""A compressed PDF must not expand unchecked, including while reading xrefs."""
import base64
import importlib.util
import io
import sys
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter, get_configuration
from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from parsers import ParseError
from parsers.pdf_parser import _PDF_DECODE_LIMIT, parse_pdf


def oversized_content_pdf():
    writer = PdfWriter()
    writer.add_blank_page(100, 100)
    stream = DecodedStreamObject()
    stream.set_data(b' ' * (_PDF_DECODE_LIMIT + 1))
    writer.pages[0][NameObject('/Contents')] = writer._add_object(stream.flate_encode())
    writer.pages[0]['/Resources'][NameObject('/ProcSet')] = ArrayObject([NameObject('/PDF')])
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def oversized_xref_pdf():
    compressed = zlib.compress(b' ' * (_PDF_DECODE_LIMIT + 1))
    header = b'%PDF-1.5\n'
    stream = (b'1 0 obj\n<< /Type /XRef /Size 1 /W [1 4 2] /Length '
              + str(len(compressed)).encode() + b' /Filter /FlateDecode >>\nstream\n'
              + compressed + b'\nendstream\nendobj\nstartxref\n'
              + str(len(header)).encode() + b'\n%%EOF\n')
    return header + stream


@pytest.mark.parametrize('pdf', [oversized_content_pdf, oversized_xref_pdf])
def test_untrusted_stream_exceeding_limit_fails_and_context_is_reset(pdf):
    original = get_configuration()
    with pytest.raises(ParseError, match='Limit reached while decompressing'):
        parse_pdf(pdf())
    assert get_configuration() == original


def test_http_rejects_oversized_content_stream(monkeypatch):
    spec = importlib.util.spec_from_file_location('pdf_limits_http', SERVICE / 'main.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv('DOCUMENT_SERVICE_TOKEN', 'synthetic-pdf-limit-test')
    with TestClient(module.app) as client:
        response = client.post('/parse', headers={'x-service-token': 'synthetic-pdf-limit-test'}, json={
            'assetId': 'synthetic', 'format': 'pdf',
            'contentBase64': base64.b64encode(oversized_content_pdf()).decode()})
    assert response.status_code == 422
    assert 'Limit reached while decompressing' in response.json()['detail']
