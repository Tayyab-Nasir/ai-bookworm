"""Explicit, bounded embedding adapters. No key-triggered or mock fallback.

Private adapter only: funded dispatch, durable receipts and settlement must own
production use. It is not an enabled or billable author endpoint.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
from typing import Protocol

MAX_BATCH_ITEMS, MAX_INPUT_BYTES, MAX_BATCH_BYTES = 128, 8_000, 200_000


class EmbeddingConfigurationError(ValueError):
    pass


class EmbeddingOutcomeUnknown(RuntimeError):
    """A dispatched request may be billable; never automatically retry/refund."""


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def valid_dimension(dim: int) -> int:
    if type(dim) is not int or not 1 <= dim <= 65_536:
        raise EmbeddingConfigurationError("Embedding dimensions must be a bounded positive integer.")
    return dim


def valid_model(model: str) -> str:
    if not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}", model):
        raise EmbeddingConfigurationError("An explicit embedding model is required.")
    return model


def validate_inputs(texts: list[str]) -> None:
    if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_BATCH_ITEMS:
        raise ValueError("Embedding batch requires 1-128 inputs; split larger jobs before funding.")
    total = 0
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Embedding inputs must be non-empty text.")
        size = len(text.encode("utf-8"))
        if size > MAX_INPUT_BYTES:
            raise ValueError("Embedding input exceeds the bounded byte limit.")
        total += size
    if total > MAX_BATCH_BYTES:
        raise ValueError("Embedding batch exceeds the bounded byte limit.")


def request_hash(model: str, dim: int, texts: list[str]) -> str:
    return text_hash(json.dumps({"version": 1, "model": model, "dimensions": dim, "input": texts},
                                ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def validate_vector(vector, dim: int) -> tuple[float, ...]:
    if not isinstance(vector, (list, tuple)) or len(vector) != dim:
        raise ValueError("Embedding vector dimension differs.")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
        raise ValueError("Embedding vector must contain finite numbers.")
    norm = math.hypot(*vector)
    if not math.isfinite(norm) or norm == 0:
        raise ValueError("Embedding vector must have a finite non-zero norm.")
    return tuple(float(value) for value in vector)


@dataclass(frozen=True)
class EmbeddingReceipt:
    provider: str
    model: str
    dimensions: int
    input_sha256: str
    input_count: int
    prompt_tokens: int
    total_tokens: int
    request_id: str | None = None


@dataclass(frozen=True)
class EmbeddingBatch:
    vectors: tuple[tuple[float, ...], ...]
    receipt: EmbeddingReceipt


class Embedder(Protocol):
    dim: int
    model: str

    def embed(self, texts: list[str]) -> EmbeddingBatch: ...


class OpenAIEmbedder:
    name = "openai"

    def __init__(self, model: str | None = None, dim: int | None = None,
                 api_key: str | None = None, *, client=None):
        self.model = valid_model(model if model is not None else os.environ.get("EMBEDDING_MODEL", ""))
        try:
            self.dim = valid_dimension(dim if dim is not None else int(os.environ.get("EMBEDDING_DIM", "")))
        except (TypeError, ValueError):
            raise EmbeddingConfigurationError("Explicit embedding dimensions are required.") from None
        if client is None:
            if os.environ.get("EMBEDDING_API_ENABLED") != "true":
                raise EmbeddingConfigurationError("Paid embedding dispatch is disabled.")
            key = api_key or os.environ.get("OPENAI_API_KEY", "")
            if not key.strip():
                raise EmbeddingConfigurationError("Server-side OpenAI credentials are not configured.")
            import openai
            # The durable caller resolves ambiguous paid requests; no SDK replay.
            client = openai.OpenAI(api_key=key, max_retries=0, timeout=60.0)
        self._client = client

    def embed(self, texts: list[str]) -> EmbeddingBatch:
        validate_inputs(texts)
        digest = request_hash(self.model, self.dim, texts)
        try:
            response = self._client.embeddings.create(model=self.model, input=texts,
                                                       dimensions=self.dim, encoding_format="float")
            if response.model != self.model or response.object != "list" or len(response.data) != len(texts):
                raise ValueError("Embedding response identity/count differs.")
            vectors = [None] * len(texts)
            for item in response.data:
                if (type(item.index) is not int or not 0 <= item.index < len(texts)
                        or vectors[item.index] is not None or item.object != "embedding"):
                    raise ValueError("Embedding response indices differ.")
                vectors[item.index] = validate_vector(item.embedding, self.dim)
            usage = response.usage
            if (type(usage.prompt_tokens) is not int or type(usage.total_tokens) is not int
                    or not 1 <= usage.prompt_tokens <= 300_000 or usage.total_tokens != usage.prompt_tokens):
                raise ValueError("Embedding response usage requires reconciliation.")
            request_id = getattr(response, "_request_id", None)
            if request_id is not None and (not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,200}", request_id)):
                raise ValueError("Embedding request identity is invalid.")
            return EmbeddingBatch(tuple(vectors), EmbeddingReceipt(self.name, self.model, self.dim,
                digest, len(texts), usage.prompt_tokens, usage.total_tokens, request_id))
        except Exception:
            # No raw HTTP body, manuscript or credential-bearing error crosses.
            raise EmbeddingOutcomeUnknown("Embedding outcome requires receipt reconciliation; do not redispatch.") from None


class DeterministicMockEmbedder:
    """Explicit structural test fixture, not semantic quality or a production fallback."""
    name, model = "mock", "deterministic-mock-v1"

    def __init__(self, dim: int = 1536):
        self.dim = valid_dimension(dim)

    def embed(self, texts: list[str]) -> EmbeddingBatch:
        validate_inputs(texts)
        return EmbeddingBatch(tuple(self._vec(text) for text in texts),
            EmbeddingReceipt(self.name, self.model, self.dim, request_hash(self.model, self.dim, texts), len(texts), 0, 0))

    def _vec(self, text: str) -> tuple[float, ...]:
        out, block = [], b""
        while len(out) < self.dim:
            block = hashlib.sha256(block + text.encode("utf-8")).digest()
            out.extend((byte - 128) / 128.0 for byte in block)
        out = out[:self.dim]
        norm = math.hypot(*out) or 1.0
        return tuple(value / norm for value in out)


def get_embedder(name: str | None = None) -> Embedder:
    selected = name if name is not None else os.environ.get("EMBEDDING_PROVIDER")
    if selected == "openai":
        return OpenAIEmbedder()
    if selected == "mock" and os.environ.get("NODE_ENV") == "test":
        return DeterministicMockEmbedder()
    raise EmbeddingConfigurationError("Select an explicit supported embedding provider; mock is test-only.")
