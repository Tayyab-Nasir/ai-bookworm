"""Render worker: consumes jobs.render from Redis (deterministic output).

Payload per spec section 10:
  jobId, editionId, format, bookVersionId, idempotencyKey, attempt

Stub only — Redis consumer implemented in Step 10.
"""


def run() -> None:
    """Consume jobs.render and produce EPUB/PDF artifacts. Not implemented yet.

    Graceful shutdown + dead-letter live in workers/ops.py:
        from ops import run_loop
        run_loop("jobs.render", process_job, fetch=redis_blpop)
    """
    raise NotImplementedError("Render worker lands in Step 10")


if __name__ == "__main__":
    run()
