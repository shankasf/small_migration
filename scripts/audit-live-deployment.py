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
stacks=call('stacks','cloudformation','describe-stacks','--query',"Stacks[?starts_with(StackName, `circini-`)].{name:StackName,status:StackStatus,updated:LastUpdatedTime,parameters:Parameters,outputs:Outputs}")
resources={}
for s in stacks if isinstance(stacks,list) else []:
 name=s['name']; r=call('resources:'+name,'cloudformation','list-stack-resources','--stack-name',name)
 for v in r.get('StackResourceSummaries',[]):resources[v['LogicalResourceId']]=v['PhysicalResourceId']
services=call('services','ecs','describe-services','--cluster','circini-demo','--services','frontend','backend','ai-service')
allow={'AUTH_MODE','OIDC_ISSUER','OIDC_AUDIENCE','OIDC_ROLES_CLAIM','LLM_PROVIDER','BEDROCK_REGION','BEDROCK_MODEL','EMBEDDING_PROVIDER','APPROVED_EMBEDDING_HOST','APPROVED_LLM_HOST','PROCESSING_REGION','GUARDRAILS_ENABLED','PHI_MODE','VOICE_ENABLED','CHECKPOINT_BACKEND','MEMORY_BACKEND','CHECKPOINT_TTL_DAYS','AGENT_TRACING_ENABLED','LANGSMITH_ENDPOINT','OTEL_EXPORTER_OTLP_ENDPOINT','AUDIT_ARCHIVE_REQUIRED','AUDIT_ARCHIVE_BUCKET','OPENAI_MODEL'}
for s in services.get('services',[]):
 td=call('task:'+s['serviceName'],'ecs','describe-task-definition','--task-definition',s['taskDefinition'])
 for c in td.get('taskDefinition',{}).get('containerDefinitions',[]):
  c['environment']=[e for e in c.get('environment',[]) if e['name'] in allow]
  # Secrets describe references only, never resolved values.
call('runningTasks','ecs','list-tasks','--cluster','circini-demo')
call('database','rds','describe-db-instances','--db-instance-identifier','circini-demo','--query','DBInstances[].{identifier:DBInstanceIdentifier,status:DBInstanceStatus,engine:Engine,version:EngineVersion,size:DBInstanceClass,storage:AllocatedStorage,encrypted:StorageEncrypted,multiAZ:MultiAZ,public:PubliclyAccessible,backups:BackupRetentionPeriod,az:AvailabilityZone,deletionProtection:DeletionProtection,latestRestore:LatestRestorableTime,subnets:DBSubnetGroup.Subnets[].SubnetIdentifier}')
call('secretsMetadata','secretsmanager','list-secrets','--query',"SecretList[?starts_with(Name, `circini/`)].{name:Name,rotation:RotationEnabled,changed:LastChangedDate}")
call('logGroups','logs','describe-log-groups','--log-group-name-prefix','/ecs/circini')
call('alarms','cloudwatch','describe-alarms','--alarm-name-prefix','circini')
call('schedule','scheduler','get-schedule','--name','circini-business-hours')
call('bedrockInvocationLogging','bedrock','get-model-invocation-logging-configuration')
call('ecr','ecr','describe-repositories','--query',"repositories[?starts_with(repositoryName, `circini-`)].{name:repositoryName,tags:imageTagMutability,scan:imageScanningConfiguration,encryption:encryptionConfiguration}")
for key,physical in resources.items():
 if key=='Alb':
  call('alb','elbv2','describe-load-balancers','--load-balancer-arns',physical)
  call('albAttributes','elbv2','describe-load-balancer-attributes','--load-balancer-arn',physical)
  call('listeners','elbv2','describe-listeners','--load-balancer-arn',physical)
  call('waf','wafv2','get-web-acl-for-resource','--resource-arn',physical)
 if key in ('HttpListener','HttpsListener'):call('rules:'+key,'elbv2','describe-rules','--listener-arn',physical)
 if key in ('FrontendTargetGroup','BackendTargetGroup'):
  call('targetHealth:'+key,'elbv2','describe-target-health','--target-group-arn',physical)
  call('targetAttributes:'+key,'elbv2','describe-target-group-attributes','--target-group-arn',physical)
 if key in ('AuditArchive','AgentCheckpointBucket'):
  for op in ('get-bucket-encryption','get-bucket-versioning','get-public-access-block','get-bucket-lifecycle-configuration'):
   call(op+':'+key,'s3api',op,'--bucket',physical)
  if key=='AuditArchive':call('objectLock','s3api','get-object-lock-configuration','--bucket',physical)
 if key in ('AgentCheckpointTable','AgentMemoryTable'):
  call('table:'+key,'dynamodb','describe-table','--table-name',physical)
  call('ttl:'+key,'dynamodb','describe-time-to-live','--table-name',physical)
 if key=='UserPool':call('cognito','cognito-idp','describe-user-pool','--user-pool-id',physical)
 if key=='SpaClient':
  pool=resources.get('UserPool')
  if pool:call('spaClient','cognito-idp','describe-user-pool-client','--user-pool-id',pool,'--client-id',physical)
 if key=='SecurityAlerts':
  call('alertSubscriptions','sns','list-subscriptions-by-topic','--topic-arn',physical,'--query','Subscriptions[].{protocol:Protocol,status:SubscriptionArn}')
 if key=='Vpc':
  call('subnets','ec2','describe-subnets','--filters','Name=vpc-id,Values='+physical)
  call('routes','ec2','describe-route-tables','--filters','Name=vpc-id,Values='+physical)
  call('securityGroups','ec2','describe-security-groups','--filters','Name=vpc-id,Values='+physical)
pathlib.Path('live-evidence').mkdir(exist_ok=True)
pathlib.Path('live-evidence/inventory.json').write_text(json.dumps(out,indent=2,default=str))
print(json.dumps({'checks':len(out['checks']),'errors':{k:v['error'] for k,v in out['checks'].items() if isinstance(v,dict) and 'error'in v}},indent=2))
