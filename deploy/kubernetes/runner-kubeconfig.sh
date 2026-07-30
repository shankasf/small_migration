#!/usr/bin/env bash
# Builds a kubeconfig for the CD runner from the namespace-scoped 'deployer'
# ServiceAccount. The result grants rights inside migration-agent only.
#
# Usage: deploy/kubernetes/runner-kubeconfig.sh [output-path]
set -euo pipefail

NS=migration-agent
OUT="${1:-/home/github-runner/.kube/config}"
SERVER="${KUBE_SERVER:-https://127.0.0.1:6443}"

TOKEN=$(kubectl -n "$NS" get secret deployer-token -o jsonpath='{.data.token}' | base64 -d)
CA=$(kubectl -n "$NS" get secret deployer-token -o jsonpath='{.data.ca\.crt}')

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: k3s
    cluster:
      server: ${SERVER}
      certificate-authority-data: ${CA}
contexts:
  - name: deployer
    context:
      cluster: k3s
      namespace: ${NS}
      user: deployer
current-context: deployer
users:
  - name: deployer
    user:
      token: ${TOKEN}
EOF
chmod 600 "$OUT"
echo "Wrote $OUT (ServiceAccount deployer, namespace ${NS})"
