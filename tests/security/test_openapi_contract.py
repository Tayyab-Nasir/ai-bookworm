"""Static API contract acceptance, independent of Next build/type checks."""
from pathlib import Path
from copy import deepcopy
import re

import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker

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


def test_unquoted_narration_creation_is_explicitly_retired():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    operation = document["paths"]["/v1/editions/{editionId}/audiobook-jobs"]["post"]
    assert operation["deprecated"] is True
    assert "200" not in operation["responses"] and "202" not in operation["responses"]
    retired = operation["responses"]["410"]
    assert "narration_quote_required" in retired["description"]
    assert retired["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"
    assert retired["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/ApiError"


def test_duplicate_contract_keys_are_not_silently_overwritten():
    with pytest.raises(ValueError, match="Duplicate contract key: responses"):
        load_contract("post:\n  responses: {200: first}\n  responses: {200: second}\n")


def test_manual_book_bible_contract_binds_actor_request_and_exact_current_disposition():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    root = "/v1/books/{bookId}/bible"
    operations = [document["paths"][root]["post"], document["paths"][root + "/{itemId}"]["put"],
                  document["paths"][root + "/{itemId}"]["delete"], document["paths"][root + "/requests/{requestId}"]["get"],
                  document["paths"][root + "/requests/{requestId}/close"]["post"]]
    actor = document["components"]["parameters"]["BookBibleActor"]
    assert actor["name"] == "X-Bookworm-Actor" and actor["in"] == "header" and actor["required"] is True
    assert actor["schema"] == {"type": "string", "format": "uuid"}
    for operation in operations:
        assert {"401", "403", "409", "422", "503"} <= operation["responses"].keys()
        assert {"$ref": "#/components/parameters/BookBibleActor"} in operation["parameters"]
        assert operation["responses"]["200"] == {"$ref": "#/components/responses/BookBibleMutation"}
    assert "requestBody" not in operations[3]
    close_validator = Draft202012Validator(operations[4]["requestBody"]["content"]["application/json"]["schema"])
    assert operations[4]["requestBody"]["required"] is True
    assert not list(close_validator.iter_errors({}))
    for payload in (None, {"requestId": "must stay in original path"}, {"name": "Never save canon on closure"}):
        assert list(close_validator.iter_errors(payload))
    assert document["components"]["responses"]["BookBibleMutation"]["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"
    identity = "b1000000-0000-4000-8000-000000000001"
    create_validator = Draft202012Validator({**document, "$ref": "#/components/schemas/BookBibleMutationBody"}, format_checker=FormatChecker())
    body = {"requestId": identity, "type": "character", "name": "Elara", "attributes": {"role": "Mapmaker"}}
    assert not list(create_validator.iter_errors(body))
    for patch in ({"requestId": "bad"}, {"requestId": None}, {"name": "  "}, {"expectedUpdatedAt": "2026-10-13T00:00:00Z"},
                  {"actorId": identity}, {"book_id": identity}, {"confidence": 1}, {"mutation_incarnation_id": identity}, {"expectedIncarnationId": identity},
                  {"attributes": {"imageAssetIds": [identity]}}, {"sourceRefs": [{"chapterId": identity, "textHash": "a" * 64}]}):
        assert list(create_validator.iter_errors({**body, **patch})), patch
    assert list(create_validator.iter_errors({"type": "character", "name": "Elara"}))
    for schema, payload in [("UpdateBookBibleMutationBody", body), ("DeleteBookBibleMutationBody", {"requestId": identity})]:
        validator = Draft202012Validator({**document, "$ref": f"#/components/schemas/{schema}"}, format_checker=FormatChecker())
        assert list(validator.iter_errors(payload)), schema
        valid = {**payload, "expectedUpdatedAt": "2026-10-13T00:00:00Z", "expectedIncarnationId": identity}
        assert not list(validator.iter_errors(valid))
        assert list(validator.iter_errors({key: value for key, value in valid.items() if key != "expectedIncarnationId"}))
        assert list(validator.iter_errors({key: value for key, value in valid.items() if key != "expectedUpdatedAt"}))
        for incarnation in (None, "bad"):
            assert list(validator.iter_errors({**valid, "expectedIncarnationId": incarnation}))
    validator = Draft202012Validator({**document, "$ref": "#/components/schemas/BookBibleMutationResult"}, format_checker=FormatChecker())
    receipt = {"requestId": identity, "bookId": identity, "action": "create", "itemId": identity, "intentHash": "a" * 64,
               "resultHash": "b" * 64, "resultUpdatedAt": "2026-10-13T00:00:00Z", "committedAt": "2026-10-13T00:01:00Z"}
    item = {"id": identity, "book_id": identity, "type": "character", "name": "Elara", "description": None,
            "attributes_json": {}, "source_refs_json": [], "confidence": None, "created_at": "2026-10-13T00:00:00Z",
            "updated_at": "2026-10-13T00:00:00Z", "mutation_incarnation_id": identity, "additional_server_field": "preserved"}
    result = {"receipt": receipt, "disposition": "unchanged", "item": item, "replayed": False, "closed": False, "closure": None}
    assert not list(validator.iter_errors(result))
    assert list(validator.iter_errors({**result, "item": {key: value for key, value in item.items() if key != "mutation_incarnation_id"}}))
    assert list(validator.iter_errors({**result, "item": {**item, "mutation_incarnation_id": "bad"}}))
    missing = {"receipt": None, "disposition": None, "item": None, "replayed": False, "closed": False, "closure": None}
    closure = {"requestId": identity, "bookId": identity, "closedAt": "2026-10-13T00:01:00Z"}
    assert not list(validator.iter_errors(missing))
    closed = {**missing, "closed": True, "closure": closure}
    assert not list(validator.iter_errors(closed))
    for patch in ({"closed": True, "receipt": receipt}, {"closed": True, "disposition": "deleted"},
                  {"closed": True, "item": item}, {"closed": True, "replayed": True}, {"closed": None}):
        assert list(validator.iter_errors({**missing, **patch})), patch
    assert list(validator.iter_errors({key: value for key, value in missing.items() if key != "closed"}))
    for proof in (None, {**closure, "requestId": "bad"}, {**closure, "bookId": "bad"}, {**closure, "closedAt": "bad"}, {**closure, "actorId": identity}):
        assert list(validator.iter_errors({**closed, "closure": proof})), proof
    assert list(validator.iter_errors({**missing, "closure": closure}))
    assert list(validator.iter_errors({key: value for key, value in closed.items() if key != "closure"}))
    for patch in ({"resultHash": "bad"}, {"resultUpdatedAt": None}, {"actorId": identity}, {"action": "replace"}):
        assert list(validator.iter_errors({**result, "receipt": {**receipt, **patch}})), patch
    for patch in ({"disposition": "changed"}, {"disposition": "deleted"}, {"item": None},
                  {"receipt": None}, {"receipt": {**receipt, "action": "delete"}}, {"closed": True}):
        assert list(validator.iter_errors({**result, **patch})), patch
    deleted = {"receipt": {**receipt, "action": "delete"}, "disposition": "deleted", "item": None, "replayed": False, "closed": False, "closure": None}
    assert not list(validator.iter_errors(deleted))
    assert not list(validator.iter_errors({**deleted, "disposition": "changed", "item": item, "replayed": True}))


def test_saved_print_history_and_renewal_contract_preserve_exact_private_read_only_sources():
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    root = "/v1/editions/{editionId}/print-renders"
    history = document["paths"][root]["get"]
    renewal = document["paths"][root + "/{jobId}/download"]["get"]
    assert set(document["paths"][root]) == {"get"}
    assert set(document["paths"][root + "/{jobId}/download"]) == {"get"}
    assert not history.get("requestBody") and not renewal.get("requestBody")
    assert {p["name"] for p in renewal["parameters"] if p["in"] == "query"} == {"sha256", "fingerprint"}
    assert all(p["required"] for p in renewal["parameters"])
    for operation in (history, renewal):
        assert operation["responses"]["200"]["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"
        assert {"401", "403", "404", "422", "503"} <= operation["responses"].keys()
    assert "409" in renewal["responses"]
    validator = Draft202012Validator({**document, "$ref": "#/components/schemas/SavedPrintHistory"}, format_checker=FormatChecker())
    identity = "b0000000-0000-4000-8000-000000000003"
    render = {"jobId": identity, "createdAt": "2026-10-13T00:00:00.000Z", "fingerprint": "a" * 64,
              "source": {"bookId": identity, "editionId": identity, "jobId": identity, "assetId": identity,
                         "version": 1, "sha256": "b" * 64, "sizeBytes": 800}}
    assert not list(validator.iter_errors({"renders": [render]}))
    for patch in ({"download": {"url": "https://private.example"}}, {"storagePath": "private-path"},
                  {"fingerprint": "bad"}, {"jobId": "invalid"}):
        assert list(validator.iter_errors({"renders": [{**render, **patch}]}))
    for patch in ({"version": 2}, {"sizeBytes": 157286401}, {"sha256": "bad"}, {"plainText": "private"}):
        assert list(validator.iter_errors({"renders": [{**render, "source": {**render["source"], **patch}}]}))
    assert list(validator.iter_errors({"renders": [render] * 26}))
    download_validator = Draft202012Validator({**document, "$ref": "#/components/schemas/SavedPrintDownloadResult"}, format_checker=FormatChecker())
    artifact = {"asset": {"id": identity, "workspace_id": identity, "type": "rendered_book", "name": "book.pdf",
                           "storage_path": "workspaces/private/v1/book.pdf", "mime_type": "application/pdf", "size_bytes": 800,
                           "checksum": "b" * 64, "status": "draft", "deleted_at": None},
                "role": "rendered_print", "download": {"url": "https://private.example/saved", "expiresIn": 300}}
    result = {"jobId": identity, "status": "succeeded", "artifacts": [artifact]}
    assert not list(download_validator.iter_errors(result))
    for patch in ({"status": "running"}, {"artifacts": []}, {"artifacts": [artifact] * 3}):
        assert list(download_validator.iter_errors({**result, **patch}))
    assert list(download_validator.iter_errors({**result, "artifacts": [{**artifact, "download": {**artifact["download"], "expiresIn": 3600}}]}))


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


def narration_validator(name):
    document = load_contract((ROOT / "services/api/openapi.yaml").read_text(encoding="utf-8"))
    return document, Draft202012Validator(
        {**document, "$ref": f"#/components/schemas/{name}"},
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )


def test_narration_admission_contract_keeps_server_identity_source_and_prices_private():
    document, validator = narration_validator("CreateNarrationQuoteRequest")
    identity = "a6500000-0000-4000-8000-000000000001"
    payload = {"editionId": identity, "chapterId": identity, "modelId": "mini", "idempotencyKey": "private-original-key",
        "segmentIndex": 0, "voice": "marin", "speed": 1, "instructions": "Warm 😀.\nKeep names clear.", "consentToQuoteStorage": True}
    assert not list(validator.iter_errors(payload))
    for patch in ({"consentToQuoteStorage": False}, {"editionId": "invalid"}, {"segmentIndex": 250}, {"voice": "fable"},
        {"voice": "onyx"}, {"speed": 1.005}, {"speed": 2}, {"instructions": " padded "}, {"instructions": "\ud800"},
        {"instructions": ""}, {"instructions": "a" * 2001}, {"plainText": "client source"}, {"userId": identity},
        {"maximumTokens": []}, {"price": {}}, {"expectedCredits": "1"}):
        assert list(validator.iter_errors({**payload, **patch})), tuple(patch)
    for settings in ({"instructions": None}, {}):
        value = {k: v for k, v in payload.items() if k != "instructions"}
        assert not list(validator.iter_errors({**value, **settings}))
    operation = document["paths"]["/v1/workspaces/{workspaceId}/narration-quotes"]["post"]
    assert {"401", "403", "404", "409", "422", "500", "503"} <= operation["responses"].keys()
    recovery = document["paths"]["/v1/workspaces/{workspaceId}/narration-quotes/recover"]["post"]
    recovery_validator = Draft202012Validator(recovery["requestBody"]["content"]["application/json"]["schema"])
    assert not list(recovery_validator.iter_errors({"idempotencyKey": payload["idempotencyKey"]}))
    assert list(recovery_validator.iter_errors({"idempotencyKey": payload["idempotencyKey"], "instructions": "reread"}))
    assert not any("/narration-quotes/" in path and path.endswith(("/accept", "/job")) for path in document["paths"])


def test_narration_offer_contract_preserves_bounds_and_excludes_private_receipts():
    document, validator = narration_validator("NarrationQuote")
    identity = "a6500000-0000-4000-8000-000000000001"
    payload = {"quoteId": identity, "purchaseAvailable": False, "pricingBasis": "maximum_token_budget",
        "modelId": "mini", "model": "gpt-realtime-2.1-mini", "voice": "marin", "speed": 1,
        "source": {"bookId": identity, "editionId": identity, "chapterId": identity, "documentVersionId": identity,
            "segmentIndex": 0, "textStart": 0, "textEnd": 20},
        "reservedCredits": "1612", "priceVersion": "synthetic-price", "policyVersion": "synthetic-policy",
        "expiresAt": "2026-10-05T06:00:00.000Z", "expired": False}
    assert not list(validator.iter_errors(payload))
    for patch in ({"purchaseAvailable": True}, {"reservedCredits": "0"}, {"reservedCredits": 1612},
        {"reservedCredits": "1.5"}, {"reservedCredits": "01"}, {"model": "gpt-4o-mini-tts"}, {"voice": "nova"},
        {"request_sha256": "private"}, {"quote_json": {}}, {"instructions": "private"}, {"microUsdPerCredit": "100"}):
        assert list(validator.iter_errors({**payload, **patch})), patch
    for patch in ({"textStart": -1}, {"segmentIndex": 250}, {"documentVersionId": "invalid"}, {"plainText": "private"}):
        assert list(validator.iter_errors({**payload, "source": {**payload["source"], **patch}})), patch
    for suffix, method in (("", "post"), ("/recover", "post"), ("/{quoteId}", "get")):
        response = document["paths"][f"/v1/workspaces/{{workspaceId}}/narration-quotes{suffix}"][method]["responses"]["200"]
        assert response == {"$ref": "#/components/responses/NarrationOffer"}
    assert document["components"]["responses"]["NarrationOffer"]["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"


def test_narration_discovery_contract_exposes_boolean_gate_but_never_raw_rates():
    _, validator = narration_validator("NarrationModelOptions")
    payload = {"catalogVersion": "synthetic", "pricingBasis": "maximum_token_budget", "purchaseAvailable": False,
        "models": [{"id": "mini", "label": "Mini narration", "model": "gpt-realtime-2.1-mini", "priceVersion": "synthetic-price",
            "policyVersion": "synthetic-policy", "maxOutputTokens": 1024}],
        "voices": ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"],
        "minSpeed": 0.25, "maxSpeed": 1.5}
    assert not list(validator.iter_errors(payload))
    assert not list(validator.iter_errors({**payload, "purchaseAvailable": True}))
    for patch in ({"purchaseAvailable": "true"}, {"approvalReference": "private"}, {"maxSpeed": 2}, {"voices": ["fable"]}):
        assert list(validator.iter_errors({**payload, **patch})), patch
    for patch in ({"rates": []}, {"maxOutputTokens": 4097}, {"model": "invented-model"}):
        value = deepcopy(payload)
        value["models"][0].update(patch)
        assert list(validator.iter_errors(value)), patch


def test_whole_chapter_narration_contract_covers_aggregate_and_private_read_only_recovery():
    document, admission = narration_validator("CreateNarrationChapterQuoteRequest")
    identity = "a6500000-0000-4000-8000-000000000001"
    request = {"editionId": identity, "chapterId": identity, "modelId": "mini", "idempotencyKey": "private-chapter-key",
        "voice": "marin", "speed": 1, "instructions": "Keep names clear", "consentToQuoteStorage": True}
    assert not list(admission.iter_errors(request))
    for patch in ({"segmentIndex": 0}, {"sourceText": "client manuscript"}, {"expectedCredits": "1"}, {"consentToQuoteStorage": False},
        {"voice": "nova"}, {"instructions": " padded "}, {"instructions": "\ud800"}, {"editionId": "invalid"}, {"modelId": ""}):
        assert list(admission.iter_errors({**request, **patch})), patch
    _, projection = narration_validator("NarrationChapterQuote")
    child = {"quoteId": identity, "segmentIndex": 0, "textStart": 0, "textEnd": 100, "reservedCredits": "1612"}
    offer = {"quoteId": identity, "purchaseAvailable": False, "pricingBasis": "maximum_token_budget", "modelId": "mini",
        "model": "gpt-realtime-2.1-mini", "voice": "marin", "speed": 1,
        "source": {"bookId": identity, "editionId": identity, "chapterId": identity, "documentVersionId": identity},
        "segmentCount": 1, "segments": [child], "reservedCredits": "1612", "priceVersion": "synthetic", "policyVersion": "synthetic",
        "expiresAt": "2026-10-05T06:00:00.000Z", "expired": False}
    assert not list(projection.iter_errors(offer))
    assert not list(projection.iter_errors({**offer, "purchaseAvailable": True}))
    for patch in ({"segmentCount": 0}, {"segmentCount": 251}, {"segments": []}, {"segments": [child] * 251}, {"purchaseAvailable": "true"},
        {"instructions": "private"}, {"source_sha256": "private"}, {"idempotencyKey": "private"}, {"reservedCredits": "0"}):
        assert list(projection.iter_errors({**offer, **patch})), patch.keys()
    for patch in ({"textStart": -1}, {"quoteId": "invalid"}, {"segmentIndex": 250}, {"plainText": "private"}, {"jobId": identity}):
        assert list(projection.iter_errors({**offer, "segments": [{**child, **patch}]})), patch
    for suffix, method in (("", "post"), ("/recover", "post"), ("/{quoteId}", "get")):
        operation = document["paths"][f"/v1/workspaces/{{workspaceId}}/narration-chapter-quotes{suffix}"][method]
        assert operation["responses"]["200"] == {"$ref": "#/components/responses/NarrationChapterOffer"}
        assert {"401", "403", "422", "503"} <= operation["responses"].keys()
    recovery = document["paths"]["/v1/workspaces/{workspaceId}/narration-chapter-quotes/recover"]["post"]
    recover = Draft202012Validator(recovery["requestBody"]["content"]["application/json"]["schema"])
    assert not list(recover.iter_errors({"idempotencyKey": request["idempotencyKey"]}))
    assert list(recover.iter_errors(request)), "recovery accepts only the private key, never delivery/manuscript input"
    assert document["components"]["responses"]["NarrationChapterOffer"]["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"


def test_chapter_narration_purchase_contract_requires_exact_bounded_credits_and_both_consents():
    document, admission = narration_validator("AcceptNarrationChapterQuoteRequest")
    payload = {"expectedCredits": "3224", "consentToAiVoice": True, "consentToGenerate": True}
    for credits in ("1", "999999999", "1000000000", "2147483647"):
        assert not list(admission.iter_errors({**payload, "expectedCredits": credits}))
    for patch in ({"expectedCredits": "0"}, {"expectedCredits": "01"}, {"expectedCredits": "1.5"}, {"expectedCredits": 3224},
        {"expectedCredits": "2147483648"}, {"expectedCredits": "9999999999"}, {"expectedCredits": "1e3"},
        {"consentToAiVoice": False}, {"consentToGenerate": False}, {"consentToAiVoice": "true"},
        {"catalog": {}}, {"userId": "private"}, {"instructions": "private"}, {"sourceText": "private"}, {"projectId": "private"}):
        assert list(admission.iter_errors({**payload, **patch})), patch
    for missing in payload:
        assert list(admission.iter_errors({key: value for key, value in payload.items() if key != missing}))
    operation = document["paths"]["/v1/workspaces/{workspaceId}/narration-chapter-quotes/{quoteId}/accept"]["post"]
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/AcceptNarrationChapterQuoteRequest"}
    assert {"401", "403", "404", "409", "422", "503"} <= operation["responses"].keys()
    assert operation["responses"]["200"] == {"$ref": "#/components/responses/NarrationChapterAccepted"}
    assert document["security"] == [{"bearerAuth": []}]


def test_chapter_narration_acceptance_status_is_read_only_scoped_and_strictly_public():
    document, projection = narration_validator("NarrationChapterAcceptance")
    identity = "a6500000-0000-4000-8000-000000000001"
    unaccepted = {"quoteId": identity, "accepted": False, "project": None}
    accepted = {"quoteId": identity, "accepted": True,
        "project": {"id": identity, "billingMode": "quoted", "status": "queued", "reservedCredits": "3224"}}
    assert not list(projection.iter_errors(unaccepted))
    for status in ("queued", "running", "succeeded", "failed"):
        assert not list(projection.iter_errors({**accepted, "project": {**accepted["project"], "status": status}}))
    for patch in ({"quoteId": "invalid"}, {"accepted": "true"}, {"project": None}, {"accepted": False},
        {"receipt": {}}, {"instructions": "private"}, {"expectedCredits": "3224"}):
        assert list(projection.iter_errors({**accepted, **patch})), patch
    for patch in ({"id": "invalid"}, {"billingMode": "operational"}, {"status": "unknown"}, {"reservedCredits": "0"},
        {"reservedCredits": "2147483648"}, {"reservedCredits": 3224}, {"signedUrl": "private"}, {"usage": {}}, {"createdBy": identity}):
        assert list(projection.iter_errors({**accepted, "project": {**accepted["project"], **patch}})), patch
    _, confirmed = narration_validator("NarrationChapterAccepted")
    assert not list(confirmed.iter_errors(accepted))
    assert list(confirmed.iter_errors(unaccepted)), "purchase success must authoritatively confirm acceptance"
    operation = document["paths"]["/v1/workspaces/{workspaceId}/narration-chapter-quotes/{quoteId}/project"]["get"]
    assert "requestBody" not in operation
    assert {"401", "403", "404", "422", "503"} <= operation["responses"].keys()
    assert operation["responses"]["200"] == {"$ref": "#/components/responses/NarrationChapterAcceptance"}
    for name in ("NarrationChapterAccepted", "NarrationChapterAcceptance"):
        assert document["components"]["responses"][name]["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"
    for method, suffix in (("post", "accept"), ("get", "project")):
        path = document["paths"][f"/v1/workspaces/{{workspaceId}}/narration-chapter-quotes/{{quoteId}}/{suffix}"][method]
        for param in path["parameters"]:
            parameter_validator = Draft202012Validator(param["schema"], format_checker=FormatChecker())
            assert not list(parameter_validator.iter_errors(identity))
            assert list(parameter_validator.iter_errors("invalid"))


def test_saved_narration_history_contract_distinguishes_budgets_and_legacy_units():
    document, validator = narration_validator("AudiobookProject")
    identity = "a6500000-0000-4000-8000-000000000001"
    project = {"id": identity, "editionId": identity, "chapterId": identity, "documentVersionId": identity,
        "voice": "marin", "speed": 1, "billingMode": "quoted", "status": "queued", "segmentCount": 2,
        "creditUnits": 3224, "createdAt": "2026-10-05T00:00:00Z", "completedAt": None,
        "aiVoiceDisclosureRequired": True, "segments": [{"index": 0, "status": "queued", "failureCode": None,
            "asset": None, "download": None}]}
    assert not list(validator.iter_errors(project))
    assert not list(validator.iter_errors({**project, "billingMode": "operational", "voice": "fable", "speed": 4, "creditUnits": 5}))
    for patch in ({"billingMode": None}, {"billingMode": "unknown"}, {"creditUnits": "3224"}, {"creditUnits": 0},
        {"aiVoiceDisclosureRequired": False}, {"instructions": "private"}, {"quote_json": {}}, {"status": "unknown"}):
        assert list(validator.iter_errors({**project, **patch})), patch
    assert list(validator.iter_errors({key: value for key, value in project.items() if key != "billingMode"}))
    segment = project["segments"][0]
    signed = {"url": "https://private.example/audio.mp3", "expiresIn": 300}
    assert not list(validator.iter_errors({**project, "segments": [{**segment, "status": "succeeded", "download": signed}]}))
    for patch in ({"expiresIn": 3600}, {"url": "not-a-url"}, {"receipt": {}}):
        assert list(validator.iter_errors({**project, "segments": [{**segment, "download": {**signed, **patch}}]})), patch
    for path, parameter, schema in (("/v1/editions/{editionId}/audiobook-jobs", "editionId", "AudiobookProjectHistory"),
        ("/v1/audiobook-jobs/{projectId}", "projectId", "AudiobookProject")):
        operation = document["paths"][path]["get"]
        assert "requestBody" not in operation
        assert {"401", "404", "500", "503"} <= operation["responses"].keys()
        response = operation["responses"]["200"]
        assert response["headers"]["Cache-Control"]["schema"]["const"] == "private, no-store"
        assert response["content"]["application/json"]["schema"] == {"$ref": f"#/components/schemas/{schema}"}
        assert operation["parameters"] == [{"in": "path", "name": parameter, "required": True,
            "schema": {"type": "string", "format": "uuid"}}]
