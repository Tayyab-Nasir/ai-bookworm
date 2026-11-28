"""Reserved entry point for a future durable AI queue.

AI review jobs currently execute synchronously through the API and AI service;
the database remains the durable record of each request and suggestion.
"""


def run() -> None:
    """Reject accidental deployment until a reconstructable queue is added."""
    raise RuntimeError("No standalone AI consumer is configured; run AI jobs through the API")


if __name__ == "__main__":
    run()
