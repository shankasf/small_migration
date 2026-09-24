"""AWS Lambda controller: reversible compute shutdown, Auckland business hours."""
from datetime import datetime, time, timedelta, timezone
import json
import os
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Pacific/Auckland')
SERVICES = ['frontend', 'backend', 'ai-service']
CLOSED_PATH = '/*'
OPEN_PATH = '/__circini_business_hours_closed__'


def plan(now, override_until=None):
    if now.tzinfo is None:
        raise ValueError('An aware timestamp is required')
    local = now.astimezone(ZONE)
    weekday = local.weekday() < 5
    maintenance = override_until is not None and now < override_until
    return {
        'localTime': local.isoformat(), 'timezone': 'Pacific/Auckland',
        'maintenance': maintenance,
        'databaseOn': maintenance or (weekday and time(7, 30) <= local.time() < time(19)),
        'servicesOn': maintenance or (weekday and time(8, 15) <= local.time() < time(19)),
        'publicOpen': maintenance or (weekday and time(8, 30) <= local.time() < time(19)),
    }


def read_lease(ssm):
    raw = json.loads(ssm.get_parameter(Name=os.environ['LEASE_PARAMETER'])['Parameter']['Value'])
    until = datetime.fromisoformat(raw['until']) if raw.get('until') else None
    if until is not None and until.tzinfo is None:
        raise ValueError('Lease timestamp must include a timezone')
    return raw, until


def task_arns(ecs, desired_status, service=None):
    request = {'cluster': os.environ['CLUSTER'], 'desiredStatus': desired_status, 'maxResults': 100}
    if service:
        request['serviceName'] = service
    while True:
        page = ecs.list_tasks(**request)
        yield from page['taskArns']
        if not page.get('nextToken'):
            return
        request['nextToken'] = page['nextToken']


def describe_tasks(ecs, arns):
    tasks = []
    for offset in range(0, len(arns), 100):
        batch = arns[offset:offset + 100]
        response = ecs.describe_tasks(cluster=os.environ['CLUSTER'], tasks=batch)
        if response.get('failures') or len(response['tasks']) != len(batch):
            raise RuntimeError('Could not establish every requested ECS task state')
        tasks.extend(response['tasks'])
    return tasks


def ai_is_healthy(ecs):
    arns = list(task_arns(ecs, 'RUNNING', service='ai-service'))
    return any(task.get('lastStatus') == 'RUNNING' and task.get('desiredStatus') == 'RUNNING'
               and any(container.get('name') == 'ai-service'
                       and container.get('lastStatus') == 'RUNNING'
                       and container.get('healthStatus') == 'HEALTHY'
                       for container in task.get('containers', []))
               for task in describe_tasks(ecs, arns))


def tasks_are_drained(ecs):
    # RUNNING is a desired state and also includes queued one-off tasks.
    if next(task_arns(ecs, 'RUNNING'), None) is not None:
        return False
    # Desired STOPPED can still mean DEACTIVATING/STOPPING. Wait until all
    # recently retained tasks have actually exited before stopping their DB.
    arns = list(task_arns(ecs, 'STOPPED'))
    return all(task.get('lastStatus') == 'STOPPED' for task in describe_tasks(ecs, arns))


def inspect(ecs, rds, elb):
    response = ecs.describe_services(cluster=os.environ['CLUSTER'], services=SERVICES)
    if response.get('failures') or len(response['services']) != len(SERVICES):
        raise RuntimeError('Could not resolve all three configured ECS services')
    services = response['services']
    db = rds.describe_db_instances(DBInstanceIdentifier=os.environ['DATABASE'])['DBInstances'][0]
    healthy = all(any(t['TargetHealth']['State'] == 'healthy' for t in
        elb.describe_target_health(TargetGroupArn=arn)['TargetHealthDescriptions'])
        for arn in [os.environ['FRONTEND_TARGET'], os.environ['BACKEND_TARGET']])
    return services, db['DBInstanceStatus'], healthy, ai_is_healthy(ecs)


def set_gate(elb, closed):
    path = CLOSED_PATH if closed else OPEN_PATH
    arn = os.environ['GATE_RULE']
    rule = elb.describe_rules(RuleArns=[arn])['Rules'][0]
    actual = next((c.get('PathPatternConfig', {}).get('Values', c.get('Values', []))
                   for c in rule['Conditions'] if c['Field'] == 'path-pattern'), [])
    host = next((c.get('HostHeaderConfig', {}).get('Values', []) for c in rule['Conditions'] if c['Field'] == 'host-header'), [])
    if actual != [path] or host != ['migration-agent.uat.signify.net.nz']:
        elb.modify_rule(RuleArn=arn, Conditions=[{'Field': 'host-header', 'HostHeaderConfig': {'Values': ['migration-agent.uat.signify.net.nz']}}, {'Field': 'path-pattern', 'PathPatternConfig': {'Values': [path]}}])


