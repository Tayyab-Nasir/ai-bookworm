"""Static API contract acceptance, independent of Next build/type checks."""
from pathlib import Path
import re

import pytest
import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}


class UniqueKeysLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node, deep=False):
    pairs = loader.construct_pairs(node, deep=deep)
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate contract key: {key} at line {node.start_mark.line + 1}")
        result[key] = value
    return result


UniqueKeysLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def load_contract(text):
    return yaml.load(text, Loader=UniqueKeysLoader)


def test_duplicate_contract_keys_are_not_silently_overwritten():
    with pytest.raises(ValueError, match="Duplicate contract key: responses"):
        load_contract("post:\n  responses: {200: first}\n  responses: {200: second}\n")


def test_openapi_structure_references_and_operation_identities():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    assert document["openapi"] == "3.1.0"
    operation_ids = set()
    for path, item in document["paths"].items():
        assert path.startswith("/v1/")
        assert set(item) <= METHODS | {"$ref", "summary", "description", "servers", "parameters"}
        for method, operation in item.items():
            if method not in METHODS:
                continue
            assert isinstance(operation, dict), (path, method)
            assert operation.get("responses"), (path, method, "missing responses")
            identity = operation.get("operationId")
            assert identity and identity not in operation_ids, (path, method, identity)
            operation_ids.add(identity)
            expected = set(re.findall(r"\{([^}]+)\}", path))
            parameters = [*item.get("parameters", []), *operation.get("parameters", [])]
            resolved_parameters = []
            for parameter in parameters:
                if "$ref" in parameter:
                    parameter = document["components"]["parameters"][parameter["$ref"].split("/")[-1]]
                resolved_parameters.append(parameter)
            actual = {p["name"] for p in resolved_parameters if p.get("in") == "path" and p.get("required") is True}
            assert expected == actual, (path, method, "path parameters", expected, actual)

    def references(value):
        if isinstance(value, dict):
            if "$ref" in value:
                reference = value["$ref"]
                assert reference.startswith("#/"), reference
                target = document
                for component in reference[2:].split("/"):
                    target = target[component.replace("~1", "/").replace("~0", "~")]
            for child in value.values():
                references(child)
        elif isinstance(value, list):
            for child in value:
                references(child)

    references(document)
    for schema in ("StoryBlueprintStory", "GeneratedBookMetadataCandidate", "MetadataQuoteStatus"):
        assert document["components"]["schemas"][schema]["type"] == "object", schema
    for path, method in [
        ("/v1/books/{bookId}/bible/evidence", "post"),
        ("/v1/books/{bookId}/story-blueprint", "put"),
        ("/v1/admin/moderation/reports/{id}/resolve", "post"),
    ]:
        operation = document["paths"][path][method]
        expected = set(re.findall(r"\{([^}]+)\}", path))
        parameters = [*document["paths"][path].get("parameters", []), *operation.get("parameters", [])]
        actual = {p["name"] for p in parameters if p.get("in") == "path" and p.get("required") is True}
        assert expected == actual, (path, "path parameters")
        assert operation["requestBody"]["content"], (path, "request body")


def test_sales_contract_preserves_nullable_unknowns_and_negative_corrections():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    response = document["paths"]["/v1/sales/imports"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert "analytics" in response["required"]
    validator = Draft202012Validator({**document, "$ref": "#/components/schemas/RetailerSalesAnalytics"})
    payload = {"windowStart": "2026-09-01", "windowEnd": "2026-10-01", "monthCount": 1,
        "monthly": [{"month": "2026-09-01", "currency": "USD", "units": -1, "royaltyCents": -70, "reportedProceedsCents": None}],
        "books": [], "bookCount": 0, "booksTruncated": False, "sources": [], "available": True, "message": "Imported rows only"}
    assert not list(validator.iter_errors(payload))
    payload["monthly"][0]["royaltyCents"] = 9007199254740992
    assert list(validator.iter_errors(payload)), "unsafe money cannot satisfy the public analytics contract"


def test_report_admission_contract_rejects_unknown_fields_invalid_ids_and_blank_reasons():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    operation = document["paths"]["/v1/reports"]["post"]
    schema = operation["requestBody"]["content"]["application/json"]["schema"]
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    payload = {"entityType": "post", "entityId": "b1200000-0000-4000-8000-000000000093", "reason": "Review"}
    assert not list(validator.iter_errors(payload))
    for patch in ({"entityId": "invalid"}, {"reason": "   "}, {"reason": "x" * 1001}, {"reporterId": "another-user"}):
        assert list(validator.iter_errors({**payload, **patch})), patch
    assert {"403", "422", "429", "503"} <= operation["responses"].keys()


def test_community_queue_contract_excludes_reporter_identity_and_preserves_comment_context():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    operation = document["paths"]["/v1/moderation/queue"]["get"]
    assert {parameter["name"] for parameter in operation["parameters"]} == {"limit", "offset"}
    response = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert set(response["required"]) == {"reports", "limit", "offset", "hasMore"}
    validator = Draft202012Validator({**document, "$ref": "#/components/schemas/CommunityModerationReport"})
    report = {"id": "report", "entity_type": "comment", "entity_id": "comment", "reason": "Review reply",
        "status": "open", "created_at": "2026-10-05T00:00:00Z", "target": {"type": "comment", "body": "Reply",
            "moderationState": "visible", "parentTitle": None, "parentBody": "Post context", "communityName": "Writers"}}
    assert not list(validator.iter_errors(report))
    report["reporter_id"] = "private-reporter"
    assert list(validator.iter_errors(report)), "reporter identity is not a public moderation queue field"
