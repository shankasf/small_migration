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

Built by GitHub Actions (`.github/workflows/deploy.yml`) with Buildx and
pushed to ECR (`circini-frontend|backend|ai-service`), tagged `sha-<short-sha>`.
Tags are immutable and never overwritten, so a running task always traces back
to one commit and any earlier build can be redeployed as-is.

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
`circini/integration-encryption-key` protects per-user Snowflake, dbt, GitHub,
and GitLab credentials before they are persisted. After registering the OAuth
apps with callback URLs `https://<AppDomain>/api/integrations/github/callback`
and `https://<AppDomain>/api/integrations/gitlab/callback`, populate their
Secrets Manager records:

```bash
aws secretsmanager put-secret-value --secret-id circini/github-oauth \
  --secret-string '{"clientId":"...","clientSecret":"..."}'
aws secretsmanager put-secret-value --secret-id circini/gitlab-oauth \
  --secret-string '{"clientId":"...","clientSecret":"..."}'
```

Until those values are supplied, the UI reports the providers as requiring
administrator setup rather than presenting a non-functional Connect action.

### Public GitHub App

GitHub uses a public GitHub App with read-only Contents/Metadata permissions.
Register it for **Any account**, with these settings:

- Homepage: `https://migration-agent.uat.signify.net.nz`
- Callback: `https://migration-agent.uat.signify.net.nz/api/integrations/github/callback`
- Request user authorization during installation; keep expiring user tokens enabled.
- Webhook: `https://migration-agent.uat.signify.net.nz/api/integrations/github/webhook`
- Webhook content type: JSON, SSL verification enabled, and a random webhook secret.
- Subscribe to installation/repository-access events. Authorization revocations are also handled.

The `circini/github-oauth` JSON secret must contain `appId`, `slug`, `clientId`,
`clientSecret`, `privateKey` (the complete PEM), and `webhookSecret`. All fields
are strings. The PEM is not the client secret. Never commit these credentials.
To bootstrap through the existing OIDC deployment pipeline, save that JSON as
the masked repository secret `CIRCINI_GITHUB_APP_BOOTSTRAP_JSON`. The deployment
validates app identity, read-only permissions, and client credentials before
updating Secrets Manager and replacing backend tasks. Delete the temporary
Actions secret after a successful deployment; subsequent releases read AWS.

Users authorize their own GitHub account, install the app on chosen repositories,
then select a repository and branch in Settings. Repository reads use user
access tokens, restricting access to the intersection of user and installation
permissions. Refresh tokens rotate under a database row lock. Installation
IDs from redirects never grant access. Signed webhooks clear removed repository
selections and revoked connections. Connecting does not yet import repository
files into an AI migration session.

## CI/CD (GitHub Actions → ECR + CloudFormation)

`.github/workflows/deploy.yml` runs on every push to `main`: CI gate → build the
three images and push to ECR → `cloudformation deploy` all four stacks → run the
schema-sync task → roll the services → smoke-test `https://<AppDomain>`. It
authenticates with a short-lived GitHub OIDC token (no static AWS keys).

One-time setup (needs an admin identity — creating IAM roles is not in the
PowerUser set):

```bash
# 1. Create the OIDC provider + deploy role
aws cloudformation deploy --stack-name circini-github-oidc \
  --template-file deploy/aws/github-oidc.yaml --capabilities CAPABILITY_NAMED_IAM
ROLE=$(aws cloudformation describe-stacks --stack-name circini-github-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)

# 2. Point the repo at it (plus deploy config as repo variables)
gh variable set AWS_DEPLOY_ROLE_ARN --body "$ROLE"
gh variable set AWS_REGION        --body ap-southeast-2
gh variable set APP_DOMAIN        --body migration-agent.uat.signify.net.nz
gh variable set AUTH_MODE         --body oidc
gh variable set OPENAI_MODEL      --body gpt-6-astra
gh variable set CERTIFICATE_ARN   --body <acm-cert-arn>   # from `aws acm list-certificates`
```

The OpenAI API key is **not** a repo secret — it lives in Secrets Manager
(`circini/openai-api-key`) and is rotated with `put-secret-value`.

## Status

- HTTPS: live — ACM cert, Hostinger CNAME to the ALB, 443 listener, HTTP→HTTPS redirect.
- Identity: live — Amazon Cognito, `AUTH_MODE=oidc`, TOTP MFA required, embedded in-app sign-in.
- Optional add-ons: OTel collector deployed (ADOT sidecars). WAF and Multi-AZ RDS not deployed.

## Signify domain

The public app uses `https://migration-agent.uat.signify.net.nz`. Its CNAME
points to `circini-demo-617813330.ap-southeast-2.elb.amazonaws.com`, with ACM
certificate `5f12ecf3-ce00-4840-ac77-e4b0ce039953` in `ap-southeast-2`.

Repository variables `APP_DOMAIN` and `CERTIFICATE_ARN` select the origin.
This is now the only public domain: the former `migration.callsphere.site`
origin is retired. `ADDITIONAL_CERTIFICATE_ARN`, `ADDITIONAL_APP_URL` and
`INTEGRATION_APP_DOMAIN` exist only to bridge a domain move and are left
unset, so the retired certificate is off the 443 listener, Cognito keeps no
callback or logout URL for it, and provider authorization callbacks return
through the Signify domain.

For this move, dispatch `production-status.yml` with
`configure_signify_domain=true`. The script checks the issued certificate and
existing DNS, records before-state and guarded change sets, preserves deployed
images, waits for ECS readiness, and runs the public/security smoke checks.
It shares the production deployment lock. Normal status dispatches remain
read-only. This workflow does not change repository variables; set the five
variables above to the verified stack parameters after successful migration.
