"""Synthetic HTTP contracts only. No provider credentials or network needed."""
import copy
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from customer_protocol import MAX_BYTES, CustomerRequestError, ModelPolicy, prepare_customer_request
from customer_provider import CustomerProvider
from gateway import ProviderOutcomeUnknown, get_customer_provider, get_provider

NAMES = ("openai", "anthropic", "google", "openrouter", "xai")
KEY = "synthetic-customer-credential-0001"
MESSAGES = [{"role": "system", "content": "Only propose reviewed edits."}, {"role": "user", "content": "A synthetic manuscript."}]
TOOLS = [{"name": "propose_edit", "description": "Return an edit for review.", "input_schema": {
    "type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False,
}}]
CALL = {"type": "function", "name": "propose_edit"}


def policy_for(name):
    return ModelPolicy("reviewed-model", ("reviewed-model-2026-10-24",), 1024,
                       "approved-endpoint" if name == "openrouter" else None,
                       ("Approved Endpoint",) if name == "openrouter" else ())


def response_for(name, tool="propose_edit", arguments=None):
    arguments = {"text": "A revised line."} if arguments is None else arguments
    model = "reviewed-model-2026-10-24"
    if name in ("openai", "xai"):
        return {"id": "resp_synthetic", "object": "response", "model": model, "status": "completed",
                "error": None, "incomplete_details": None,
                "output": [{"type": "function_call", "status": "completed", "name": tool, "arguments": json.dumps(arguments)}],
                "usage": {"input_tokens": 100, "output_tokens": 25, "total_tokens": 125,
                          "input_tokens_details": {"cached_tokens": 20}, "output_tokens_details": {"reasoning_tokens": 5}}}
    if name == "anthropic":
        return {"id": "msg_synthetic", "type": "message", "role": "assistant", "model": model, "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "name": tool, "id": "call_synthetic", "input": arguments}],
                "usage": {"input_tokens": 70, "output_tokens": 25, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 10,
                          "cache_creation": {"ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 10},
                          "output_tokens_details": {"thinking_tokens": 5}}}
    if name == "google":
        return {"responseId": "gemini_synthetic", "modelVersion": model,
                "candidates": [{"index": 0, "finishReason": "STOP", "content": {"role": "model", "parts": [
                    {"functionCall": {"name": tool, "args": arguments}}]}}],
                "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 5,
                                  "totalTokenCount": 125, "cachedContentTokenCount": 20}}
    return {"id": "gen_synthetic", "model": model, "provider": "Approved Endpoint",
            "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                "tool_calls": [{"id": "call_synthetic", "type": "function", "function": {"name": tool, "arguments": json.dumps(arguments)}}]}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 25, "total_tokens": 125,
                      "prompt_tokens_details": {"cached_tokens": 20}, "completion_tokens_details": {"reasoning_tokens": 5}}}


def make_provider(name, handler, *, expected=None, key=KEY, **options):
    policy = policy_for(name)
    prepared = prepare_customer_request(name, policy, MESSAGES, TOOLS, policy.model, max_output_tokens=1024, tool_choice=CALL)
    return get_customer_provider(name, api_key=key, policy=policy, expected_request_sha256=expected or prepared.sha256,
                                 _test_transport=httpx.MockTransport(handler), **options), prepared


def invoke(provider):
    return provider.complete(MESSAGES, TOOLS, "reviewed-model", max_output_tokens=1024, tool_choice=CALL)


@pytest.fixture(autouse=True)
def refuse_actual_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("Real network is forbidden in customer-provider tests.")
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)


