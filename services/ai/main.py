"""AI gateway/agents service. Real agents land in Step 7."""
from fastapi import FastAPI

app = FastAPI(title="bookworm-ai")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
