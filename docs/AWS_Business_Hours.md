# AWS business hours: New Zealand weekdays

The app is scheduled to be publicly available **Monday–Friday, 10 am–8 pm in
Pacific/Auckland**. This follows New Zealand daylight saving automatically.
Saturday and Sunday remain closed. Public holidays follow their weekday;
there is no separate holiday calendar.

| New Zealand local time | Action on weekdays |
| --- | --- |
| 9:00 am | Start the existing RDS PostgreSQL instance for warm-up |
| 9:45 am | Start frontend, backend and AI-service Fargate tasks once RDS is available; keep public traffic closed |
| 10:00 am | Open the public listener after the database, services and target groups are ready |
| 8:00 pm | Show the closed-hours page and scale all three services to zero |
| After tasks drain | Stop the RDS instance when no service or one-off task remains running |

The controller reconciles every minute using AWS EventBridge Scheduler and a
Lambda function. Scheduler delivery has one-minute precision; resource start,
drain and stop operations take additional time. The warm-up period improves
readiness for 10 am but is not a guarantee if AWS startup or health checks fail.
The listener remains closed if the app is not ready. During closed hours it
returns HTTP 503 with an opening-hours page, including for API requests and
webhooks.

## Resources and data

The script only operates cluster **circini-demo**, services **frontend**,
**backend**, **ai-service**, database **circini-demo**, and its dedicated ALB
listener rule. It changes desired task counts and starts/stops the existing DB;
it does not delete chats, uploads, generated outputs, database storage, or
backups. The listener rule has priority 1, ahead of the application's API rules.

This reduces Fargate task runtime and RDS instance compute time. **RDS storage,
backups, ALB, NAT gateway, public IPs, logs and other retained infrastructure
still cost money.** No claim is made that the total AWS bill falls to zero.
RDS automatically starts after seven consecutive stopped days; the controller
will stop it again outside the configured window once it is available and no
tasks are running. A normal weekend is shorter than seven days.

## Files and deployment

- [Controller script](../scripts/business_hours_controller.py): time policy,
  readiness, public gate, compute transitions and maintenance lease.
- [CloudFormation template](../deploy/aws/business-hours.yaml): scheduler,
  Lambda, IAM roles, gate, failure queue and alarms. The deploy script inserts
  the reviewed controller source into Lambda's inline code.
- [Deployment script](../scripts/deploy-business-hours.py): compiles and deploys
  the circini-business-hours stack against the existing app resources.
- [Operator script](../scripts/manage-business-hours.py): status, read-only
  simulated plans, and bounded maintenance holds.
- [Git deployment workflow](../.github/workflows/deploy.yml): installs/updates
  the schedule after the app's existing release gates pass.
- [Boundary and ordering tests](../scripts/tests/test_business_hours.py).

A normal Git deployment obtains a maintenance lease before touching the database,
wakes the app if needed, performs its normal CI/release checks, then releases the
lease in an always-run cleanup step. **During this bounded maintenance window the
app can be open outside normal hours.** A lease lasts at most three hours, so an
interrupted workflow cannot keep it running indefinitely. A different owner
cannot overwrite or release an active lease. The schedule resumes after release
or expiry. New controller installations also receive the current deployment's
bounded lease until cleanup.

## Check or temporarily operate the app

Use GitHub Actions → **AWS business hours** → **Run workflow** on `main`.
`status` reports actual resources and the current time policy; `plan` is read-only
and accepts an optional timezone-aware ISO timestamp. `hold` opens the app for a
bounded maintenance window, and `release` restores its schedule. The manual lease
owner is your GitHub actor; a deployment has its own run ID. A hold reserves at
least 90 minutes for cold startup, then begins the requested 5–180 minute window
once the app is ready. GitHub waits in two phases of up to 40 minutes, refreshing
its temporary AWS credentials between phases. A failed startup releases its lease;
a canceled operation remains bounded by expiry. The local CLI waits up to 40
minutes per invocation; rerun it with fresh credentials if startup is still pending.

With working AWS CLI credentials, the equivalents are:

```bash
python3 scripts/manage-business-hours.py status
python3 scripts/manage-business-hours.py plan --at 2026-09-11T20:00:00+12:00
python3 scripts/manage-business-hours.py hold --owner manual-maintenance --minutes 60 --wait
python3 scripts/manage-business-hours.py release --owner manual-maintenance
```

A simulated timestamp is accepted only for `plan`: it cannot trigger production
shutdown. `reconcile` always uses the current real time. Expiry is checked on each
reconciliation, including delayed or retried scheduler invocations.

The existing backend availability alarm has notifications disabled during planned
closed hours and re-enabled during public opening or a maintenance hold. Other
security/audit alarm notifications stay enabled.

Lambda errors and failed scheduler delivery feed CloudWatch alarms using the
existing Circini security-alert topic. Logs are under
`/aws/lambda/circini-business-hours`. Check the schedule state, error logs and
resource state before claiming the policy is active; code alone is not live
verification.

Sources: [AWS Scheduler timezone and timing](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html),
[RDS stopping, retained storage charges and automatic restart](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html).

## Live installation — September 11, 2026

[AWS release 34547420528](https://github.com/shankasf/small_migration/actions/runs/34547420528)
passed all CI/security gates, image scans, ECS steady state, public smoke tests,
and GitHub integration checks at commit
`1cbff1de56da113717f5350407e830c18ca73c12`. It created stack
`circini-business-hours` at 01:08 UTC.

AWS reported schedule `circini-business-hours` as **ENABLED**, with expression
`cron(* * * * ? *)` and timezone **Pacific/Auckland**. Its controller completed a
real reconciliation and released the deployment lease. At 13:08 Auckland time,
maintenance was false, the database was available, the AI application was
healthy, and each of the three services had desired/running counts 1/1 with no
pending tasks. Public readiness was true; no corrective actions were needed.

The first actual scheduled evening shutdown and subsequent cold opening have
not yet occurred at the time of installation. Time-rule tests and a successful
live reconciliation establish the installed policy; they do not claim that a
full overnight cycle has already been observed.

A separate [read-only automatic-execution check 34549586598](https://github.com/shankasf/small_migration/actions/runs/34549586598)
observed successful controller results at 13:09 and 13:10 Auckland time, after
the deployment's manual reconciliation/release had ended. Both had maintenance
false, healthy resources, public readiness true, and no corrective actions.
There were no Lambda error records in the checked window, and all three
reported dead-letter queue counts were zero. This diagnostic performed no
controller invocation or resource/lease changes.

Post-release checks against the deployed controller all passed:

| Check | Observed result | Evidence |
| --- | --- | --- |
| Current status | Empty lease; healthy app; enabled Auckland schedule | [34549490478](https://github.com/shankasf/small_migration/actions/runs/34549490478) |
| Friday September 11, 8 pm | Database/services/public access planned off | [34549552812](https://github.com/shankasf/small_migration/actions/runs/34549552812) |
| Saturday September 12, 10 am | Database/services/public access planned off | [34549619425](https://github.com/shankasf/small_migration/actions/runs/34549619425) |
| Monday September 14, 10 am | Database/services/public access planned on | [34549670694](https://github.com/shankasf/small_migration/actions/runs/34549670694) |

The future-time checks used `plan`, which is read-only and cannot change production
resources. They validate the deployed time policy without interrupting the app.
