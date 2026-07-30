# Production image. Source is baked in — nothing is mounted from the host, and
# there is no --reload watcher, so the running code cannot change in place.
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Output directory — mounted over by the outputs PVC in Kubernetes
RUN mkdir -p /data/outputs

EXPOSE 8084

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8084"]
