# Production image. Source is baked in — nothing is mounted from the host, and
# there is no --reload watcher, so the running code cannot change in place.
FROM python:3.12-slim

WORKDIR /app

# Pick up OS security fixes published since the base image was built.
RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LANGGRAPH_STRICT_MSGPACK=true

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Output directory — mounted over by the outputs PVC in Kubernetes. The pod
# sets fsGroup so the mounted volume is group-writable by this user.
# perl-base is an essential Debian package, but nothing in this image runs Perl.
# Removing it last drops Perl CVEs Debian has not fixed (CVE-2026-13221,
# CVE-2026-42496, CVE-2026-8376), which the deploy's image scan blocks on.
RUN mkdir -p /data/outputs \
 && useradd --system --uid 10001 --create-home appuser \
 && chown -R appuser:appuser /app /data/outputs \
 && dpkg --purge --force-remove-essential --force-depends perl-base
USER appuser

EXPOSE 8084

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8084"]
