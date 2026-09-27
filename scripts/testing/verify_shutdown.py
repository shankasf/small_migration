"""Expire a testing lease and observe the AWS scheduler stop only testing.

No controller reconciliation is invoked by this check: the independently
scheduled Lambda must do the shutdown. Run while production is open to compare.
"""
from datetime import datetime, timedelta, timezone
import json
import time
from urllib.request import urlopen
from urllib.error import HTTPError
from manage import aws, invoke


def get(url):
    """GET one of this check's fixed public endpoints; only https is ever opened."""
    assert url.startswith('https://'), 'Only https endpoints are checked'
    return urlopen(url, timeout=15)  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected


production=['frontend','backend','ai-service']
def prod():return {s['serviceName']:(s['taskDefinition'],s['desiredCount'],s['runningCount']) for s in aws('ecs','describe-services','--cluster','circini-demo','--services',*production)['services']}
before=prod()
assert invoke({'operation':'status'})['ready'],'Testing must be running before shutdown verification'
aws('ssm','put-parameter','--name','/circini/testing/lease','--type','String','--overwrite','--value',json.dumps({'until':(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()}))
deadline=time.monotonic()+600
while True:
    result=invoke({'operation':'status'})
    print(json.dumps(result),flush=True)
    if all(s['desiredCount']==s['runningCount']==s['pendingCount']==0 for s in result['services']):break
    assert time.monotonic()<deadline,'Automatic testing shutdown failed'
    time.sleep(20)
assert prod()==before,'Production changed during testing shutdown'
try:
    get('https://migration.callsphere.site/')
    raise AssertionError('Expired testing environment remained publicly open')
except HTTPError as error:
    assert error.code==503
assert get('https://migration-agent.uat.signify.net.nz/api/health').status==200
print(json.dumps({'testingAutomaticShutdown':'passed','productionUnchanged':True,'runningTestingTasks':0}),flush=True)
