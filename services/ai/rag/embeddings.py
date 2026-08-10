"""Embedding providers (Step 8), mirroring gateway.py's swappable pattern.

OpenAI text-embedding when OPENAI_API_KEY is present, deterministic mock
otherwise so tests/dev need no credentials. Vector dim is config
(EMBEDDING_DIM), not business logic.
"""
from __future__ import annotations

import hashlib
import math
import os
from typing import Protocol


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Embedder(Protocol):
    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class OpenAIEmbedder:
    name = "openai"

    def __init__(self, model: str | None = None, dim: int | None = None, api_key: str | None = None):
        import openai

        self._client = openai.OpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"])
        self.model = model or os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
        self.dim = dim or int(os.environ.get("EMBEDDING_DIM", "1536"))

    def embed(self, texts: list[str]) -> list[list[float]]:
        resp = self._client.embeddings.create(model=self.model, input=texts, dimensions=self.dim)
        return [d.embedding for d in resp.data]


class DeterministicMockEmbedder:
    """Hashes each text into a fixed-dim unit vector. Stable across runs — for tests/evals."""

    name = "mock"

    def __init__(self, dim: int | None = None):
        self.dim = dim or int(os.environ.get("EMBEDDING_DIM", "1536"))

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def _vec(self, text: str) -> list[float]:
        out: list[float] = []
        block = b""
        while len(out) < self.dim:  # chain sha256 blocks until dim is filled
            block = hashlib.sha256(block + text.encode("utf-8")).digest()
            out.extend((b - 128) / 128.0 for b in block)
        out = out[: self.dim]
        norm = math.sqrt(sum(x * x for x in out)) or 1.0
        return [x / norm for x in out]


_REGISTRY = {"openai": OpenAIEmbedder, "mock": DeterministicMockEmbedder}


def get_embedder(name: str | None = None) -> Embedder:
    name = name or os.environ.get("EMBEDDING_PROVIDER") or ("openai" if os.environ.get("OPENAI_API_KEY") else "mock")
    if name not in _REGISTRY:
        raise ValueError(f"unknown embedding provider {name!r}; expected one of {sorted(_REGISTRY)}")
    return _REGISTRY[name]()
