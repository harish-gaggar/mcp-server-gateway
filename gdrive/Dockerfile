FROM python:3.13-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache gcc musl-dev libffi-dev wget ca-certificates

# Optional corporate root CA (TLS-inspecting proxy). No-op when certs/ is empty.
COPY certs/ /usr/local/share/ca-certificates/
RUN if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then \
      update-ca-certificates && \
      echo "Installed corporate CA(s) into the system trust store"; \
    fi

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY server.py .

# Make the script executable
RUN chmod +x server.py

# Expose the MCP server port
EXPOSE 8092

# Set environment variables (will be overridden by docker-compose)
ENV HOST="0.0.0.0"
ENV PORT="8092"

# Run the MCP server
CMD ["python", "server.py"]
