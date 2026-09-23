FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY services/document/requirements.txt /tmp/document-requirements.txt
COPY services/rendering/requirements.txt /tmp/rendering-requirements.txt
COPY services/publishing/requirements.txt /tmp/publishing-requirements.txt
RUN pip install -r /tmp/document-requirements.txt -r /tmp/rendering-requirements.txt -r /tmp/publishing-requirements.txt
COPY services/document /app/services/document
COPY services/rendering /app/services/rendering
COPY services/publishing /app/services/publishing
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"

FROM base AS document
WORKDIR /app/services/document
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]

FROM base AS rendering
WORKDIR /app/services/rendering
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]

FROM base AS publishing
WORKDIR /app/services/publishing
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
