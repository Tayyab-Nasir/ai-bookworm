"""OpenAI LLM gateway with an explicit deterministic test provider."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


@dataclass
class Usage:
    inputTokens: int = 0
    outputTokens: int = 0
    estimatedCostUsd: float = 0.0

    def to_dict(self) -> dict:
        return {
            "inputTokens": self.inputTokens,
            "outputTokens": self.outputTokens,
            "estimatedCostUsd": self.estimatedCostUsd,
        }


@dataclass
class Completion:
    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)  # [{"name":..., "input":{...}}]
    usage: Usage = field(default_factory=Usage)


class Provider(Protocol):
    name: str

    def complete(self, messages: list[dict], tools: list[dict], model: str) -> Completion:
        ...


# Official OpenAI price snapshot, 2026-09-12. Values are dollars per token.
# Keep this deliberately exact: an unknown model records zero rather than being
# silently billed with a stale prefix-wide estimate.
_TEXT_PRICES: dict[str, tuple[float, float]] = {
    "gpt-6-astra": (10.0e-6, 50.0e-6),
}


def _cost(model: str, tokens_in: int, tokens_out: int) -> float:
    canonical = "gpt-6-astra" if model.startswith("gpt-6-astra") else model
    if canonical in _TEXT_PRICES:
        pi, po = _TEXT_PRICES[canonical]
        # Astra requests above 272K input tokens use the published long-context
        # multipliers for the entire request.
        if canonical == "gpt-6-astra" and tokens_in > 272_000:
            pi, po = pi * 2, po * 1.5
        return round(tokens_in * pi + tokens_out * po, 6)
    return 0.0


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str | None = None):
        import openai

        self._client = openai.OpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"])

    def complete(self, messages: list[dict], tools: list[dict], model: str) -> Completion:
        resp = self._client.responses.create(
            model=model,
            input=messages,
            tools=[
                {"type": "function", "name": t["name"], "description": t.get("description", ""), "parameters": t["input_schema"]}
                for t in tools
            ],
        )
        calls = []
        for item in resp.output:
            if item.type == "function_call":
                calls.append({"name": item.name, "input": json.loads(item.arguments or "{}")})
        ti = resp.usage.input_tokens if resp.usage else 0
        to = resp.usage.output_tokens if resp.usage else 0
        return Completion(resp.output_text or "", calls, Usage(ti, to, _cost(model, ti, to)))


class MockProvider:
    """Deterministic canned responses for tests/evals. Cycles through `responses`."""

    name = "mock"

    def __init__(self, responses: list[Completion | dict] | None = None):
        self.responses: list[Completion | dict] = list(responses or [Completion()])
        self.calls: list[dict] = []  # captured (messages, tools, model) for assertions
        self._i = 0

    @classmethod
    def from_fixture(cls, path: str | Path) -> "MockProvider":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        responses = data if isinstance(data, list) else [data]
        return cls(responses)

    def complete(self, messages: list[dict], tools: list[dict], model: str) -> Completion:
        self.calls.append({"messages": messages, "tools": tools, "model": model})
        c = self.responses[self._i % len(self.responses)]
        self._i += 1
        return completion_from_dict(c) if isinstance(c, dict) else c


def completion_from_dict(d: dict) -> Completion:
    return Completion(
        text=d.get("text", ""),
        tool_calls=d.get("toolCalls", d.get("tool_calls", [])),
        usage=Usage(**d.get("usage", {})),
    )


_REGISTRY = {"openai": OpenAIProvider, "mock": MockProvider}
_DEFAULT_MODELS = {"openai": "gpt-6-astra", "mock": "mock-1"}


def get_provider(name: str | None = None) -> Provider:
    name = name or os.environ.get("DEFAULT_AI_PROVIDER") or "openai"
    if name not in _REGISTRY:
        raise ValueError(f"unknown AI provider {name!r}; expected one of {sorted(_REGISTRY)}")
    return _REGISTRY[name]()


def default_model(provider_name: str) -> str:
    return os.environ.get("DEFAULT_AI_MODEL") or _DEFAULT_MODELS.get(provider_name, "mock-1")
