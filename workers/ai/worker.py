"""AI worker: consumes jobs.ai from Redis (at-least-once, idempotent).

Payload per spec section 10:
  jobId, workspaceId, bookId, agentType, inputRef, idempotencyKey, attempt

Stub only — Redis consumer implemented in Step 7.
"""


def run() -> None:
    """Consume jobs.ai and dispatch to the AI service. Not implemented yet."""
    raise NotImplementedError("AI worker lands in Step 7")


if __name__ == "__main__":
    run()
