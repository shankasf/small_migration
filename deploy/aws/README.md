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

Application secrets live under `circini/*` in Secrets Manager. Most are generated
at stack creation. Populate `circini/bedrock-api-key` with a credential authorized
for GPT-OSS 120B and Titan Text Embeddings V2 in `ap-southeast-2`:

```bash
aws secretsmanager put-secret-value --secret-id circini/bedrock-api-key \
  --secret-string file:///secure/bedrock-key.txt
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
gh variable set LLM_PROVIDER      --body bedrock
gh variable set BEDROCK_REGION    --body ap-southeast-2
gh variable set BEDROCK_MODEL     --body openai.gpt-oss-120b-1:0
gh variable set APPROVED_LLM_HOST --body bedrock-runtime.ap-southeast-2.amazonaws.com
gh variable set PROCESSING_REGION --body ap-southeast-2
gh variable set CERTIFICATE_ARN   --body <acm-cert-arn>   # from `aws acm list-certificates`
```

The Bedrock credential lives in Secrets Manager and is rotated with
`put-secret-value`. The Bedrock deployment does not inject an OpenAI API key.
Embeddings use `amazon.titan-embed-text-v2:0`, normalized, at 1,024 dimensions
in Sydney. The release adds separate Titan columns and rebuilds file/chat
indexes; existing OpenAI columns remain available for rollback.

## Fresh environment: complete order

This repository currently targets one named environment per AWS account/region.
For a new AWS account in `ap-southeast-2`, keep the `circini-*` names. For a second
environment in the same account, first parameterize resource names, CloudFormation
exports/imports, IAM policies, repository workflow targets, verification scripts,
and business-hours controller. Changing only a stack name is insufficient.

1. **Prepare the repository and account.** Clone the current `main`; install AWS
   CLI v2 and GitHub CLI, then authenticate to the target account and repository.
   Initial bootstrap requires permission to create IAM roles. Use a separate
   repository or parameterized workflows so changing deployment variables cannot
   redirect the existing production repository to a new account accidentally.
2. **Create a domain certificate.** Request an ACM certificate in `ap-southeast-2`
   for the new hostname and complete its DNS validation. Record the issued ARN.
3. **Bootstrap OIDC.** Deploy `github-oidc.yaml` using the setup commands above.
   For a different repository, pass `GitHubOrg` and `GitHubRepo`; if an account
   already has GitHub's OIDC provider, pass `ExistingProviderArn`. Set the returned
   `DeployRoleArn` as `AWS_DEPLOY_ROLE_ARN` in the target repository.
4. **Create base infrastructure before the first pipeline.** From the repository
   root, run:

   ```bash
   export AWS_DEFAULT_REGION=ap-southeast-2
   aws cloudformation deploy --stack-name circini-network --template-file deploy/aws/network.yaml
   aws cloudformation deploy --stack-name circini-data --template-file deploy/aws/data.yaml
   aws cloudformation deploy --stack-name circini-cognito --template-file deploy/aws/cognito.yaml \
     --parameter-overrides AppUrl=https://YOUR_DOMAIN
   ```

   This provisions the private PostgreSQL database, generated application secrets,
   Cognito user pool, and networking. Choose subnet CIDRs before creating the VPC;
   subnet CIDRs are currently fixed in `network.yaml`.
5. **Create the image repositories before building.** For each of
   `circini-frontend`, `circini-backend`, and `circini-ai-service`, create an ECR
   repository with immutable tags and scan-on-push enabled. Example:

   ```bash
   aws ecr create-repository --repository-name circini-backend \
     --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true
   ```
6. **Populate and verify Bedrock credentials.** Confirm the account can invoke
   `openai.gpt-oss-120b-1:0` and `amazon.titan-embed-text-v2:0` in Sydney, then
   populate `circini/bedrock-api-key` as above. Do this before launching CI:
   agent evaluations load this secret before the deployment job runs.
7. **Configure the GitHub App.** Use the Public GitHub App section above, replacing
   its URLs with the new hostname. Supply all six fields through the AWS secret
   or `CIRCINI_GITHUB_APP_BOOTSTRAP_JSON` repository secret. This is required by
   the current pipeline even if users do not immediately connect repositories.
   GitLab credentials are optional. `LANGSMITH_API_KEY` is optional for trace and
   evaluation-report export; local evaluation gates still run without it.
8. **Set repository configuration.** Set the variables in the OIDC setup section
   using the new domain, issued certificate ARN, target deploy role, and Bedrock
   values. Create the GitHub environment named `production` used by the workflow.
   Record the operator's provider approval reference where applicable.
9. **Prepare first-login and verification identities.** With `AUTH_MODE=oidc`,
   create an administrator in Cognito and add it to the `admin` group. The
   `SEED_ADMIN_*` secret only seeds users in local authentication mode. The admin
   must sign in after schema creation to create its application record. Before
   the first release, adapt the live verification scripts' existing account
   references (including `sagar@callsphere.ai`) to your verification identities,
   because the current workflow assumes those application users already exist.
   Create the Cognito administrator using the new environment's pool ID:

   ```bash
   POOL_ID=$(aws cloudformation describe-stacks --stack-name circini-cognito \
     --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
   aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
     --username YOUR_ADMIN_EMAIL \
     --user-attributes Name=email,Value=YOUR_ADMIN_EMAIL Name=email_verified,Value=true \
     --desired-delivery-mediums EMAIL
   aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" \
     --username YOUR_ADMIN_EMAIL --group-name admin
   ```
10. **Run the pipeline.** Push to `main` or run
    `gh workflow run deploy.yml --ref main`. CI, agent evaluations, image builds,
    and vulnerability scans precede deployment. CloudFormation then creates the
    app stack: ALB, ECS services, DynamoDB memory/checkpoints, S3 storage, and logs.
    The schema-sync task creates PostgreSQL tables and pgvector columns.
11. **Connect DNS and complete first login.** As soon as the ALB is available,
    point the hostname to it (CNAME, or your DNS provider's alias equivalent).
    Complete the Cognito admin's first login and TOTP enrollment. DNS and initial
    application identities must be ready before the public verification gates.
    On a first installation, the pipeline may stop at those gates while this
    setup is incomplete. Complete DNS and login, resolve the reported failure,
    then rerun only the failed job with `gh run rerun RUN_ID --failed`; it reuses
    the already built image tag. Do not bypass the verification checks.
12. **Require successful verification.** The workflow waits for ECS stability,
    rebuilds Titan indexes, and exercises integration, chat, agent, feedback,
    and memory checks. Also run
    `bash deploy/smoke-test.sh https://YOUR_DOMAIN` and verify a new upload and
    semantic search. New installations have no old vectors to migrate.
13. **Choose operating hours.** The workflow installs the Auckland business-hours
    controller. Review its policy in `business-hours.yaml` and
    `scripts/business_hours_controller.py` before using the new environment;
    configure the desired availability instead of assuming it runs 24/7.

Do not reuse the current production database, credentials, or DNS record for a
fresh environment. Later releases use the same pipeline; bootstrap is one-time.

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
