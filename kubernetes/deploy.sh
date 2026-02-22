#!/bin/bash

# Deploy script that reads from .env and creates Kubernetes resources
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
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
kubectl create configmap migration-agent-config \
    --namespace=migration-agent \
    --from-literal=PORT="${PORT}" \
    --from-literal=AI_SERVICE_URL="${AI_SERVICE_URL}" \
    --from-literal=CORS_ORIGIN="${CORS_ORIGIN}" \
    --from-literal=OUTPUT_DIR="${OUTPUT_DIR}" \
    --from-literal=OPENAI_MODEL="${OPENAI_MODEL}" \
    --dry-run=client -o yaml | kubectl apply -f -

# Create Secret from sensitive env vars
kubectl create secret generic migration-agent-secret \
    --namespace=migration-agent \
    --from-literal=DATABASE_URL="${DATABASE_URL}" \
    --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -

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
