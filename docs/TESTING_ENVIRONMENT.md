# On-demand testing

Production: https://migration-agent.uat.signify.net.nz (`main`).
Testing: https://migration.callsphere.site (`testing`).

Run **Actions → Testing environment → Run workflow → start**. The default window
is 120 minutes; choose 5–180 minutes. Start again to extend it. `stop` closes the
site and scales all three testing services to zero. `status` is read-only.
A paused site returns HTTP 503. Visiting the URL does not start billable compute.
The one-minute AWS scheduler enforces expiration independently of GitHub Actions.
Allow several minutes for ECS startup, and longer if the shared RDS is stopped.

Pushes to `testing` run CI, build and scan separate image tags, deploy only testing,
and open a timed testing window. Merge reviewed application changes to `main`
when ready for the existing production release pipeline. Manual `deploy` accepts
an existing immutable `sha-...` image tag; blank selects the current production
image. Deploying testing never changes production task definitions.

Shared: VPC, subnets, NAT gateway, load balancer, ECS cluster, ECR repositories,
physical RDS instance, Cognito user pool, and model provider billing credentials.
Testing has separate services, task roles, restricted PostgreSQL login/database,
Cognito app client, JWT/internal/encryption secrets, service discovery namespace,
DynamoDB tables, checkpoint/audit buckets and log groups. Existing users sign in
using their existing Cognito accounts; testing starts with an empty application
database. Production chats, files, feedback and integration tokens are not copied.
GitHub/GitLab require separately configured testing OAuth apps; production app
private keys are deliberately excluded. Uploaded files and AI chat are available.

No second ALB, NAT gateway or RDS instance is created. Testing adds Fargate compute
only while running, plus storage/secrets/requests and AI usage. Off-hours testing
can extend shared RDS runtime. Production retains its Auckland business-hours
schedule; the database stays up while either environment needs it. Sharing the
physical database also shares capacity and the database maintenance/failure domain.
Testing has two concurrent AI turns and a 12-connection database role limit.

Infrastructure is generated from reviewed production definitions by
`scripts/testing/template.py`, with an explicit resource allowlist and isolated
state. `circini-testing` owns all additions; changes to `circini-business-hours`
are restricted to its host gate, controller code and read access to the testing
lease. State stores are retained and deployment refuses their removal/replacement.
