FROM python:3.13-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache gcc musl-dev libffi-dev wget

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY server.py .

# Make the script executable
RUN chmod +x server.py

# Expose the MCP server port
EXPOSE 8091

# Set environment variables (will be overridden by docker-compose)
ENV ARTIFACTORY_BASE_URL=""
ENV ARTIFACTORY_ACCESS_TOKEN=""
ENV HOST="0.0.0.0"
ENV PORT="8091"

# Run the MCP server
CMD ["python", "server.py"]
