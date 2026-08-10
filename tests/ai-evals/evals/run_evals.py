"""Golden eval suite for the proofreader (spec section 23).

Runs every fixture under fixtures/golden against the deterministic MockProvider
(always) and against the live default provider when ANTHROPIC_API_KEY or
OPENAI_API_KEY is set. Reports must-find hit rate and false positives.

Usage: python tests/ai-evals/evals/run_evals.py
Exit 0 when all mock runs pass; live-provider failures are reported but
non-blocking (model nondeterminism) unless EVAL_STRICT=1.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "services" / "ai"))

from agents.proofreader import ProofreaderAgent  # noqa: E402
from gateway import Completion, MockProvider, completion_from_dict, default_model, get_provider  # noqa: E402
from tools import InMemoryExecutor  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "golden"
CHAPTER_ID = "00000000-0000-0000-0000-000000000001"


def run_case(case: dict, provider, model: str) -> dict:
    executor = InMemoryExecutor(
        chapters={CHAPTER_ID: {"id": CHAPTER_ID, "nodes": [{"id": "n1", "type": "paragraph", "text": case["input"]}]}},
        style_guide=case.get("styleGuide", {}),
    )
    agent = ProofreaderAgent(provider, executor, model)
    result = agent.run({"chapterIds": [CHAPTER_ID], "contextPolicy": {"includeStyleGuide": True}})

    lo, hi = case["expectedSuggestionCount"]
    count = len(result.suggestions)
    count_ok = result.status == "succeeded" and lo <= count <= hi

    hits = 0
    for needle in case.get("mustFind", []):
        idx = case["input"].find(needle)
        for s in result.suggestions:
            p = s["operation"]["payload"]
            # suggestion must touch the span containing the error
            if idx >= 0 and p["from"] <= idx + len(needle) and p["to"] >= idx:
                hits += 1
                break
    missed = len(case.get("mustFind", [])) - hits
    false_positives = max(0, count - max(hits, lo)) if lo == 0 or missed else 0
    return {
        "name": case["name"],
        "status": result.status,
        "suggestions": count,
        "expectedRange": [lo, hi],
        "countOk": count_ok,
        "mustFindHits": hits,
        "mustFindMissed": missed,
        "falsePositives": false_positives,
        "ok": count_ok and missed == 0,
        "error": result.error,
        "usage": result.usage.to_dict(),
    }


def load_cases() -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(FIXTURES.glob("*.json"))]


def main() -> int:
    cases = load_cases()
    print(f"golden cases: {len(cases)}")

    # 1. deterministic mock run — must pass
    mock_results = []
    for case in cases:
        provider = MockProvider([completion_from_dict(case["mockResponse"])])
        mock_results.append(run_case(case, provider, "mock-1"))
    report("MOCK (deterministic, gating)", mock_results)
    mock_ok = all(r["ok"] for r in mock_results)

    # 2. live provider — advisory unless EVAL_STRICT=1
    live_ok = True
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY"):
        provider = get_provider()
        live_results = [run_case(case, provider, default_model(provider.name)) for case in cases]
        report(f"LIVE provider={provider.name} (advisory)", live_results)
        live_ok = all(r["ok"] for r in live_results)
    else:
        print("no provider API key set — skipping live run")

    ok = mock_ok and (live_ok or os.environ.get("EVAL_STRICT") != "1")
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def report(label: str, results: list[dict]) -> None:
    print(f"\n== {label} ==")
    total_hits = sum(r["mustFindHits"] for r in results)
    total_needles = total_hits + sum(r["mustFindMissed"] for r in results)
    total_fp = sum(r["falsePositives"] for r in results)
    for r in results:
        mark = "ok" if r["ok"] else "FAIL"
        print(f"  [{mark}] {r['name']}: {r['suggestions']} suggestions "
              f"(expected {r['expectedRange'][0]}-{r['expectedRange'][1]}), "
              f"must-find {r['mustFindHits']}/{r['mustFindHits'] + r['mustFindMissed']}"
              + (f" — {r['error']}" if r.get("error") else ""))
    rate = (total_hits / total_needles) if total_needles else 1.0
    print(f"  must-find hit rate: {rate:.0%} ({total_hits}/{total_needles}), false positives: {total_fp}")


if __name__ == "__main__":
    raise SystemExit(main())
