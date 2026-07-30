#!/usr/bin/env bash
# One-time cluster bootstrap for CD. Creates the namespace and a deploy
# ServiceAccount scoped to that namespace only — the CD runner never holds
# cluster-admin.
#
# Run once as a cluster admin:  deploy/kubernetes/bootstrap.sh
set -euo pipefail

NS=migration-agent

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: deployer
  namespace: $NS
---
# 'admin' is a built-in role, but bound with a RoleBinding it grants rights
# only inside this namespace — not cluster-wide.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deployer-admin
  namespace: $NS
subjects:
  - kind: ServiceAccount
    name: deployer
    namespace: $NS
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io
---
# Long-lived token for the runner's kubeconfig.
apiVersion: v1
kind: Secret
metadata:
  name: deployer-token
  namespace: $NS
  annotations:
    kubernetes.io/service-account.name: deployer
type: kubernetes.io/service-account-token
EOF

echo "Bootstrapped namespace '$NS' and the scoped 'deployer' ServiceAccount."
echo "Build the runner kubeconfig with: deploy/kubernetes/runner-kubeconfig.sh"
