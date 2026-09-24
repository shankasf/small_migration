"""Testing lifecycle. Never scales production services or stops the shared DB."""
from datetime import datetime, timedelta, timezone
import json
import os

SERVICES=['testing-frontend','testing-backend','testing-ai-service']
DOMAIN='migration.callsphere.site'

def set_gate(elb, closed):
    conditions=[
        {'Field':'host-header','HostHeaderConfig':{'Values':[DOMAIN]}},
        {'Field':'path-pattern','PathPatternConfig':{'Values':['/*' if closed else '/__testing_paused__']}}]
    rule=elb.describe_rules(RuleArns=[os.environ['GATE_RULE']])['Rules'][0]
    paths=next((c['PathPatternConfig']['Values'] for c in rule['Conditions'] if c['Field']=='path-pattern'),[])
    if paths!=conditions[1]['PathPatternConfig']['Values']:
        elb.modify_rule(RuleArn=os.environ['GATE_RULE'],Conditions=conditions)

def handler(event, context):
    import boto3
    event=event or {};operation=event.get('operation','reconcile')
    if operation not in ['start','stop','status','reconcile']:raise ValueError('Unknown operation')
    ssm,ecs,rds,elb=[boto3.client(n) for n in ['ssm','ecs','rds','elbv2']]
    now=datetime.now(timezone.utc)
    lease=json.loads(ssm.get_parameter(Name=os.environ['LEASE_PARAMETER'])['Parameter']['Value'])
    if operation=='start':
        minutes=event.get('minutes',120)
        if type(minutes)!=int or not 5<=minutes<=180:raise ValueError('Duration must be 5 to 180 minutes')
        lease={'until':(now+timedelta(minutes=minutes)).isoformat()}
    elif operation=='stop':lease={}
    if operation in ['start','stop']:
        ssm.put_parameter(Name=os.environ['LEASE_PARAMETER'],Value=json.dumps(lease),Type='String',Overwrite=True)
    until=datetime.fromisoformat(lease['until']) if lease.get('until') else None
    active=bool(until and now<until)
    if operation!='status' and not active:set_gate(elb, True)
    response=ecs.describe_services(cluster='circini-demo',services=SERVICES)
    if response.get('failures') or len(response['services'])!=3:raise RuntimeError('Missing testing services')
    services=response['services']
    status=rds.describe_db_instances(DBInstanceIdentifier='circini-demo')['DBInstances'][0]['DBInstanceStatus']
    healthy=all(any(t['TargetHealth']['State']=='healthy' for t in elb.describe_target_health(TargetGroupArn=arn)['TargetHealthDescriptions'])
                for arn in [os.environ['FRONTEND_TARGET'],os.environ['BACKEND_TARGET']])
    arns=ecs.list_tasks(cluster='circini-demo',serviceName='testing-ai-service',desiredStatus='RUNNING')['taskArns']
    tasks=ecs.describe_tasks(cluster='circini-demo',tasks=arns)['tasks'] if arns else []
    ai=any(any(c['name']=='ai-service' and c.get('healthStatus')=='HEALTHY' for c in t['containers']) for t in tasks)
    ready=active and status in ['available','backing-up','modifying'] and healthy and ai and all(s['runningCount']>=1 for s in services)
    if operation!='status':
        if active and status=='stopped':rds.start_db_instance(DBInstanceIdentifier='circini-demo')
        for service in services:
            count=(1 if status=='available' else service['desiredCount']) if active else 0
            if status in ['stopped','stopping','starting']:count=0
            if service['desiredCount']!=count:ecs.update_service(cluster='circini-demo',service=service['serviceName'],desiredCount=count)
        set_gate(elb,not ready)
    result={'active':active,'until':lease.get('until'),'ready':bool(ready),'databaseStatus':status,
            'services':[{k:s[k] for k in ['serviceName','desiredCount','runningCount','pendingCount']} for s in services]}
    print(json.dumps(result));return result
