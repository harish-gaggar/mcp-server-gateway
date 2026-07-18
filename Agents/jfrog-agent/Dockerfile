FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY jfrog_agent ./jfrog_agent
COPY app.py run.py ./

# Streamlit UI + OAuth loopback callback
EXPOSE 8501 8777

# Persist the one-time OAuth token + audit trail across restarts.
ENV JFROG_AGENT_TOKEN_CACHE=/data/token.json \
    JFROG_AGENT_AUDIT_DIR=/data/audit \
    JFROG_AGENT_OAUTH_BIND_HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8501/_stcore/health')" || exit 1

CMD ["streamlit", "run", "app.py", \
     "--server.address=0.0.0.0", "--server.port=8501", \
     "--server.headless=true", "--browser.gatherUsageStats=false"]
