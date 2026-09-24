"""Run an authenticated synthetic chat, then wait for the full ECS rollout gate."""
import json
import time
from manage import aws, task, ROOT, stack
backend=aws('ecs','describe-services','--cluster','circini-demo','--services','testing-backend')['services'][0]
client=next(o['OutputValue'] for o in stack('circini-cognito')['Outputs'] if o['OutputKey']=='SpaClientId')
script='process.env.PRODUCTION_CLIENT_ID='+json.dumps(client)+';\n'+(ROOT/'scripts/testing/verify.cjs').read_text()
task(backend['taskDefinition'],backend['networkConfiguration'],'backend',script)
deadline=time.monotonic()+1200
while True:
    services=aws('ecs','describe-services','--cluster','circini-demo','--services','testing-frontend','testing-backend','testing-ai-service','frontend','backend','ai-service')['services']
    testing=[s for s in services if s['serviceName'].startswith('testing-')]
    assert len(testing)==3
    assert not any(d.get('rolloutState')=='FAILED' for s in testing for d in s['deployments'])
    ready=all(s['desiredCount']==s['runningCount']==1 and s['pendingCount']==0 and all(d['rolloutState']=='COMPLETED' for d in s['deployments']) for s in testing)
    if ready:break
    assert time.monotonic()<deadline,'Testing rollout did not stabilize'
    print('Waiting for testing ECS rollout completion',flush=True)
    time.sleep(15)
for s in services:
    print(s['serviceName'],s['taskDefinition'],'desired',s['desiredCount'],'running',s['runningCount'])
print(json.dumps({'testingEcsRollout':'passed'}),flush=True)
