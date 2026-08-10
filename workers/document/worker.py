"""Document worker: consumes jobs.document from Redis (sandboxed).

Payload per spec section 10:
  jobId, assetId, operation, inputPath, idempotencyKey, attempt

Stub only — Redis consumer implemented in Step 5.
"""


def run() -> None:
    """Consume jobs.document and run import/parse operations. Not implemented yet."""
    raise NotImplementedError("Document worker lands in Step 5")


if __name__ == "__main__":
    run()
