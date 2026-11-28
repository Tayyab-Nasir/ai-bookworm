FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY scanning_service ./scanning_service

USER 65532:65532
EXPOSE 8004
CMD ["uvicorn", "scanning_service.main:app", "--host", "0.0.0.0", "--port", "8004", "--no-server-header"]
