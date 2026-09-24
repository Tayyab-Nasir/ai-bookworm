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
    measuredTokens: list[dict[str, str]] | None = None

    def to_dict(self) -> dict:
        value = {
            "inputTokens": self.inputTokens,
            "outputTokens": self.outputTokens,
            "estimatedCostUsd": self.estimatedCostUsd,
        }
        if self.measuredTokens is not None:
            value["measuredTokens"] = self.measuredTokens
        return value


@dataclass
class Completion:
    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)  # [{"name":..., "input":{...}}]
    usage: Usage = field(default_factory=Usage)
    model: str | None = None
    # OpenAI's request identifier is the only provider receipt identifier the
    # paid worker may persist. Never substitute an internal job ID for it.
    request_id: str | None = None


class Provider(Protocol):
    name: str

    def complete(self, messages: list[dict], tools: list[dict], model: str, *,
                 max_output_tokens: int | None = None, tool_choice: dict | str | None = None) -> Completion:
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


class ProviderOutcomeUnknown(RuntimeError):
    """The paid request may have run; never silently dispatch it again."""


def openai_request(messages: list[dict], tools: list[dict], model: str, *,
                   max_output_tokens: int | None = None, tool_choice: dict | str | None = None) -> dict:
    """One wire representation for quote identity, counting, and generation."""
    payload = {"model": model, "input": messages, "tools": openai_tools(tools)}
    if max_output_tokens is not None:
        payload["max_output_tokens"] = max_output_tokens
    if tool_choice is not None:
        payload["tool_choice"] = tool_choice
    return payload


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str | None = None):
        import openai

        # An automatic retry after a lost paid response can generate twice.
        self._client = openai.OpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"], max_retries=0)

    def complete(self, messages: list[dict], tools: list[dict], model: str, *,
                 max_output_tokens: int | None = None, tool_choice: dict | str | None = None) -> Completion:
        payload = openai_request(messages, tools, model, max_output_tokens=max_output_tokens, tool_choice=tool_choice)
        try:
            resp = self._client.responses.create(**payload)
        except Exception as exc:
            import openai
            if isinstance(exc, openai.APIError):
                raise ProviderOutcomeUnknown("Paid provider outcome is unconfirmed.") from exc
            raise
        calls = []
        for item in resp.output:
            if item.type == "function_call":
                calls.append({"name": item.name, "input": json.loads(item.arguments or "{}")})
        ti = getattr(resp.usage, "input_tokens", None) if resp.usage else None
        to = getattr(resp.usage, "output_tokens", None) if resp.usage else None
        if any(type(value) is not int or value < 0 for value in (ti, to)):
            raise ProviderOutcomeUnknown("Paid provider token usage is unconfirmed.")
        details = getattr(resp.usage, "input_tokens_details", None) if resp.usage else None
        cached = getattr(details, "cached_tokens", None)
        measured = None
        if cached is not None and (type(cached) is not int or cached < 0 or cached > ti):
            raise ProviderOutcomeUnknown("Paid provider cached-token usage is unconfirmed.")
        if cached is not None:
            measured = [
                {"dimension": "text_input", "tokens": str(ti - cached)},
                {"dimension": "text_cached_input", "tokens": str(cached)},
                {"dimension": "text_output", "tokens": str(to)},
            ]
        return Completion(resp.output_text or "", calls, Usage(ti, to, _cost(model, ti, to), measured),
                          getattr(resp, "model", model), getattr(resp, "_request_id", None))


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

    def complete(self, messages: list[dict], tools: list[dict], model: str, *,
                 max_output_tokens: int | None = None, tool_choice: dict | str | None = None) -> Completion:
        self.calls.append({"messages": messages, "tools": tools, "model": model,
                           "maxOutputTokens": max_output_tokens, "toolChoice": tool_choice})
        c = self.responses[self._i % len(self.responses)]
        self._i += 1
        return completion_from_dict(c) if isinstance(c, dict) else c


def completion_from_dict(d: dict) -> Completion:
    return Completion(
        text=d.get("text", ""),
        tool_calls=d.get("toolCalls", d.get("tool_calls", [])),
        usage=Usage(**d.get("usage", {})),
        model=d.get("model"),
        request_id=d.get("requestId", d.get("request_id")),
    )


def openai_tools(tools: list[dict]) -> list[dict]:
    """Use identical function definitions for token counting and generation."""
    return [
        {"type": "function", "name": tool["name"], "description": tool.get("description", ""), "parameters": tool["input_schema"]}
        for tool in tools
    ]


_REGISTRY = {"openai": OpenAIProvider, "mock": MockProvider}
_DEFAULT_MODELS = {"openai": "gpt-6-astra", "mock": "mock-1"}


def get_provider(name: str | None = None) -> Provider:
    name = name or os.environ.get("DEFAULT_AI_PROVIDER") or "openai"
    if name not in _REGISTRY:
        raise ValueError(f"unknown AI provider {name!r}; expected one of {sorted(_REGISTRY)}")
    return _REGISTRY[name]()


def default_model(provider_name: str) -> str:
    return os.environ.get("DEFAULT_AI_MODEL") or _DEFAULT_MODELS.get(provider_name, "mock-1")
