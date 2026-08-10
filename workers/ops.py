"""Shared worker ops: graceful shutdown + dead-letter (PRD-SOW section 29).

GracefulShutdown: SIGTERM/SIGINT set a flag; the consume loop checks it
between jobs, finishes the current job, then exits.

Dead letter: a job that fails after MAX_ATTEMPTS is written to
dead_letter_jobs and not retried further.
TODO: Supabase/Redis not wired into workers yet — dead_letter() writes to
$DLQ_PATH (default ./dead-letter.jsonl, newline-delimited JSON). Swap the
write for an insert into public.dead_letter_jobs when the service client
lands.
"""
import json
import os
import signal
import time

MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "5"))
DLQ_PATH = os.environ.get("DLQ_PATH", "./dead-letter.jsonl")


class GracefulShutdown:
    def __init__(self) -> None:
        self.requested = False
        signal.signal(signal.SIGTERM, self._handle)
        signal.signal(signal.SIGINT, self._handle)

    def _handle(self, signum, _frame) -> None:
        # Flag only — the running job finishes, the loop exits cleanly.
        self.requested = True


def dead_letter(queue: str, job_type: str, job_id: str | None, payload: dict,
                attempts: int, error: str, path: str = DLQ_PATH) -> dict:
    record = {
        "queue": queue, "job_type": job_type, "job_id": job_id,
        # payload must contain refs only — never manuscript text (SPEC 17)
        "payload_json": payload, "attempts": attempts, "error": error,
        "failed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    # TODO(Step 14 follow-up): insert into public.dead_letter_jobs instead.
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    return record


def run_loop(queue: str, process, fetch, attempts_key: str = "attempt") -> None:
    """Generic consume loop. fetch() -> job dict or None; process(job) raises
    on failure. Exits on shutdown flag after the in-flight job finishes."""
    stop = GracefulShutdown()
    while not stop.requested:
        job = fetch()
        if job is None:
            time.sleep(1)
            continue
        try:
            process(job)
        except Exception as e:  # noqa: BLE001 — top of loop must not die
            attempts = int(job.get(attempts_key, 0)) + 1
            if attempts >= MAX_ATTEMPTS:
                dead_letter(queue, job.get("jobType", "unknown"),
                            job.get("jobId"), job, attempts, str(e))
            # else: requeue with attempt+1 — TODO with Redis wiring
