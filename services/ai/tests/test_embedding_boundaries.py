"""OpenAI embedding transport/usage checks with synthetic responses only."""
import copy
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from rag.embeddings import (EmbeddingConfigurationError, EmbeddingOutcomeUnknown,
                            OpenAIEmbedder, get_embedder, request_hash)

MODEL = "text-embedding-3-small"


def response():
    return NS(object="list", model=MODEL, _request_id="req_synthetic",
              data=[NS(index=1, object="embedding", embedding=[0.0, 1.0]),
                    NS(index=0, object="embedding", embedding=[1.0, 0.0])],
              usage=NS(prompt_tokens=8, total_tokens=8))


def fixture(result=None):
    calls = []

    def create(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if isinstance(result, Exception):
            raise result
        return result if result is not None else response()

    return OpenAIEmbedder(model=MODEL, dim=2, client=NS(embeddings=NS(create=create))), calls


def test_reorders_provider_indices_and_retains_bound_usage_receipt():
    embedder, calls = fixture()
    batch = embedder.embed(["one", "two"])
    assert batch.vectors == ((1.0, 0.0), (0.0, 1.0))
    assert calls == [{"model": MODEL, "input": ["one", "two"], "dimensions": 2, "encoding_format": "float"}]
    assert batch.receipt.provider == "openai"
    assert batch.receipt.prompt_tokens == batch.receipt.total_tokens == 8
    assert batch.receipt.input_sha256 == request_hash(MODEL, 2, ["one", "two"])
    assert batch.receipt.request_id == "req_synthetic"
    assert "one" not in repr(batch.receipt) and "two" not in repr(batch.receipt)


@pytest.mark.parametrize("change", [
    lambda r: setattr(r, "model", "unexpected-model"),
    lambda r: setattr(r, "object", "other"),
    lambda r: r.data.pop(),
    lambda r: r.data.append(r.data[0]),
    lambda r: setattr(r.data[0], "index", 0),
    lambda r: setattr(r.data[0], "index", True),
    lambda r: setattr(r.data[0], "index", -1),
    lambda r: setattr(r.data[0], "index", 2),
    lambda r: setattr(r.data[0], "object", "other"),
    lambda r: setattr(r.data[0], "embedding", [1.0]),
    lambda r: setattr(r.data[0], "embedding", [0.0, 0.0]),
    lambda r: setattr(r.data[0], "embedding", [float("nan"), 1.0]),
    lambda r: setattr(r.data[0], "embedding", [float("inf"), 1.0]),
    lambda r: setattr(r.data[0], "embedding", [True, 1.0]),
    lambda r: setattr(r.data[0], "embedding", ["1", 1.0]),
    lambda r: setattr(r.usage, "prompt_tokens", True),
    lambda r: setattr(r.usage, "prompt_tokens", 0),
    lambda r: setattr(r.usage, "total_tokens", 7),
    lambda r: setattr(r, "usage", None),
    lambda r: setattr(r, "_request_id", "unsafe\nrequest"),
])
def test_invalid_paid_response_is_uncertain_and_never_retried(change):
    result = response()
    change(result)
    embedder, calls = fixture(result)
    with pytest.raises(EmbeddingOutcomeUnknown, match="do not redispatch"):
        embedder.embed(["one", "two"])
    assert len(calls) == 1


@pytest.mark.parametrize("texts", [[], "one", [""], ["   "], [None], ["x"] * 129,
                                    ["x" * 8001], ["🦉" * 2001], ["x" * 8000] * 26])
def test_invalid_input_does_not_dispatch(texts):
    embedder, calls = fixture()
    with pytest.raises(ValueError):
        embedder.embed(texts)
    assert calls == []


def test_provider_exception_is_redacted_and_uncertain():
    embedder, calls = fixture(TimeoutError("Private manuscript and credential-bearing URL"))
    with pytest.raises(EmbeddingOutcomeUnknown) as error:
        embedder.embed(["one", "two"])
    assert "Private" not in str(error.value) and len(calls) == 1
    assert error.value.__suppress_context__ is True


@pytest.mark.parametrize("dim", [0, -1, True, 1.5, 65_537])
def test_invalid_dimensions_rejected(dim):
    with pytest.raises(EmbeddingConfigurationError):
        OpenAIEmbedder(model=MODEL, dim=dim, client=object())


def test_key_presence_neither_enables_paid_calls_nor_selects_fake_provider(monkeypatch):
    for key in ["EMBEDDING_PROVIDER", "EMBEDDING_API_ENABLED", "EMBEDDING_MODEL", "EMBEDDING_DIM"]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-not-a-real-key")
    with pytest.raises(EmbeddingConfigurationError):
        get_embedder()
    with pytest.raises(EmbeddingConfigurationError, match="disabled"):
        OpenAIEmbedder(model=MODEL, dim=2)
    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(EmbeddingConfigurationError):
        get_embedder("mock")
    monkeypatch.setenv("NODE_ENV", "test")
    assert get_embedder("mock").name == "mock"


def test_real_sdk_configuration_has_no_automatic_retry(monkeypatch):
    import openai
    calls = []
    monkeypatch.setenv("EMBEDDING_API_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-not-a-real-key")
    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: calls.append(kwargs) or object())
    OpenAIEmbedder(model=MODEL, dim=2)
    assert calls[0]["max_retries"] == 0 and calls[0]["timeout"] == 60.0


def test_missing_model_is_not_replaced_with_an_unapproved_default(monkeypatch):
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    with pytest.raises(EmbeddingConfigurationError):
        OpenAIEmbedder(dim=2, client=object())


@pytest.mark.parametrize("status", [200, 429, 500])
def test_actual_openai_sdk_uses_one_mock_http_dispatch(monkeypatch, status):
    """Real SDK serialization/errors, intercepted locally; no external requests."""
    import json
    import httpx
    import openai

    requests = []

    def respond(request):
        requests.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "Private upstream body", "type": "synthetic"}})
        return httpx.Response(200, headers={"x-request-id": "req_local_mock"}, json={
            "object": "list", "model": MODEL,
            "data": [{"object": "embedding", "index": 1, "embedding": [0.0, 1.0]},
                     {"object": "embedding", "index": 0, "embedding": [1.0, 0.0]}],
            "usage": {"prompt_tokens": 8, "total_tokens": 8}})

    real_client = openai.OpenAI
    with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
        monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: real_client(
            **kwargs, base_url="https://synthetic.invalid/v1", http_client=transport))
        monkeypatch.setenv("EMBEDDING_API_ENABLED", "true")
        monkeypatch.setenv("OPENAI_API_KEY", "synthetic-not-a-real-key")
        embedder = OpenAIEmbedder(model=MODEL, dim=2)
        if status == 200:
            batch = embedder.embed(["one", "two"])
            assert batch.vectors == ((1.0, 0.0), (0.0, 1.0))
            assert batch.receipt.request_id == "req_local_mock"
        else:
            with pytest.raises(EmbeddingOutcomeUnknown) as error:
                embedder.embed(["one", "two"])
            assert "Private" not in str(error.value)
        assert len(requests) == 1
        assert requests[0].url.path == "/v1/embeddings"
        assert json.loads(requests[0].content) == {
            "model": MODEL, "input": ["one", "two"], "dimensions": 2, "encoding_format": "float"}
