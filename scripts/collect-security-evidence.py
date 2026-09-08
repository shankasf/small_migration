#!/usr/bin/env python3
"""Read-only AWS evidence inventory. Prints no credentials or prompt content."""
import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--region', default='ap-southeast-2')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()

def aws(*parts):
    result = subprocess.run(['aws', '--region', args.region, *parts, '--output', 'json'], capture_output=True, text=True, timeout=45)
    if result.returncode:
        return {'unverified': True, 'operation': ' '.join(parts[:2])}
    return json.loads(result.stdout)

report = {'collectedAt':datetime.now(timezone.utc).isoformat(), 'region':args.region, 'phiReady':False}
identity = aws('sts', 'get-caller-identity')
report['account'] = identity.get('Account')
report['services'] = aws('ecs','describe-services','--cluster','circini-demo','--services','backend','ai-service','frontend','--query','services[].{name:serviceName,running:runningCount,desired:desiredCount,taskDefinition:taskDefinition,deployments:deployments[].{status:status,rollout:rolloutState}}')
allowed = {'LLM_PROVIDER','OPENAI_MODEL','APPROVED_LLM_HOST','PROCESSING_REGION','PROVIDER_APPROVAL_REFERENCE','GUARDRAILS_ENABLED','PHI_MODE','VOICE_ENABLED','OPENAI_AGENTS_DISABLE_TRACING','AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_DEPLOYMENT','RETENTION_DELETE_ENABLED','CHAT_RETENTION_DAYS','AUDIT_RETENTION_DAYS','AI_LOG_RETENTION_DAYS','AUDIT_ARCHIVE_REQUIRED','AUDIT_ARCHIVE_BUCKET'}
report['tasks'] = []
for family in ['circini-backend','circini-ai-service']:
    task = aws('ecs','describe-task-definition','--task-definition',family)
    containers = task.get('taskDefinition', {}).get('containerDefinitions', [])
    report['tasks'].append({'family':family, 'containers':[{'name':c['name'], 'image':c['image'], 'settings':{e['name']:e['value'] for e in c.get('environment',[]) if e['name'] in allowed}} for c in containers]})
report['database'] = aws('rds','describe-db-instances','--db-instance-identifier','circini-demo','--query','DBInstances[].{encrypted:StorageEncrypted,public:PubliclyAccessible,backupDays:BackupRetentionPeriod,latestRestorable:LatestRestorableTime,multiAZ:MultiAZ,engine:EngineVersion}')
report['snapshots'] = aws('rds','describe-db-snapshots','--db-instance-identifier','circini-demo','--query','DBSnapshots[].{id:DBSnapshotIdentifier,type:SnapshotType,created:SnapshotCreateTime,encrypted:Encrypted}')
report['alarms'] = aws('cloudwatch','describe-alarms','--alarm-name-prefix','circini-','--query','MetricAlarms[].{name:AlarmName,state:StateValue,actions:AlarmActions,enabled:ActionsEnabled}')
account = report['account']
if account:
    bucket = f'circini-audit-{account}-{args.region}'
    report['auditLock'] = aws('s3api','get-object-lock-configuration','--bucket',bucket)
    report['auditEncryption'] = aws('s3api','get-bucket-encryption','--bucket',bucket)
    topic = f'arn:aws:sns:{args.region}:{account}:circini-security-alerts'
    subscribers = aws('sns','list-subscriptions-by-topic','--topic-arn',topic)
    report['confirmedAlertSubscriptions'] = sum(s['SubscriptionArn'] != 'PendingConfirmation' for s in subscribers.get('Subscriptions',[]))
report['remainingEvidence'] = ['provider residency and retention agreement','alert delivery/acknowledgement test','independent penetration test','RDS restore drill','target database validation and human approval per artefact']
args.output.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump(report, output, indent=2)
print(f'Evidence written to {args.output}; unresolved checks are explicitly marked')
