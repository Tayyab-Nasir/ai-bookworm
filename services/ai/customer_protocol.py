"""Bounded, text-only wire contracts for explicitly authorized customer keys.

No pricing, credentials, model discovery, HTTP routes or fallback live here.
The caller must supply a reviewed model policy and bind this exact request to
its own payer/job authorization before resolving a credential. See the checkpoint.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field

from jsonschema import Draft202012Validator, FormatChecker

from gateway import Completion, Usage

PROVIDERS = frozenset({"openai", "anthropic", "google", "openrouter", "xai"})
MAX_BYTES = 1_048_576
MAX_COUNTER = 100_000_000
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,63}\Z")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\Z")


class CustomerRequestError(ValueError):
    """Safe pre-dispatch error. Never include submitted data or credentials."""


def _check(condition: bool) -> None:
    if not condition:
        raise ValueError("Unsupported customer-provider contract.")


def _json_tree(value, depth: int = 0) -> None:
    _check(depth <= 32)
    if type(value) is dict:
        _check(all(type(key) is str for key in value))
        for item in value.values():
            _json_tree(item, depth + 1)
    elif type(value) is list:
        for item in value:
            _json_tree(item, depth + 1)
    elif type(value) is float:
        _check(math.isfinite(value))
    else:
        _check(value is None or type(value) in (str, int, bool))


def json_bytes(value) -> bytes:
    _json_tree(value)
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    _check(len(data) <= MAX_BYTES)
    return data


def strict_json(data: bytes | str) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            _check(key not in result)
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("Unsupported JSON number.")

    _check(len(data.encode("utf-8") if isinstance(data, str) else data) <= MAX_BYTES)
    value = json.loads(data.decode("utf-8") if isinstance(data, bytes) else data,
                       object_pairs_hook=pairs, parse_constant=invalid_constant)
    _check(type(value) is dict)
    _json_tree(value)
    return value


@dataclass(frozen=True)
class ModelPolicy:
    """Server-owned exact model/route allowlist, never inferred from prefixes."""

    model: str
    response_models: tuple[str, ...]
    max_output_tokens: int
    upstream: str | None = None  # OpenRouter request slug
    response_upstreams: tuple[str, ...] = ()  # exact response display names

    def __post_init__(self):
        valid = (
            type(self.model) is str and _MODEL.fullmatch(self.model)
            and type(self.response_models) is tuple and 1 <= len(self.response_models) <= 16
            and all(type(m) is str and _MODEL.fullmatch(m) for m in self.response_models)
            and type(self.max_output_tokens) is int and 1 <= self.max_output_tokens <= 128_000
            and type(self.response_upstreams) is tuple and len(self.response_upstreams) <= 16
            and all(type(p) is str and 1 <= len(p) <= 100 and p.isascii() and p.isprintable() for p in self.response_upstreams)
            and (self.upstream is None or (type(self.upstream) is str and _MODEL.fullmatch(self.upstream)))
        )
        if not valid:
            raise CustomerRequestError("A reviewed exact model policy is required.")


@dataclass(frozen=True)
class PreparedRequest:
    provider: str
    url: str
    body: bytes = field(repr=False)
    policy: ModelPolicy
    output_limit: int
    schemas: bytes = field(repr=False)
    choice: str  # auto, required, none, or an exact function name

    @property
    def sha256(self) -> str:
        # Domain separation prevents an identical OpenAI/xAI body from sharing
        # identity. Bind response allowlists too, not just the generation input.
        identity = json_bytes({"format": "customer-text-v1", "provider": self.provider, "url": self.url,
                               "models": list(self.policy.response_models),
                               "upstreams": list(self.policy.response_upstreams)})
        return hashlib.sha256(identity + b"\0" + self.body).hexdigest()


def _schemas_safe(value) -> None:
    if isinstance(value, dict):
        # Current Bookworm function schemas are inline. Refuse all resolution,
        # including remote $schema dialect selection and recursive references.
        _check(not any(key in value for key in ("$ref", "$dynamicRef", "$recursiveRef", "$schema")))
        for item in value.values():
            _schemas_safe(item)
    elif isinstance(value, list):
        for item in value:
            _schemas_safe(item)


def prepare_customer_request(provider: str, policy: ModelPolicy, messages: list[dict], tools: list[dict], model: str, *,
                             max_output_tokens: int | None, tool_choice: dict | str | None = None) -> PreparedRequest:
    """Validate locally and freeze one request, with no network or key access."""
    try:
        _check(provider in PROVIDERS and type(policy) is ModelPolicy and model == policy.model)
        _check(type(max_output_tokens) is int and 1 <= max_output_tokens <= policy.max_output_tokens)
        # Snapshot before validation; no caller-owned mutable data is retained.
        source = strict_json(json_bytes({"messages": messages, "tools": tools, "choice": tool_choice}))
        messages, tools, tool_choice = source["messages"], source["tools"], source["choice"]
        _check(type(messages) is list and 1 <= len(messages) <= 64)
        for index, message in enumerate(messages):
            _check(type(message) is dict and set(message) == {"role", "content"})
            _check(message["role"] in ("system", "user", "assistant"))
            _check(message["role"] != "system" or index == 0)
            _check(type(message["content"]) is str and bool(message["content"].strip()))
        conversation = messages[1:] if messages[0]["role"] == "system" else messages
        _check(bool(conversation) and conversation[0]["role"] == conversation[-1]["role"] == "user")
        _check(all(m["role"] == ("user" if i % 2 == 0 else "assistant") for i, m in enumerate(conversation)))
        _check(type(tools) is list and len(tools) <= 16)
        names = set()
        for tool in tools:
            _check(type(tool) is dict and set(tool) <= {"name", "description", "input_schema"})
            name, schema = tool.get("name"), tool.get("input_schema")
            _check(type(name) is str and bool(_NAME.fullmatch(name)) and name not in names)
            _check(name not in ("auto", "required", "none"))
            _check(type(tool.get("description", "")) is str and len(tool.get("description", "")) <= 16_000)
            _check(type(schema) is dict and schema.get("type") == "object")
            _schemas_safe(schema)
            Draft202012Validator.check_schema(schema)
            names.add(name)
        if isinstance(tool_choice, dict):
            _check(set(tool_choice) == {"type", "name"} and tool_choice["type"] == "function" and tool_choice["name"] in names)
            choice = tool_choice["name"]
        else:
            _check(tool_choice in (None, "auto", "required", "none"))
            choice = tool_choice or "auto"
        _check(bool(tools) or choice in ("auto", "none"))
        selected = [t for t in tools if choice in ("auto", "required") or t["name"] == choice]
        if choice == "none":
            selected = []
        function_tools = [{"type": "function", "name": t["name"], "description": t.get("description", ""),
                           "parameters": t["input_schema"], "strict": False} for t in selected]
        if provider in ("openai", "xai"):
            url = {"openai": "https://api.openai.com/v1/responses", "xai": "https://api.x.ai/v1/responses"}[provider]
            payload = {"model": model, "input": messages, "tools": function_tools, "max_output_tokens": max_output_tokens,
                       "stream": False, "store": False,
                       "tool_choice": tool_choice if isinstance(tool_choice, dict) else choice}
        elif provider == "anthropic":
            url = "https://api.anthropic.com/v1/messages"
            payload = {"model": model, "messages": conversation, "max_tokens": max_output_tokens, "stream": False}
            if messages[0]["role"] == "system":
                payload["system"] = messages[0]["content"]
            if selected:
                payload["tools"] = selected
                # Current Claude models may reject forced tool_choice. Advertise
                # only the selected tool and validate the required result below;
                # a refusal/absence is review-required, never an automatic retry.
                payload["tool_choice"] = {"type": "auto"}
        elif provider == "google":
            _check(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", model)))
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            payload = {"contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]} for m in conversation],
                       "generationConfig": {"maxOutputTokens": max_output_tokens, "candidateCount": 1}}
            if messages[0]["role"] == "system":
                payload["systemInstruction"] = {"parts": [{"text": messages[0]["content"]}]}
            if selected:
                payload["tools"] = [{"functionDeclarations": [{"name": t["name"], "description": t.get("description", ""),
                                                               "parametersJsonSchema": t["input_schema"]} for t in selected]}]
                config = {"mode": "AUTO" if choice == "auto" else "ANY"}
                if choice not in ("auto", "required"):
                    config["allowedFunctionNames"] = [choice]
                payload["toolConfig"] = {"functionCallingConfig": config}
        else:
            _check(bool(policy.upstream) and bool(policy.response_upstreams))
            url = "https://openrouter.ai/api/v1/chat/completions"
            payload = {"model": model, "messages": messages, "max_tokens": max_output_tokens, "stream": False,
                       "provider": {"order": [policy.upstream], "only": [policy.upstream], "allow_fallbacks": False,
                                    "require_parameters": True, "data_collection": "deny"}}
            if selected:
                payload["tools"] = [{"type": "function", "function": {k: v for k, v in t.items() if k != "type"}} for t in function_tools]
                payload["tool_choice"] = {"type": "function", "function": {"name": choice}} if choice not in ("auto", "required") else choice
        if provider != "openrouter":
            _check(policy.upstream is None and not policy.response_upstreams)
        return PreparedRequest(provider, url, json_bytes(payload), policy, max_output_tokens,
                               json_bytes({t["name"]: t["input_schema"] for t in selected}), choice)
    except Exception:
        raise CustomerRequestError("Customer-provider request failed local validation.") from None


def _count(value) -> int:
    _check(type(value) is int and 0 <= value <= MAX_COUNTER)
    return value


def _observed(source: dict, target: dict, name: str, *, maximum: int | None = None, prefix: str = "") -> int | None:
    if name not in source:
        return None
    value = _count(source[name])
    _check(maximum is None or value <= maximum)
    target[prefix + name] = value
    return value


def _details(usage: dict, name: str) -> dict:
    details = usage.get(name, {})
    _check(type(details) is dict)
    return details


def _no_tools(value: dict) -> None:
    _check(type(value) is dict and all(_count(n) == 0 for n in value.values()))


def _usage(provider: str, usage: dict) -> Usage:
    _check(type(usage) is dict)
    observed = {}
    if provider == "anthropic":
        ti, to = _count(usage.get("input_tokens")), _count(usage.get("output_tokens"))
        created, cached = _count(usage.get("cache_creation_input_tokens")), _count(usage.get("cache_read_input_tokens"))
        observed.update(input_tokens=ti, output_tokens=to, cache_creation_input_tokens=created, cache_read_input_tokens=cached)
        ti += created + cached
        if "cache_creation" in usage:
            detail = _details(usage, "cache_creation")
            _check(set(detail) == {"ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"})
            _check(sum(_count(n) for n in detail.values()) == created)
            observed.update({"cache_creation." + key: value for key, value in detail.items()})
        _observed(_details(usage, "output_tokens_details"), observed, "thinking_tokens", maximum=to, prefix="output_tokens_details.")
        if "server_tool_use" in usage:
            _no_tools(usage["server_tool_use"])
    elif provider == "google":
        ti, visible, total = (_count(usage.get(k)) for k in ("promptTokenCount", "candidatesTokenCount", "totalTokenCount"))
        # Protobuf may omit a zero thoughts counter. If absent we require the
        # total to explain no hidden tokens, not invent a reported zero counter.
        thoughts = _observed(usage, observed, "thoughtsTokenCount")
        tool_input = _observed(usage, observed, "toolUsePromptTokenCount")
        _check(tool_input in (None, 0) and total == ti + visible + (thoughts or 0))
        to = visible + (thoughts or 0)
        observed.update(promptTokenCount=ti, candidatesTokenCount=visible, totalTokenCount=total)
        _observed(usage, observed, "cachedContentTokenCount", maximum=ti)
        for key, bound in (("promptTokensDetails", ti), ("cacheTokensDetails", ti), ("candidatesTokensDetails", visible), ("toolUsePromptTokensDetails", 0)):
            if key in usage:
                details = usage[key]
                _check(type(details) is list and len(details) <= 1)
                for detail in details:
                    _check(type(detail) is dict and detail.get("modality") == "TEXT" and _count(detail.get("tokenCount")) <= bound)
    else:
        inp, out = ("prompt_tokens", "completion_tokens") if provider == "openrouter" else ("input_tokens", "output_tokens")
        ti, to, total = (_count(usage.get(k)) for k in (inp, out, "total_tokens"))
        _check(total == ti + to)
        observed.update({inp: ti, out: to, "total_tokens": total})
        inputs, outputs = _details(usage, inp + "_details"), _details(usage, out + "_details")
        _observed(inputs, observed, "cached_tokens", maximum=ti, prefix=inp + "_details.")
        _observed(outputs, observed, "reasoning_tokens", maximum=to, prefix=out + "_details.")
        # Reasoning is already included in completion/output_tokens. Never add
        # it a second time or interpret media/prediction usage as ordinary text.
        for details in (inputs, outputs):
            for key in ("audio_tokens", "image_tokens", "video_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"):
                if key in details:
                    _check(_count(details[key]) == 0)
        for key in ("num_sources_used", "num_server_side_tools_used"):
            if key in usage:
                _check(_count(usage[key]) == 0)
        if "server_tool_use_details" in usage:
            _no_tools(usage["server_tool_use_details"])
    _check(ti <= MAX_COUNTER and to <= MAX_COUNTER)
    # These counters are provider evidence, NOT the managed-AI credit pricing
    # dimensions. No approved BYOK fee/rate contract exists yet; unknown != free.
    return Usage(ti, to, None, providerTokenUsage=observed)


def parse_customer_response(request: PreparedRequest, data: dict, request_id: str | None = None) -> Completion:
    """Validate the entire completion before returning any reviewable output."""
    provider = request.provider
    _check(type(data) is dict)
    model = data.get("modelVersion" if provider == "google" else "model")
    _check(model in request.policy.response_models)
    response_id = data.get("responseId" if provider == "google" else "id")
    _check(type(response_id) is str and bool(_ID.fullmatch(response_id)))
    _check(request_id is None or (type(request_id) is str and bool(_ID.fullmatch(request_id))))
    text, calls = [], []
    if provider in ("openai", "xai"):
        _check(data.get("object") == "response" and data.get("status") == "completed")
        _check(data.get("error") is None and data.get("incomplete_details") is None)
        parts = data.get("output")
        _check(type(parts) is list and len(parts) <= 128)
        for part in parts:
            _check(type(part) is dict)
            kind = part.get("type")
            if kind == "function_call":
                _check(part.get("status", "completed") == "completed" and type(part.get("arguments")) is str)
                calls.append({"name": part.get("name"), "input": strict_json(part["arguments"])})
            elif kind == "message":
                _check(part.get("role") == "assistant" and part.get("status") == "completed" and type(part.get("content")) is list)
                for content in part["content"]:
                    _check(type(content) is dict and content.get("type") == "output_text" and type(content.get("text")) is str)
                    text.append(content["text"])
            else:
                _check(kind == "reasoning" and part.get("status", "completed") == "completed")
    elif provider == "anthropic":
        _check(data.get("type") == "message" and data.get("role") == "assistant" and data.get("stop_reason") in ("end_turn", "tool_use"))
        _check(not data.get("stop_details") and not data.get("container"))
        parts = data.get("content")
        _check(type(parts) is list and len(parts) <= 128)
        for part in parts:
            _check(type(part) is dict)
            if part.get("type") == "tool_use":
                calls.append({"name": part.get("name"), "input": part.get("input")})
            elif part.get("type") == "text":
                _check(type(part.get("text")) is str)
                text.append(part["text"])
            else:
                _check(part.get("type") in ("thinking", "redacted_thinking"))
        _check((data["stop_reason"] == "tool_use") == bool(calls))
    elif provider == "google":
        candidates = data.get("candidates")
        _check(not data.get("promptFeedback", {}).get("blockReason"))
        _check(type(candidates) is list and len(candidates) == 1)
        candidate = candidates[0]
        _check(candidate.get("finishReason") == "STOP" and candidate.get("index", 0) == 0)
        content = candidate.get("content", {})
        _check(content.get("role") == "model" and type(content.get("parts")) is list and len(content["parts"]) <= 128)
        for part in content["parts"]:
            _check(type(part) is dict and set(part) <= {"text", "functionCall", "thought", "thoughtSignature"})
            _check(("text" in part) != ("functionCall" in part) and type(part.get("thought", False)) is bool)
            if "functionCall" in part:
                _check(not part.get("thought") and type(part["functionCall"]) is dict)
                calls.append({"name": part["functionCall"].get("name"), "input": part["functionCall"].get("args")})
            else:
                _check(type(part["text"]) is str)
                if not part.get("thought"):
                    text.append(part["text"])
    else:
        _check(data.get("provider") in request.policy.response_upstreams and not data.get("error"))
        choices = data.get("choices")
        _check(type(choices) is list and len(choices) == 1)
        choice = choices[0]
        _check(choice.get("index") == 0 and choice.get("finish_reason") in ("stop", "tool_calls"))
        message = choice.get("message", {})
        _check(message.get("role") == "assistant" and not message.get("refusal") and not message.get("images") and not message.get("audio"))
        if message.get("content") is not None:
            _check(type(message["content"]) is str)
            text.append(message["content"])
        raw_calls = message.get("tool_calls", [])
        _check(type(raw_calls) is list and len(raw_calls) <= 64)
        for call in raw_calls:
            _check(type(call) is dict and call.get("type") == "function" and type(call.get("function")) is dict)
            function = call["function"]
            _check(type(function.get("arguments")) is str)
            calls.append({"name": function.get("name"), "input": strict_json(function["arguments"])})
        _check((choice["finish_reason"] == "tool_calls") == bool(calls))
    schemas = strict_json(request.schemas)
    _check(len(calls) <= 64)
    for call in calls:
        _check(type(call["name"]) is str and call["name"] in schemas and type(call["input"]) is dict)
        Draft202012Validator(schemas[call["name"]], format_checker=FormatChecker()).validate(call["input"])
    if request.choice == "none":
        _check(not calls)
    elif request.choice == "required":
        _check(bool(calls))
    elif request.choice != "auto":
        _check(len(calls) == 1 and calls[0]["name"] == request.choice)
    _check(bool(calls) or bool("".join(text).strip()))
    usage = _usage(provider, data.get("usageMetadata" if provider == "google" else "usage"))
    _check(usage.outputTokens <= request.output_limit)
    return Completion("".join(text), calls, usage, model, request_id, response_id)
