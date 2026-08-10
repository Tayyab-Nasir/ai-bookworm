"""Render worker: consumes jobs.render from Redis (deterministic output).

Payload per spec section 10:
  jobId, editionId, format, bookVersionId, idempotencyKey, attempt

Stub only — Redis consumer implemented in Step 10.
"""


def run() -> None:
    """Consume jobs.render and produce EPUB/PDF artifacts. Not implemented yet."""
    raise NotImplementedError("Render worker lands in Step 10")


if __name__ == "__main__":
    run()
