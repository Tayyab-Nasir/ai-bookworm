"""Provider-neutral LLM gateway (spec section 12 / T16).

Providers are swappable via config (DEFAULT_AI_PROVIDER / DEFAULT_AI_MODEL env).
Every complete() returns a Completion carrying per-call usage telemetry.
"""
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


# ponytail: rough static $/token table by model prefix; refresh on pricing changes
_PRICES: dict[str, tuple[float, float]] = {
    "claude": (3.0e-6, 15.0e-6),
    "gpt": (2.5e-6, 10.0e-6),
    "mock": (0.0, 0.0),
}


def _cost(model: str, tokens_in: int, tokens_out: int) -> float:
    for prefix, (pi, po) in _PRICES.items():
        if model.startswith(prefix):
            return round(tokens_in * pi + tokens_out * po, 6)
    return 0.0


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str | None = None):
        import anthropic

        self._client = anthropic.Anthropic(api_key=api_key or os.environ["ANTHROPIC_API_KEY"])

    def complete(self, messages: list[dict], tools: list[dict], model: str) -> Completion:
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        convo = [m for m in messages if m["role"] != "system"]
        resp = self._client.messages.create(
            model=model,
            max_tokens=4096,
            system=system,
            messages=convo,
            tools=[
                {"name": t["name"], "description": t.get("description", ""), "input_schema": t["input_schema"]}
                for t in tools
            ],
        )
        text, calls = "", []
        for block in resp.content:
            if block.type == "text":
                text += block.text
            elif block.type == "tool_use":
                calls.append({"name": block.name, "input": block.input})
        ti, to = resp.usage.input_tokens, resp.usage.output_tokens
        return Completion(text, calls, Usage(ti, to, _cost(model, ti, to)))


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str | None = None):
        import openai

        self._client = openai.OpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"])

    def complete(self, messages: list[dict], tools: list[dict], model: str) -> Completion:
        resp = self._client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[
                {"type": "function", "function": {"name": t["name"], "description": t.get("description", ""), "parameters": t["input_schema"]}}
                for t in tools
            ],
        )
        msg = resp.choices[0].message
        calls = [
            {"name": tc.function.name, "input": json.loads(tc.function.arguments or "{}")}
            for tc in (msg.tool_calls or [])
        ]
        ti = resp.usage.prompt_tokens if resp.usage else 0
        to = resp.usage.completion_tokens if resp.usage else 0
        return Completion(msg.content or "", calls, Usage(ti, to, _cost(model, ti, to)))


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


_REGISTRY = {"anthropic": AnthropicProvider, "openai": OpenAIProvider, "mock": MockProvider}
_DEFAULT_MODELS = {"anthropic": "claude-sonnet-4-5", "openai": "gpt-4o", "mock": "mock-1"}


def get_provider(name: str | None = None) -> Provider:
    name = name or os.environ.get("DEFAULT_AI_PROVIDER", "")
    if not name:
        if os.environ.get("ANTHROPIC_API_KEY"):
            name = "anthropic"
        elif os.environ.get("OPENAI_API_KEY"):
            name = "openai"
        else:
            name = "mock"
    if name not in _REGISTRY:
        raise ValueError(f"unknown AI provider {name!r}; expected one of {sorted(_REGISTRY)}")
    return _REGISTRY[name]()


def default_model(provider_name: str) -> str:
    return os.environ.get("DEFAULT_AI_MODEL") or _DEFAULT_MODELS.get(provider_name, "mock-1")