def reconcile(desired, ecs, rds, elb):
    # An unrelated status API failure must not leave yesterday's open rule active.
    if not desired['publicOpen']:
        set_gate(elb, closed=True)
    try:
        services, db_status, targets_healthy, ai_healthy = inspect(ecs, rds, elb)
    except Exception:
        # Unknown readiness must never open the application during a cold start.
        set_gate(elb, closed=True)
        raise
    ready = db_status in ['available', 'backing-up', 'modifying'] and targets_healthy and ai_healthy and all(s['runningCount'] >= 1 for s in services)
    public_open = desired['publicOpen'] and ready
    # Close public traffic before stopping anything; only open after readiness.
    set_gate(elb, closed=not public_open)
    actions = []
    if desired['databaseOn'] and db_status == 'stopped':
        rds.start_db_instance(DBInstanceIdentifier=os.environ['DATABASE'])
        actions.append('start database')
    for service in services:
        # Preserve serving tasks during online database maintenance.
        count = (1 if db_status == 'available' else service['desiredCount']) if desired['servicesOn'] else 0
        if db_status in ['stopped', 'stopping', 'starting']:
            count = 0
        if service['desiredCount'] != count:
            ecs.update_service(cluster=os.environ['CLUSTER'], service=service['serviceName'], desiredCount=count)
            actions.append(f"{service['serviceName']} desired={count}")
    if not desired['databaseOn'] and db_status == 'available':
        # Do not stop the database under draining services or one-off maintenance tasks.
        drained = all(s['runningCount'] == 0 and s['pendingCount'] == 0 for s in services)
        if drained and tasks_are_drained(ecs):
            rds.stop_db_instance(DBInstanceIdentifier=os.environ['DATABASE'])
            actions.append('stop database')
    return {**desired, 'publicReady': public_open, 'databaseStatus': db_status, 'aiHealthy': ai_healthy,
            'services': [{k: s[k] for k in ['serviceName', 'desiredCount', 'runningCount', 'pendingCount']} for s in services],
            'actions': actions}


def set_availability_notifications(cloudwatch, enabled):
    name = 'circini-backend-unavailable'
    alarms = cloudwatch.describe_alarms(AlarmNames=[name])['MetricAlarms']
    if len(alarms) != 1:
        raise RuntimeError('Expected backend availability alarm is missing')
    if alarms[0]['ActionsEnabled'] != enabled:
        action = cloudwatch.enable_alarm_actions if enabled else cloudwatch.disable_alarm_actions
        action(AlarmNames=[name])


def handler(event, context):
    event = event or {}
    operation = event.get('operation', 'reconcile')
    now = datetime.now(timezone.utc)
    if operation == 'plan':
        # Time simulation is deliberately read-only; it cannot operate production resources.
        return plan(datetime.fromisoformat(event['at']) if event.get('at') else now)
    if event.get('at'):
        raise ValueError('Simulated time is accepted only for a read-only plan')
    if operation not in ['reconcile', 'status', 'hold', 'release']:
        raise ValueError('Unknown operation')
    import boto3
    ssm, ecs, rds, elb = (boto3.client(name) for name in ['ssm', 'ecs', 'rds', 'elbv2'])
    try:
        lease, until = read_lease(ssm)
    except Exception:
        # An unreadable lease cannot authorize out-of-hours public access. Keep
        # compute unchanged because an unobserved maintenance lease may exist.
        if operation != 'status' and not plan(now)['publicOpen']:
            set_gate(elb, closed=True)
        raise
    if operation in ['hold', 'release']:
        owner = event.get('owner', '')
        if not isinstance(owner, str) or not owner or len(owner) > 120:
            raise ValueError('A short maintenance owner is required')
        if lease.get('owner') != owner and until and until > now:
            raise ValueError('Another live maintenance lease owns the application')
        if operation == 'hold':
            minutes = event.get('minutes', 180)
            if not isinstance(minutes, int) or not 5 <= minutes <= 180:
                raise ValueError('Maintenance must be between 5 and 180 minutes')
            until = now + timedelta(minutes=minutes)
            lease = {'owner': owner, 'until': until.isoformat()}
        elif lease.get('owner') == owner:
            lease, until = {}, None
        ssm.put_parameter(Name=os.environ['LEASE_PARAMETER'], Value=json.dumps(lease), Type='String', Overwrite=True)
    desired = plan(now, until)
    # Testing shares RDS but never keeps production app services running. A read
    # failure must not permit database shutdown under an unknown testing lease.
    try:
        testing = json.loads(ssm.get_parameter(Name='/circini/testing/lease')['Parameter']['Value'])
        testing_until = datetime.fromisoformat(testing['until']) if testing.get('until') else None
        desired['databaseOn'] = desired['databaseOn'] or bool(testing_until and now < testing_until)
    except ssm.exceptions.ParameterNotFound:
        pass
    except Exception:
        if operation != 'status' and not desired['publicOpen']:
            set_gate(elb, closed=True)
        raise
    if operation == 'status':
        services, db, healthy, ai_healthy = inspect(ecs, rds, elb)
        return {**desired, 'lease': lease, 'databaseStatus': db, 'targetsHealthy': healthy,
                'aiHealthy': ai_healthy,
                'services': [{k: s[k] for k in ['serviceName', 'desiredCount', 'runningCount', 'pendingCount']} for s in services]}
    result = reconcile(desired, ecs, rds, elb)
    # Notification failures cannot prevent the gate from closing or compute shutdown.
    set_availability_notifications(boto3.client('cloudwatch'), desired['publicOpen'])
    print(json.dumps(result))
    return result
