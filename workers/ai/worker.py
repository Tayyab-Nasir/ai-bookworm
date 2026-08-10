"""AI worker: consumes jobs.ai from Redis (at-least-once, idempotent).

Payload per spec section 10:
  jobId, workspaceId, bookId, agentType, inputRef, idempotencyKey, attempt

Stub only — Redis consumer implemented in Step 7.
"""


def run() -> None:
    """Consume jobs.ai and dispatch to the AI service. Not implemented yet.

    Graceful shutdown + dead-letter live in workers/ops.py:
        from ops import run_loop
        run_loop("jobs.ai", process_job, fetch=redis_blpop)
    """
    raise NotImplementedError("AI worker lands in Step 7")


if __name__ == "__main__":
    run()
