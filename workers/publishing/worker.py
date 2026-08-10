"""Publishing worker: consumes jobs.publishing from Redis (external API retries).

Payload per spec section 10:
  jobId, editionId, channel, idempotencyKey, attempt

Stub only — Redis consumer implemented in Step 10.
"""


def run() -> None:
    """Consume jobs.publishing and call channel adapters. Not implemented yet.

    Graceful shutdown + dead-letter live in workers/ops.py:
        from ops import run_loop
        run_loop("jobs.publishing", process_job, fetch=redis_blpop)
    """
    raise NotImplementedError("Publishing worker lands in Step 10")


if __name__ == "__main__":
    run()
