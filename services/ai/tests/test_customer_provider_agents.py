"""Real Bookworm agents over the new adapters, using synthetic HTTP only."""
import copy
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents.story_blueprint import StoryBlueprintAgent
from agents.writer import WriterAgent
from customer_protocol import prepare_customer_request
from gateway import MockProvider, ProviderOutcomeUnknown, get_customer_provider
from tools import InMemoryExecutor
from test_customer_provider import KEY, NAMES, policy_for, response_for
from test_story_blueprint_agent import CANDIDATE, request as story_request

CHAPTER = "00000000-0000-4000-8000-000000000001"
EDIT = {"chapterId": CHAPTER, "nodeId": "n1", "operation": {
    "operationId": "synthetic-edit", "type": "replace_text", "target": {"chapterId": CHAPTER, "nodeId": "n1"},
    "payload": {"nodeId": "n1", "from": 0, "to": 4, "text": "The rain eased."}, "expectedVersion": 1,
}, "rationale": "Clarify the opening.", "confidence": 0.9}


def connected_agent(name, kind, payload):
    executor = InMemoryExecutor(chapters={CHAPTER: {"id": CHAPTER, "version": 1, "nodes": [{"id": "n1", "text": "Rain fell."}]}})
    agent = (StoryBlueprintAgent if kind == "story" else WriterAgent)(MockProvider(), executor, "reviewed-model")
    request = story_request() if kind == "story" else {"chapterIds": [CHAPTER]}
    agent.max_output_tokens = 1024
    messages, tools, choice = agent.provider_request(request)
    policy = policy_for(name)
    prepared = prepare_customer_request(name, policy, messages, tools, agent.model, max_output_tokens=1024, tool_choice=choice)
    sent = []
    def handle(req):
        sent.append(req)
        assert req.content == prepared.body
        return httpx.Response(200, json=response_for(name, "propose_story_blueprint" if kind == "story" else "propose_edit", payload))
    agent.provider = get_customer_provider(name, api_key=KEY, policy=policy, expected_request_sha256=prepared.sha256,
                                           _test_transport=httpx.MockTransport(handle))
    return agent, request, executor, sent


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("kind", ("writer", "story"))
def test_existing_agent_returns_reviewable_output_with_unknown_cost_and_receipt(name, kind):
    payload = CANDIDATE if kind == "story" else EDIT
    agent, request, executor, sent = connected_agent(name, kind, copy.deepcopy(payload))
    before = copy.deepcopy(executor.get_chapter(CHAPTER))
    result = agent.run(request, "synthetic-job")
    assert result.status == "succeeded" and len(sent) == 1 and len(result.suggestions) == 1
    assert result.suggestions[0]["status"] == "pending"
    assert result.usage.inputTokens == 100 and result.usage.outputTokens == 25
    assert result.usage.estimatedCostUsd is None and result.usage.providerTokenUsage
    assert result.to_dict()["responseId"] and result.to_dict()["usage"]["estimatedCostUsd"] is None
    assert executor.get_chapter(CHAPTER) == before  # never applies/creates documents


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("kind", ("writer", "story"))
def test_domain_invalid_but_schema_valid_paid_output_requires_review_not_refund(name, kind):
    payload = copy.deepcopy(CANDIDATE if kind == "story" else EDIT)
    if kind == "story":
        # Different item but duplicate ID: uniqueItems passes, domain check fails.
        payload["chapterPlan"].append({**payload["chapterPlan"][0], "title": "Another chapter"})
    else:
        payload["operation"]["payload"]["nodeId"] = "another-node"  # domain mismatch, not a schema mismatch
    agent, request, executor, sent = connected_agent(name, kind, payload)
    before = copy.deepcopy(executor.get_chapter(CHAPTER))
    with pytest.raises(ProviderOutcomeUnknown, match="requires review"):
        agent.run(request)
    assert len(sent) == 1 and executor.get_chapter(CHAPTER) == before


def test_pre_dispatch_agent_validation_still_fails_without_spending():
    agent, request, executor, sent = connected_agent("anthropic", "writer", copy.deepcopy(EDIT))
    request["userInstruction"] = "x" * 50_000
    result = agent.run(request)
    assert result.status == "failed" and not sent and not agent.provider.outcome_requires_review