@pytest.mark.parametrize("name", NAMES)
def test_exact_request_and_real_http_parsing_with_no_env_credential(name, monkeypatch):
    for env in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY"):
        monkeypatch.setenv(env, "must-not-use-ambient-credential")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://untrusted.invalid")
    monkeypatch.setenv("HTTPS_PROXY", "http://untrusted.invalid")
    seen = []

    def handle(req):
        seen.append(req)
        assert req.method == "POST" and str(req.url) == prepared.url and req.content == prepared.body
        assert req.headers["x-goog-api-key" if name == "google" else "authorization"] == (KEY if name == "google" else "Bearer " + KEY)
        assert "must-not-use-ambient" not in repr(req.headers) and "cookie" not in req.headers
        return httpx.Response(200, json=response_for(name), headers={"x-request-id": "req_synthetic", "request-id": "anthropic_req_synthetic"})

    provider, prepared = make_provider(name, handle)
    result = invoke(provider)
    assert len(seen) == 1 and provider._api_key is None and provider.outcome_requires_review
    assert result.tool_calls == [{"name": "propose_edit", "input": {"text": "A revised line."}}]
    assert result.usage.inputTokens == 100 and result.usage.outputTokens == 25
    assert result.usage.estimatedCostUsd is None and result.usage.measuredTokens is None
    assert result.usage.to_dict()["estimatedCostUsd"] is None and result.usage.providerTokenUsage
    assert result.response_id and result.request_id == ("req_synthetic" if name == "openai" else "anthropic_req_synthetic" if name == "anthropic" else None)
    assert KEY not in repr(provider) + repr(prepared) + prepared.body.decode() + prepared.sha256 + repr(result)
    with pytest.raises(CustomerRequestError, match="already consumed"):
        invoke(provider)
    assert len(seen) == 1


@pytest.mark.parametrize("name", NAMES)
def test_provider_specific_function_wire_contract(name):
    provider, prepared = make_provider(name, lambda _: None)
    body = json.loads(prepared.body)
    if name in ("openai", "xai"):
        assert body["store"] is False and body["stream"] is False
        assert body["input"] == MESSAGES and body["tool_choice"] == CALL
        assert body["tools"][0]["parameters"] == TOOLS[0]["input_schema"]
    elif name == "anthropic":
        assert body["system"] == MESSAGES[0]["content"] and body["messages"] == MESSAGES[1:]
        assert body["tool_choice"] == {"type": "auto"}  # forced output is validated, not unsupported wire forcing
        assert body["tools"] == TOOLS and body["max_tokens"] == 1024
    elif name == "google":
        assert body["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"] == TOOLS[0]["input_schema"]
        assert body["toolConfig"]["functionCallingConfig"] == {"mode": "ANY", "allowedFunctionNames": ["propose_edit"]}
        assert body["generationConfig"] == {"maxOutputTokens": 1024, "candidateCount": 1}
    else:
        assert body["provider"] == {"order": ["approved-endpoint"], "only": ["approved-endpoint"], "allow_fallbacks": False,
                                    "require_parameters": True, "data_collection": "deny"}
        assert body["tool_choice"] == {"type": "function", "function": {"name": "propose_edit"}}


def test_hash_binds_destination_model_policy_and_mutable_source_snapshot():
    policy = policy_for("openai")
    kwargs = dict(max_output_tokens=1024, tool_choice=CALL)
    source = copy.deepcopy(MESSAGES)
    first = prepare_customer_request("openai", policy, source, TOOLS, policy.model, **kwargs)
    source[1]["content"] = "changed"
    assert b"changed" not in first.body
    assert first.sha256 == prepare_customer_request("openai", policy, MESSAGES, TOOLS, policy.model, **kwargs).sha256
    assert first.sha256 != prepare_customer_request("xai", policy, MESSAGES, TOOLS, policy.model, **kwargs).sha256
    assert first.sha256 != prepare_customer_request("openai", replace(policy, response_models=("different",)), MESSAGES, TOOLS, policy.model, **kwargs).sha256


@pytest.mark.parametrize("change", [
    {"max_output_tokens": None}, {"max_output_tokens": True}, {"max_output_tokens": 1025},
    {"tool_choice": {"type": "function", "name": "run_shell"}}, {"model": "unreviewed-model"},
    {"messages": [{"role": "user", "content": [{"image_url": "https://foreign.invalid/private"}]}]},
    {"messages": [{"role": "user", "content": "x" * MAX_BYTES}]},
    {"messages": [{"role": "user", "content": "hi", "key": "not-allowed"}]},
    {"tools": [{"name": "f", "input_schema": {"type": "object", "properties": {"x": {"$ref": "https://foreign.invalid/schema"}}}}]},
    {"tools": TOOLS + TOOLS}, {"tools": [{"name": "f", "input_schema": {"type": "object", "required": "bad"}}]},
])
def test_invalid_request_never_reaches_transport(change):
    seen = []
    provider, _ = make_provider("openai", lambda req: seen.append(req))
    args = dict(messages=MESSAGES, tools=TOOLS, model="reviewed-model", max_output_tokens=1024, tool_choice=CALL)
    args.update(change)
    with pytest.raises(CustomerRequestError, match="local validation"):
        provider.complete(**args)
    assert not seen and not provider.outcome_requires_review and provider._api_key == KEY


