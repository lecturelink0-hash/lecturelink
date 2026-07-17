FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8787 \
    CPX_DB_PATH=/data/cpx.sqlite3

WORKDIR /app

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

COPY data /app/data
COPY server /app/server
RUN mkdir -p /data

WORKDIR /app/server

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:' + __import__('os').environ.get('PORT', '8787') + '/api/health', timeout=3)"

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
