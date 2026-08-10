"""Document import/normalization service. Importers land in Step 5."""
from fastapi import FastAPI

app = FastAPI(title="bookworm-document")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
