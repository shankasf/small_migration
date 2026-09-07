#!/bin/bash

# Deploy script that reads from .env and creates Kubernetes resources
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root is two levels up: deploy/kubernetes -> deploy -> root
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# Check if .env file exists
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env file not found at $ENV_FILE"
    exit 1
fi

# Load environment variables from .env
set -a
source "$ENV_FILE"
set +a

echo "Creating Kubernetes resources from .env..."

# Create ConfigMap from non-sensitive env vars
# Server-side apply avoids the kubectl.kubernetes.io/last-applied-configuration
# annotation that would otherwise embed values in plaintext on the object.
kubectl create configmap migration-agent-config \
    --namespace=migration-agent \
    --from-literal=PORT="${PORT}" \
    --from-literal=AI_SERVICE_URL="${AI_SERVICE_URL}" \
    --from-literal=CORS_ORIGIN="${CORS_ORIGIN}" \
    --from-literal=OUTPUT_DIR="${OUTPUT_DIR}" \
    --from-literal=OPENAI_MODEL="${OPENAI_MODEL}" \
    --dry-run=client -o yaml \
    | kubectl apply --server-side --force-conflicts -f -

# Create Secret from sensitive env vars
# Server-side apply is required for Secrets so the base64 values are NOT
# stored in the last-applied-configuration annotation.
kubectl create secret generic migration-agent-secret \
    --namespace=migration-agent \
    --from-literal=DATABASE_URL="${DATABASE_URL}" \
    --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY}" \
    --from-literal=INTEGRATION_ENCRYPTION_KEY="${INTEGRATION_ENCRYPTION_KEY:-}" \
    --from-literal=GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-}" \
    --from-literal=GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-}" \
    --from-literal=GITLAB_CLIENT_ID="${GITLAB_CLIENT_ID:-}" \
    --from-literal=GITLAB_CLIENT_SECRET="${GITLAB_CLIENT_SECRET:-}" \
    --dry-run=client -o yaml \
    | kubectl apply --server-side --force-conflicts -f -

echo "ConfigMap and Secret updated from .env"

# Apply the deployment
kubectl apply -f "$SCRIPT_DIR/deployment.yaml"

echo "Deployment applied successfully"

# Optionally restart deployments to pick up new config
if [ "$1" == "--restart" ]; then
    echo "Restarting deployments..."
    kubectl rollout restart deployment/backend -n migration-agent
    kubectl rollout restart deployment/frontend -n migration-agent
    kubectl rollout restart deployment/ai-service -n migration-agent
    echo "Deployments restarted"
fi
