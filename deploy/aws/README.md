# AWS deployment — CloudFormation

Implements `docs/AWS_DEPLOYMENT_ARCHITECTURE.md` (v5.0) with the §8-decision-1
variant: **Amazon Cognito instead of Keycloak**. Region: `ap-southeast-2`,
account `026146807914`.

## Stacks (deploy in order)

| Stack | Template | Contents |
|-------|----------|----------|
| `circini-network` | `network.yaml` | VPC 10.20.0.0/16, 2 public + 2 app + 2 data subnets, 1 NAT GW, sg-alb / sg-app / sg-data |
| `circini-data` | `data.yaml` | RDS PostgreSQL 16 `db.t4g.small` (encrypted, 7-day backups) + all app secrets in Secrets Manager under `circini/*` |
| `circini-cognito` | `cognito.yaml` | User pool `circini-demo`, groups admin/analyst/auditor, SPA client (code + PKCE), hosted-UI domain |
| `circini-app` | `app.yaml` | ECS Fargate cluster + Service Connect (`backend:3001`, `ai-service:8084`), ALB (80, idle 660s, sticky backend TG), task defs incl. one-off `circini-schema-sync` |

```bash
aws cloudformation deploy --stack-name circini-network --template-file network.yaml
aws cloudformation deploy --stack-name circini-data    --template-file data.yaml
aws cloudformation deploy --stack-name circini-cognito --template-file cognito.yaml
aws cloudformation deploy --stack-name circini-app     --template-file app.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ImageTag=<git-sha>
```

## Images

Built with nerdctl on the K3s host, pushed to ECR
(`circini-frontend|backend|ai-service`, tagged with the git short SHA + `latest`).

## Per-deploy steps

1. Build + push images with a new tag; `deploy` the app stack with `ImageTag=<tag>`.
2. Run schema-sync (Fargate one-off, replaces the K8s init container):

```bash
aws ecs run-task --cluster circini-demo --launch-type FARGATE \
  --task-definition circini-schema-sync \
  --network-configuration "awsvpcConfiguration={subnets=[<app-subnets>],securityGroups=[<sg-app>],assignPublicIp=DISABLED}"
```

## Secrets

All under `circini/*` in Secrets Manager; generated at stack creation except
`circini/openai-api-key`, which is set manually:

```bash
aws secretsmanager put-secret-value --secret-id circini/openai-api-key --secret-string 'sk-...'
```

`circini/database-url` embeds the RDS endpoint + master password (resolved at
deploy time — re-deploy `circini-data` if the password rotates).

## Still pending

- HTTPS: ACM cert + DNS (Hostinger CNAME) + 443 listener; then set CORS_ORIGIN to the https origin.
- Cognito wiring: backend `AUTH_MODE=oidc` change (doc §3.1) + frontend OIDC client; currently `AUTH_MODE=local`.
- Optional add-ons (WAF, OTel collector, Multi-AZ): not deployed.
