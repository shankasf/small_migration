"""Read-only inventory; deliberately excludes secret values and user content."""
import json, subprocess, pathlib, datetime
out={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':{}}
def call(key,*args):
 p=subprocess.run(['aws',*args,'--output','json'],capture_output=True,text=True)
 try: value=json.loads(p.stdout) if p.returncode==0 else {'error':p.stderr.strip()[:1200]}
 except ValueError: value={'error':'invalid JSON'}
 out['checks'][key]=value
 return value
keys=['githubProductionCheck','capabilitiesProductionCheck','chatSearchProductionCheck','feedbackProductionCheck','impactProductionCheck','agentGraphProductionCheck','memoryProductionCheck','fileLibraryProductionCheck']
pattern='{ '+ ' || '.join('$.%s = "*"'%k for k in keys)+' }'
call('verificationEvents','logs','filter-log-events','--log-group-name','/ecs/circini','--filter-pattern',pattern,'--start-time',str(int((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=30)).timestamp()*1000)),'--limit','100')
for service,prefix in [('backend','otel-backend/'),('ai-service','otel-ai/')]:
 r=call('runtime:'+service,'ecs','list-tasks','--cluster','circini-demo','--service-name',service)
 for arn in r.get('taskArns',[]):
  call('collector:'+service,'logs','get-log-events','--log-group-name','/ecs/circini','--log-stream-name',prefix+'otel-collector/'+arn.rsplit('/',1)[-1],'--limit','20')
pathlib.Path('live-evidence').mkdir(exist_ok=True)
pathlib.Path('live-evidence/progress.json').write_text(json.dumps(out,indent=2,default=str))
print(json.dumps({'checks':len(out['checks'])}))