def test_hash_mismatch_rejected_without_spending_or_consuming_key():
    seen = []
    provider, _ = make_provider("openai", lambda req: seen.append(req), expected="0" * 64)
    with pytest.raises(CustomerRequestError, match="identity changed"):
        invoke(provider)
    assert not seen and not provider.outcome_requires_review and provider._api_key == KEY


@pytest.mark.parametrize("key", ["", "too-short", " " + KEY, KEY + "\n", "é" * 32, "x" * 4097])
def test_invalid_credential_has_no_env_fallback(key):
    with pytest.raises(CustomerRequestError):
        make_provider("openai", lambda _: None, key=key)


@pytest.mark.parametrize("name", ("anthropic", "google", "openrouter", "xai"))
def test_customer_adapters_are_not_a_default_or_http_activation(name):
    with pytest.raises(ValueError, match="unknown AI provider"):
        get_provider(name)


@pytest.mark.parametrize("status", [301, 302, 307, 401, 403, 429, 500, 503])
def test_http_errors_are_single_attempt_and_redacted(status):
    seen = []
    def handle(req):
        seen.append(req)
        return httpx.Response(status, headers={"location": "https://foreign.invalid"}, text=KEY + MESSAGES[1]["content"])
    provider, _ = make_provider("openai", handle)
    with pytest.raises(ProviderOutcomeUnknown) as error:
        invoke(provider)
    assert len(seen) == 1 and error.value.__cause__ is None and error.value.__suppress_context__
    assert KEY not in str(error.value) and MESSAGES[1]["content"] not in str(error.value)
    with pytest.raises(CustomerRequestError):
        invoke(provider)
    assert len(seen) == 1


def test_timeout_is_single_attempt_and_not_reflected():
    seen = []
    def handle(req):
        seen.append(req)
        raise httpx.ReadTimeout(KEY, request=req)
    provider, _ = make_provider("openai", handle)
    with pytest.raises(ProviderOutcomeUnknown) as error:
        invoke(provider)
    assert len(seen) == 1 and KEY not in str(error.value) and provider.outcome_requires_review


@pytest.mark.parametrize("body,headers", [
    (b'<html>private error</html>', {"content-type": "text/html"}),
    (b'{"id":"a","id":"b"}', {"content-type": "application/json"}),
    (b'{"usage":NaN}', {"content-type": "application/json"}),
    (b'{"broken":', {"content-type": "application/json"}),
    (b'{}', {"content-type": "application/json", "content-length": str(MAX_BYTES + 1)}),
    (b' ' * (MAX_BYTES + 1), {"content-type": "application/json"}),
    (b'{"echo":"' + KEY.encode() + b'"}', {"content-type": "application/json"}),
], ids=["html", "duplicate-json", "nan", "truncated", "declared-size", "actual-size", "credential-echo"])
def test_invalid_or_oversized_body_is_unknown_not_success(body, headers):
    provider, _ = make_provider("openai", lambda _: httpx.Response(200, content=body, headers=headers))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("fault", ["model", "missing_usage", "wrong_tool", "bad_args", "huge_output", "refusal", "malformed_id"])
def test_response_shape_model_usage_tool_and_completion_guards(name, fault):
    data = response_for(name, tool="run_shell" if fault == "wrong_tool" else "propose_edit", arguments={"extra": True} if fault == "bad_args" else None)
    if fault == "model":
        data["modelVersion" if name == "google" else "model"] = "other-model"
    elif fault == "missing_usage":
        data.pop("usageMetadata" if name == "google" else "usage")
    elif fault == "huge_output":
        usage = data["usageMetadata" if name == "google" else "usage"]
        if name == "google":
            usage.update(candidatesTokenCount=2000, totalTokenCount=2105)
        elif name == "openrouter":
            usage.update(completion_tokens=2000, total_tokens=2100)
        else:
            usage.update(output_tokens=2000, total_tokens=2100)
    elif fault == "refusal":
        if name == "google":
            data["candidates"][0]["finishReason"] = "SAFETY"
        elif name == "anthropic":
            data["stop_reason"] = "refusal"
        elif name == "openrouter":
            data["choices"][0]["message"]["refusal"] = "declined"
        else:
            data["status"] = "incomplete"
    elif fault == "malformed_id":
        data["responseId" if name == "google" else "id"] = "unsafe id\n"
    provider, _ = make_provider(name, lambda _: httpx.Response(200, json=data))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


