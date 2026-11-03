"""Read-only inventory; deliberately excludes secret values and user content."""
import json, subprocess, pathlib, datetime
out={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':{}}
def call(key,*args):
 p=subprocess.run(['aws',*args,'--output','json'],capture_output=True,text=True)
 try: value=json.loads(p.stdout) if p.returncode==0 else {'error':p.stderr.strip()[:1200]}
 except ValueError: value={'error':'invalid JSON'}
 out['checks'][key]=value
 return value
call('identity','sts','get-caller-identity')
r=call('runningTasks','ecs','list-tasks','--cluster','circini-demo','--family','circini-ai-service')
services=call('services','ecs','describe-services','--cluster','circini-demo','--services','frontend','backend','ai-service')
for service in services.get('services',[]):
 tasks=call('tasks:'+service['serviceName'],'ecs','list-tasks','--cluster','circini-demo','--service-name',service['serviceName']).get('taskArns',[])
 if tasks:call('runtime:'+service['serviceName'],'ecs','describe-tasks','--cluster','circini-demo','--tasks',*tasks,'--query','tasks[].{definition:taskDefinitionArn,status:lastStatus,health:healthStatus,started:startedAt,containers:containers[].{name:name,status:lastStatus,health:healthStatus,image:image,digest:imageDigest},network:attachments[].details}')
for name in ['db-master','database-url','jwt-secret','internal-api-key','integration-encryption-key','seed-admin','openai-api-key','bedrock-api-key','azure-openai-api-key','github-oauth','gitlab-oauth','langsmith-api-key']:
 call('secret:'+name,'secretsmanager','describe-secret','--secret-id','circini/'+name,'--query','{name:Name,lastChanged:LastChangedDate,rotation:RotationEnabled,versions:VersionIdsToStages}')
call('topic','sns','get-topic-attributes','--topic-arn','arn:aws:sns:ap-southeast-2:026146807914:circini-security-alerts','--query','Attributes.{confirmed:SubscriptionsConfirmed,pending:SubscriptionsPending,deleted:SubscriptionsDeleted}')
call('certificate','acm','describe-certificate','--certificate-arn','arn:aws:acm:ap-southeast-2:026146807914:certificate/5f12ecf3-ce00-4840-ac77-e4b0ce039953','--query','Certificate.{domain:DomainName,status:Status,expires:NotAfter,renewal:RenewalEligibility}')
call('mfa','cognito-idp','get-user-pool-mfa-config','--user-pool-id','ap-southeast-2_kzmGmtSoY')
call('groups','cognito-idp','list-groups','--user-pool-id','ap-southeast-2_kzmGmtSoY','--query','Groups[].GroupName')
call('scheduleStatus','lambda','invoke','--function-name','circini-business-hours','--cli-binary-format','raw-in-base64-out','--payload','{"operation":"status"}','/tmp/circini-status.json')
try:out['checks']['scheduleState']=json.loads(pathlib.Path('/tmp/circini-status.json').read_text())
except Exception:pass
for service in ['backend','ai-service']:
 call('collectorLogs:'+service,'logs','filter-log-events','--log-group-name','/ecs/circini','--log-stream-name-prefix','otel-'+service+'/','--filter-pattern','?error ?Error ?AccessDenied ?failed','--limit','10','--start-time',str(int((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=1)).timestamp()*1000)))
pathlib.Path('live-evidence').mkdir(exist_ok=True)
pathlib.Path('live-evidence/supplement.json').write_text(json.dumps(out,indent=2,default=str))
print(json.dumps({'checks':len(out['checks']),'errors':{k:v['error'] for k,v in out['checks'].items() if isinstance(v,dict) and 'error'in v}},indent=2))
