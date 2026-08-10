"""Document worker: consumes jobs.document, calls the document parse service.

Payload per spec section 10:
  jobId, assetId, operation, inputPath, idempotencyKey, attempt

Redis wiring is a TODO; process_job() is the testable seam.
"""
import json
import os
import urllib.request

DOCUMENT_SERVICE_URL = os.environ.get("DOCUMENT_SERVICE_URL", "http://localhost:8001")


def process_job(payload: dict, url: str = DOCUMENT_SERVICE_URL) -> dict:
    """Run one document job: parse the asset via the document service.

    Idempotent by caller contract (idempotencyKey dedup at queue level, TODO with Redis).
    """
    if payload.get("operation") != "parse":
        raise ValueError(f"unsupported operation: {payload.get('operation')}")
    body = json.dumps({
        "assetId": payload["assetId"],
        "format": payload["format"],
        "storagePath": payload["inputPath"],
        "title": payload.get("title", "Untitled"),
    }).encode()
    req = urllib.request.Request(f"{url}/parse", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def run() -> None:
    """Consume jobs.document from Redis (at-least-once).

    TODO(Step 5+): wire Redis consumer — BLPOP jobs.document, dedupe on
    idempotencyKey, call process_job(), store result on the asset row.
    Graceful shutdown + dead-letter live in workers/ops.py:
        from ops import run_loop
        run_loop("jobs.document", process_job, fetch=redis_blpop)
    Failed after MAX_ATTEMPTS -> dead-letter record (see ops.dead_letter).
    """
    raise NotImplementedError("Redis queue wiring TODO; use process_job() directly")


if __name__ == "__main__":
    run()
