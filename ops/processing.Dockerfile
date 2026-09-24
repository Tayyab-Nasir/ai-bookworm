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

FROM base AS epubcheck-enabled
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl unzip \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --silent --show-error \
      https://github.com/w3c/epubcheck/releases/download/v5.4.0/epubcheck-5.4.0.zip \
      --output /tmp/epubcheck-5.4.0.zip \
    && echo '33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c  /tmp/epubcheck-5.4.0.zip' | sha256sum --check \
    && unzip -q /tmp/epubcheck-5.4.0.zip -d /opt \
    && rm /tmp/epubcheck-5.4.0.zip
ENV EPUBCHECK_JAR=/opt/epubcheck-5.4.0/epubcheck.jar
USER 65532:65532

FROM epubcheck-enabled AS rendering
WORKDIR /app/services/rendering
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]

FROM epubcheck-enabled AS publishing
WORKDIR /app/services/publishing
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