@pytest.mark.parametrize("name", NAMES)
def test_required_tool_absence_is_review_required(name):
    data = response_for(name)
    if name in ("openai", "xai"):
        data["output"] = [{"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "No tool."}]}]
    elif name == "anthropic":
        data.update(stop_reason="end_turn", content=[{"type": "text", "text": "No tool."}])
    elif name == "google":
        data["candidates"][0]["content"]["parts"] = [{"text": "No tool."}]
    else:
        data["choices"][0].update(finish_reason="stop", message={"role": "assistant", "content": "No tool."})
    provider, _ = make_provider(name, lambda _: httpx.Response(200, json=data))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


@pytest.mark.parametrize("name", ("openai", "xai", "openrouter", "google"))
def test_missing_cache_detail_is_not_invented(name):
    data = response_for(name)
    usage = data["usageMetadata" if name == "google" else "usage"]
    usage.pop("cachedContentTokenCount" if name == "google" else "prompt_tokens_details" if name == "openrouter" else "input_tokens_details")
    provider, _ = make_provider(name, lambda _: httpx.Response(200, json=data))
    result = invoke(provider)
    assert not any("cached" in key.lower() for key in result.usage.providerTokenUsage)
    assert result.usage.estimatedCostUsd is None


@pytest.mark.parametrize("name,fault", [
    ("anthropic", "cache"), ("anthropic", "server"), ("anthropic", "missing_cache"),
    ("google", "total"), ("google", "media"), ("google", "server"), ("google", "unknown_thoughts"),
    ("openrouter", "upstream"), ("openrouter", "total"), ("openrouter", "reasoning"),
    ("openai", "total"), ("openai", "boolean"), ("xai", "server"), ("xai", "legacy"),
])
def test_provider_specific_usage_reconciliation_guards(name, fault):
    data = response_for(name)
    usage = data["usageMetadata" if name == "google" else "usage"]
    if fault == "cache":
        usage["cache_creation"]["ephemeral_5m_input_tokens"] = 11
    elif fault == "missing_cache":
        usage.pop("cache_read_input_tokens")
    elif fault == "total":
        usage["totalTokenCount" if name == "google" else "total_tokens"] += 1
    elif fault == "media":
        usage["promptTokensDetails"] = [{"modality": "IMAGE", "tokenCount": 10}]
    elif fault == "unknown_thoughts":
        usage.pop("thoughtsTokenCount")
    elif fault == "server":
        if name == "anthropic":
            usage["server_tool_use"] = {"web_search_requests": 1}
        else:
            usage["toolUsePromptTokenCount" if name == "google" else "num_server_side_tools_used"] = 1
    elif fault == "upstream":
        data["provider"] = "Unapproved Fallback"
    elif fault == "reasoning":
        usage["completion_tokens_details"]["reasoning_tokens"] = 30
    elif fault == "boolean":
        usage["input_tokens"] = True
    elif fault == "legacy":
        usage["prompt_tokens"] = usage.pop("input_tokens")
    provider, _ = make_provider(name, lambda _: httpx.Response(200, json=data))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


def test_concurrent_instances_do_not_share_keys_or_mutate_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-is-not-a-customer")
    keys = [f"synthetic-customer-credential-{i:04}" for i in range(10)]
    def run(key):
        def handle(req):
            assert req.headers["authorization"] == "Bearer " + key
            return httpx.Response(200, json=response_for("openai"))
        provider, _ = make_provider("openai", handle, key=key)
        return invoke(provider).usage.inputTokens
    with ThreadPoolExecutor(max_workers=5) as pool:
        assert list(pool.map(run, keys)) == [100] * len(keys)
    import os
    assert os.environ["OPENAI_API_KEY"] == "ambient-is-not-a-customer"


def test_concurrent_reuse_sends_only_one_request():
    seen = []
    def handle(req):
        seen.append(req)
        return httpx.Response(200, json=response_for("openai"))
    provider, _ = make_provider("openai", handle)
    def run(_):
        try:
            return invoke(provider).model
        except CustomerRequestError:
            return "refused"
    with ThreadPoolExecutor(max_workers=5) as pool:
        outcomes = list(pool.map(run, range(10)))
    assert len(seen) == 1 and outcomes.count("refused") == 9


def test_production_transport_disables_retries_proxies_and_redirects(monkeypatch):
    options = {}
    actual_client = httpx.Client
    def transport(**kwargs):
        options["transport"] = kwargs
        return httpx.MockTransport(lambda _: httpx.Response(200, json=response_for("openai")))
    def client(**kwargs):
        options["client"] = kwargs
        return actual_client(**kwargs)
    monkeypatch.setattr(httpx, "HTTPTransport", transport)
    monkeypatch.setattr(httpx, "Client", client)
    policy = policy_for("openai")
    prepared = prepare_customer_request("openai", policy, MESSAGES, TOOLS, policy.model, max_output_tokens=1024, tool_choice=CALL)
    provider = CustomerProvider("openai", api_key=KEY, policy=policy, expected_request_sha256=prepared.sha256)
    invoke(provider)
    assert options["transport"] == {"retries": 0, "verify": True, "trust_env": False}
    assert options["client"]["trust_env"] is False and options["client"]["follow_redirects"] is False
    assert options["client"]["timeout"].read == 120


def test_elapsed_time_checked_on_small_network_chunks(monkeypatch):
    import customer_provider
    times = iter([0, 181])
    monkeypatch.setattr(customer_provider.time, "monotonic", lambda: next(times))
    class Trickle(httpx.SyncByteStream):
        def __iter__(self):
            yield b"{"
            pytest.fail("Must stop without buffering a large chunk.")
    provider, _ = make_provider("openai", lambda _: httpx.Response(200, stream=Trickle(), headers={"content-type": "application/json"}))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


def test_compressed_response_is_refused_without_decompression():
    provider, _ = make_provider("openai", lambda _: httpx.Response(200, stream=httpx.ByteStream(b"not-gzip"),
                           headers={"content-type": "application/json", "content-encoding": "gzip"}))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


@pytest.mark.parametrize("name", NAMES)
def test_duplicate_forced_function_is_not_silently_reduced_to_one(name):
    data = response_for(name)
    if name in ("openai", "xai"):
        calls = data["output"]
    elif name == "anthropic":
        calls = data["content"]
    elif name == "google":
        calls = data["candidates"][0]["content"]["parts"]
    else:
        calls = data["choices"][0]["message"]["tool_calls"]
    calls.append(copy.deepcopy(calls[0]))
    provider, _ = make_provider(name, lambda _: httpx.Response(200, json=data))
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)


def test_explicit_zero_thoughts_and_omitted_zero_thoughts_have_same_total_not_same_evidence():
    data = response_for("google")
    data["usageMetadata"].pop("thoughtsTokenCount")
    data["usageMetadata"]["totalTokenCount"] = 120
    provider, _ = make_provider("google", lambda _: httpx.Response(200, json=data))
    result = invoke(provider)
    assert result.usage.outputTokens == 20 and "thoughtsTokenCount" not in result.usage.providerTokenUsage


def test_no_test_transport_with_arbitrary_http_endpoint_or_auth_injection():
    with pytest.raises(CustomerRequestError):
        CustomerProvider("openai", api_key=KEY, policy=policy_for("openai"), expected_request_sha256="0" * 64,
                         _test_transport=httpx.HTTPTransport())
    with pytest.raises(CustomerRequestError):
        prepare_customer_request("google", ModelPolicy("../../foreign", ("reviewed-model",), 1024),
                                 MESSAGES, TOOLS, "../../foreign", max_output_tokens=1024)
    with pytest.raises(CustomerRequestError):
        prepare_customer_request("openrouter", policy_for("openai"), MESSAGES, TOOLS, "reviewed-model", max_output_tokens=1024)


def test_json_escaped_credential_echo_is_not_promoted_to_output():
    key = 'synthetic-credential-with-"-and-\\'
    data = response_for("openai", arguments={"text": key})
    provider, _ = make_provider("openai", lambda _: httpx.Response(200, json=data), key=key)
    with pytest.raises(ProviderOutcomeUnknown):
        invoke(provider)
