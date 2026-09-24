import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

ROOT=Path(__file__).resolve().parents[2]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
controller=module('testing_controller','scripts/testing/controller.py')
template=module('testing_template','scripts/testing/template.py')
hours=module('production_hours','scripts/business_hours_controller.py')
with patch.dict(sys.modules,{'template':template}):
    manage=module('testing_manage','scripts/testing/manage.py')

class FakeAWS:
    def __init__(self,active=True,database='available'):
        self.lease={'until':(datetime.now(timezone.utc)+timedelta(minutes=30 if active else -1)).isoformat()}
        self.services=[{'serviceName':n,'desiredCount':1,'runningCount':1,'pendingCount':0} for n in controller.SERVICES]
        self.events=[];self.database=database
    def get_parameter(self,**kw):return {'Parameter':{'Value':json.dumps(self.lease)}}
    def put_parameter(self,**kw):self.lease=json.loads(kw['Value'])
    def describe_services(self,**kw):return {'services':self.services}
    def describe_db_instances(self,**kw):return {'DBInstances':[{'DBInstanceStatus':self.database}]}
    def describe_rules(self,**kw):return {'Rules':[{'Conditions':[{'Field':'path-pattern','PathPatternConfig':{'Values':['/__testing_paused__']}}]}]}
    def modify_rule(self,**kw):self.events.append(('gate',kw['Conditions']))
    def describe_target_health(self,**kw):return {'TargetHealthDescriptions':[{'TargetHealth':{'State':'healthy'}}]}
    def list_tasks(self,**kw):return {'taskArns':['testing-ai']}
    def describe_tasks(self,**kw):return {'tasks':[{'containers':[{'name':'ai-service','healthStatus':'HEALTHY'}]}]}
    def update_service(self,**kw):self.events.append(('scale',kw['service'],kw['desiredCount']))
    def start_db_instance(self,**kw):self.events.append(('start_db',))
    def stop_db_instance(self,**kw):raise AssertionError('Testing must never stop the shared DB')

class TestingEnvironmentTests(unittest.TestCase):
    def invoke(self,aws,event):
        with patch.dict(sys.modules,{'boto3':SimpleNamespace(client=lambda name:aws)}),patch.dict(os.environ,{'LEASE_PARAMETER':'/circini/testing/lease','GATE_RULE':'test-gate','FRONTEND_TARGET':'front','BACKEND_TARGET':'back'}):
            return controller.handler(event,None)
    def test_expiration_closes_test_host_before_scaling_only_testing_services(self):
        aws=FakeAWS(active=False);self.invoke(aws,{})
        self.assertEqual(aws.events[0][0],'gate')
        self.assertEqual(aws.events[0][1][0]['HostHeaderConfig']['Values'],['migration.callsphere.site'])
        self.assertEqual([e for e in aws.events if e[0]=='scale'],[('scale',n,0) for n in controller.SERVICES])
    def test_start_wakes_database_without_starting_tasks_until_available(self):
        aws=FakeAWS(database='stopped')
        for s in aws.services:s['desiredCount']=s['runningCount']=0
        result=self.invoke(aws,{'operation':'start','minutes':120})
        self.assertIn(('start_db',),aws.events);self.assertFalse(result['ready']);self.assertFalse(any(e[0]=='scale' for e in aws.events))
    def test_status_is_read_only(self):
        aws=FakeAWS();self.assertTrue(self.invoke(aws,{'operation':'status'})['ready']);self.assertEqual(aws.events,[])
    def test_invalid_or_unbounded_duration_cannot_extend_lease(self):
        for value in [0,181,True,'120']:
            with self.assertRaises(ValueError):self.invoke(FakeAWS(),{'operation':'start','minutes':value})
    def test_cold_start_refreshes_only_stopped_testing_service_discovery(self):
        calls=[]
        def aws(*args):
            calls.append(args)
            if args[1]=='describe-services':return {'services':[{'serviceName':n,'desiredCount':0} for n in controller.SERVICES]}
            return {}
        with patch.object(manage,'aws',side_effect=aws),patch.object(manage,'invoke',return_value={'ready':True}):
            manage.operate('start',120)
        changes=[c for c in calls if c[1]=='update-service']
        self.assertEqual(len(changes),3)
        self.assertEqual({c[c.index('--service')+1] for c in changes},set(controller.SERVICES))
        self.assertTrue(all('--force-new-deployment' in c for c in changes))
    def test_extending_running_window_does_not_redeploy_testing(self):
        with patch.object(manage,'aws',return_value={'services':[{'serviceName':n,'desiredCount':1} for n in controller.SERVICES]}) as aws,patch.object(manage,'invoke',return_value={'ready':True}):
            manage.operate('start',120)
        self.assertEqual(aws.call_count,1)

    def test_template_has_no_new_shared_infrastructure_or_production_credentials(self):
        body=template.build({'ImageTag':'sha-29a8545'}, {'HttpsListener':'listener'}, {n:'test-'+n for n in ['DATABASE_URL','INTERNAL_API_KEY','JWT_SECRET','INTEGRATION_ENCRYPTION_KEY']},'cert')
        resources=body['Resources']
        self.assertFalse(any(r['Type'] in ['AWS::RDS::DBInstance','AWS::EC2::NatGateway','AWS::ElasticLoadBalancingV2::LoadBalancer','AWS::ECS::Cluster'] for r in resources.values()))
        for name in ['BackendService','FrontendService','AiService']:
            self.assertEqual(resources[name]['Properties']['DesiredCount'],0)
            self.assertTrue(resources[name]['Properties']['ServiceName'].startswith('testing-'))
        encoded=json.dumps(body)
        for forbidden in ['circini-SecretDatabaseUrl','circini-SecretJwt','circini-SecretInternalApiKey','circini-SecretGitHubOAuth','circini-SecretSeedAdmin']:
            self.assertNotIn(forbidden,encoded)
        refs=[]
        def walk(v):
            if isinstance(v,dict):
                if 'Ref' in v:refs.append(v['Ref'])
                for child in v.values():walk(child)
            if isinstance(v,list):
                for child in v:walk(child)
        walk(body)
        self.assertEqual(set(refs)-set(resources)-set(body['Parameters'])-{'AWS::AccountId','AWS::Region','AWS::NoValue'},set())
        self.assertLess(len(encoded.encode()),51200)
    def test_testing_lease_keeps_only_database_on_outside_production_hours(self):
        aws=FakeAWS();aws.services=[]
        desired=hours.plan(datetime.fromisoformat('2026-09-26T01:00:00+00:00'))
        with patch.dict(sys.modules,{'boto3':SimpleNamespace(client=lambda name:aws)}),patch.object(hours,'read_lease',return_value=({},None)),patch.object(hours,'plan',return_value=desired),patch.object(hours,'reconcile',side_effect=lambda desired,*args:desired),patch.object(hours,'set_availability_notifications'):
            result=hours.handler({},None)
        self.assertTrue(result['databaseOn']);self.assertFalse(result['servicesOn']);self.assertFalse(result['publicOpen'])

if __name__=='__main__':unittest.main()
