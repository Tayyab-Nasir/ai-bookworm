from types import SimpleNamespace

from gateway import OpenAIProvider, _cost, default_model


def test_openai_provider_uses_responses_api_and_maps_function_calls():
    captured = {}

    class Responses:
        def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                output=[SimpleNamespace(type="function_call", name="propose_edit", arguments='{"chapterId":"c1"}')],
                output_text="",
                usage=SimpleNamespace(input_tokens=100, output_tokens=20),
            )

    provider = OpenAIProvider.__new__(OpenAIProvider)
    provider._client = SimpleNamespace(responses=Responses())
    result = provider.complete(
        [{"role": "user", "content": "Review this."}],
        [{"name": "propose_edit", "description": "Propose", "input_schema": {"type": "object"}}],
        "gpt-6-astra",
    )

    assert captured["model"] == "gpt-6-astra"
    assert captured["input"][0]["content"] == "Review this."
    assert captured["tools"][0]["name"] == "propose_edit"
    assert result.tool_calls == [{"name": "propose_edit", "input": {"chapterId": "c1"}}]
    assert result.usage.estimatedCostUsd == 0.002


def test_astra_cost_uses_published_long_context_multiplier():
    assert _cost("gpt-6-astra", 100, 20) == 0.002
    assert _cost("gpt-6-astra-2026-09-03", 300_000, 100) == 6.0075
    assert _cost("unknown-model", 100, 20) == 0
    assert default_model("openai") == "gpt-6-astra"
