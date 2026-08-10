"""Publishing channel adapters service. Adapters land in Step 10."""
from fastapi import FastAPI

app = FastAPI(title="bookworm-publishing")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8003)
