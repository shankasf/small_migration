"""Apply only the shared database lease and production-host gate changes."""
import importlib.util
import json
import copy
from pathlib import Path
from template import ROOT

spec=importlib.util.spec_from_file_location('guarded_domain',ROOT/'scripts/configure-app-domain.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
body=json.loads(guard.template('circini-business-hours'))
before=copy.deepcopy(body)
r=body['Resources']
r['Gate']['Properties']['Conditions']=[{'Field':'host-header','HostHeaderConfig':{'Values':['migration-agent.uat.signify.net.nz']}},
    *[c for c in r['Gate']['Properties']['Conditions'] if c['Field']!='host-header']]
r['Controller']['Properties']['Code']['ZipFile']=(ROOT/'scripts/business_hours_controller.py').read_text()
statements=r['ControllerRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
permission={'Effect':'Allow','Action':'ssm:GetParameter','Resource':{'Fn::Sub':'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/circini/testing/lease'}}
if permission not in statements:statements.append(permission)
changed={k for k,v in r.items() if v!=before['Resources'][k]}
assert changed <= {'Gate','Controller','ControllerRole'}, changed
# Lambda ARN references cause CloudFormation to reevaluate these otherwise
# unchanged dependants. Their definitions are checked unchanged above.
guard.deploy('circini-business-hours',json.dumps(body),{}, {'Gate','Controller','ControllerRole','SchedulerRole','Schedule','InvocationPolicy','ControllerErrors'})
