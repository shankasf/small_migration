#!/usr/bin/env python3
"""Deploy/operate the isolated testing stack with GitHub OIDC credentials."""
import argparse
import base64
import gzip
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
from urllib.parse import quote
from template import ROOT, DOMAIN, build

STACK='circini-testing'

def aws(*args):
    out=subprocess.check_output(['aws',*args,'--output','json'],text=True)
    return json.loads(out) if out.strip() else {}

def stack(name):return aws('cloudformation','describe-stacks','--stack-name',name)['Stacks'][0]
def physical(name):return {r['LogicalResourceId']:r['PhysicalResourceId'] for r in aws('cloudformation','list-stack-resources','--stack-name',name)['StackResourceSummaries'] if r['ResourceStatus']!='DELETE_COMPLETE'}

def ensure_secret(name,value):
    lookup=subprocess.run(['aws','secretsmanager','describe-secret','--secret-id',name,'--output','json'],capture_output=True,text=True)
    if lookup.returncode==0:return json.loads(lookup.stdout)['ARN']
    if 'ResourceNotFoundException' not in lookup.stderr:raise RuntimeError('Secret lookup failed')
    # A file prevents secret values appearing in process arguments or CI output.
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
        os.chmod(f.name,0o600);json.dump({'Name':name,'SecretString':value},f);f.flush()
        return aws('secretsmanager','create-secret','--cli-input-json','file://'+f.name)['ARN']

def invoke(payload):
    with tempfile.NamedTemporaryFile() as f:
        for attempt in range(8):
            result=subprocess.run(['aws','lambda','invoke','--function-name','circini-testing','--cli-binary-format','raw-in-base64-out','--payload',json.dumps(payload),f.name],capture_output=True,text=True)
            if result.returncode==0:
                meta=json.loads(result.stdout);body=json.loads(Path(f.name).read_text())
                if meta.get('FunctionError'):raise RuntimeError('Testing controller failed: '+json.dumps(body))
                return body
            if 'TooManyRequestsException' not in result.stderr:raise RuntimeError(result.stderr)
            time.sleep(3+attempt)
        raise RuntimeError('Testing controller busy')

def operate(operation,minutes=120,wait=False):
    if operation=='start':
        if not 5 <= minutes <= 180:raise ValueError('Duration must be 5 to 180 minutes')
        # Service Connect endpoints are captured at deployment, not scale-up.
        # Both directions must see all endpoints after initial parallel creation.
        services=aws('ecs','describe-services','--cluster','circini-demo','--services','testing-frontend','testing-backend','testing-ai-service')['services']
        for service in services:
            if service['desiredCount']==0:
                aws('ecs','update-service','--cluster','circini-demo','--service',service['serviceName'],'--force-new-deployment')
    out=invoke({'operation':operation,**({'minutes':minutes} if operation=='start' else {})});print(json.dumps(out),flush=True)
    deadline=time.monotonic()+2400
    while wait:
        if (operation=='start' and out['ready']) or (operation=='stop' and all(s['runningCount']==0 and s['pendingCount']==0 and s['desiredCount']==0 for s in out['services'])):break
        if time.monotonic()>deadline:raise TimeoutError('Testing did not reach requested state')
        time.sleep(15);out=invoke({'operation':'reconcile'});print(json.dumps(out),flush=True)
    return out

def task(definition,network,container,script=None):
    overrides={}
    if script:
        encoded=base64.b64encode(gzip.compress(script.encode(),mtime=0)).decode()
        command="require('fs').writeFileSync('/tmp/testing-check.cjs',require('zlib').gunzipSync(Buffer.from('"+encoded+"','base64')));require('/tmp/testing-check.cjs')"
        overrides={'containerOverrides':[{'name':container,'command':['node','-e',command]}]}
    assert len(json.dumps(overrides).encode())<8192
    result=aws('ecs','run-task','--cluster','circini-demo','--launch-type','FARGATE','--task-definition',definition,'--network-configuration',json.dumps(network),'--overrides',json.dumps(overrides),'--started-by','testing-setup')
    assert not result.get('failures'),result.get('failures')
    arn=result['tasks'][0]['taskArn'];print('Testing task:',arn,flush=True)
    deadline=time.monotonic()+1200
    while True:
        t=aws('ecs','describe-tasks','--cluster','circini-demo','--tasks',arn)['tasks'][0]
        if t['lastStatus']=='STOPPED':break
        if time.monotonic()>deadline:
            aws('ecs','stop-task','--cluster','circini-demo','--task',arn,'--reason','Testing operation timeout');raise TimeoutError('Testing task timeout')
        time.sleep(15)
    c=next(c for c in t['containers'] if c['name']==container)
    td=aws('ecs','describe-task-definition','--task-definition',definition)['taskDefinition']
    options=next(c for c in td['containerDefinitions'] if c['name']==container)['logConfiguration']['options']
    stream=options['awslogs-stream-prefix']+'/'+container+'/'+arn.rsplit('/',1)[-1]
    logs=aws('logs','get-log-events','--log-group-name',options['awslogs-group'],'--log-stream-name',stream,'--start-from-head')
    for event in logs['events']:
        try:value=json.loads(event['message'])
        except ValueError:continue
        if isinstance(value,dict) and any(k in value for k in ['testingBootstrap','testingLiveCheck']):print(json.dumps(value),flush=True)
    if c.get('exitCode')!=0:raise RuntimeError('Testing task failed: '+json.dumps({'task':arn,'reason':t.get('stoppedReason'),'exit':c.get('exitCode')}))
    print('Testing task passed:',arn,flush=True)

def recover_initial_stack(compiled):
    # Initial creation failed before any app service or database bootstrap ran.
    # Import retained stores rather than deleting/recreating even empty data.
    records=aws('cloudformation','list-stack-resources','--stack-name',STACK)['StackResourceSummaries']
    assert not any(r['LogicalResourceId'] in ['FrontendService','BackendService','AiService'] for r in records),'Recovery limited to an initial pre-service failure'
    keep=['AuditArchive','AgentCheckpointBucket','AgentCheckpointTable','AgentMemoryTable','LogGroup','ControllerLogs']
    existing={r['LogicalResourceId']:r for r in records}
    assert all(k in existing for k in keep)
    policies=[r['LogicalResourceId'] for r in records if r['ResourceStatus']=='DELETE_FAILED']
    assert set(policies)<= {'AuditArchivePolicy','AgentCheckpointBucketPolicy'}
    # The stores have DeletionPolicy: Retain. Only failed bucket policies
    # are removed here; the now-scoped cleanup permission permits this.
    aws('cloudformation','delete-stack','--stack-name',STACK)
    subprocess.run(['aws','cloudformation','wait','stack-delete-complete','--stack-name',STACK],check=True)
    partial={'AWSTemplateFormatVersion':'2010-09-09','Resources':{k:compiled['Resources'][k] for k in keep}}
    imports=[]
    for key in keep:
        resource=partial['Resources'][key]
        identifier={'AWS::S3::Bucket':'BucketName','AWS::DynamoDB::Table':'TableName','AWS::Logs::LogGroup':'LogGroupName'}[resource['Type']]
        imports.append({'ResourceType':resource['Type'],'LogicalResourceId':key,'ResourceIdentifier':{identifier:existing[key]['PhysicalResourceId']}})
    path=ROOT/'testing-recovery.json';path.write_text(json.dumps(partial))
    name='recover-retained-'+str(int(time.time()))
    aws('cloudformation','create-change-set','--stack-name',STACK,'--change-set-name',name,'--change-set-type','IMPORT','--template-body','file://'+str(path),'--resources-to-import',json.dumps(imports))
    for _ in range(90):
        change=aws('cloudformation','describe-change-set','--stack-name',STACK,'--change-set-name',name)
        if change['Status'] in ['CREATE_COMPLETE','FAILED']:break
        time.sleep(2)
    assert change['Status']=='CREATE_COMPLETE',change.get('StatusReason')
    assert all(c['ResourceChange']['Action']=='Import' for c in change['Changes'])
    aws('cloudformation','execute-change-set','--stack-name',STACK,'--change-set-name',name)
    subprocess.run(['aws','cloudformation','wait','stack-import-complete','--stack-name',STACK],check=True)
    print('Retained testing stores imported without deleting data',flush=True)


def deploy(tag):
    assert aws('sts','get-caller-identity')['Account']=='026146807914'
    app=stack('circini-app');params={p['ParameterKey']:p['ParameterValue'] for p in app['Parameters']};p=physical('circini-app')
    before=aws('ecs','describe-services','--cluster','circini-demo','--services','frontend','backend','ai-service')['services']
    if tag:params['ImageTag']=tag
    assert re.fullmatch(r'sha-[0-9a-f]{7,40}',params['ImageTag'])
    for service in ['frontend','backend','ai-service']:
        aws('ecr','describe-images','--repository-name','circini-'+service,'--image-ids','imageTag='+params['ImageTag'])
    certs=aws('acm','list-certificates','--certificate-statuses','ISSUED')['CertificateSummaryList']
    certificate=next((c['CertificateArn'] for c in certs if DOMAIN in c.get('SubjectAlternativeNameSummaries',[]) or c['DomainName']==DOMAIN),None)
    assert certificate,'No issued testing hostname certificate found'
    data={o['OutputKey']:o['OutputValue'] for o in stack('circini-data')['Outputs']}
    endpoint=data['DbEndpoint']
    arns={'DATABASE_URL':ensure_secret('circini/testing/database-url',f'postgresql://circini_testing:{secrets.token_hex(32)}@{endpoint}:5432/circini_testing?sslmode=require'),
          'JWT_SECRET':ensure_secret('circini/testing/jwt-secret',secrets.token_hex(48)),
          'INTERNAL_API_KEY':ensure_secret('circini/testing/internal-api-key',secrets.token_hex(48)),
          'INTEGRATION_ENCRYPTION_KEY':ensure_secret('circini/testing/integration-encryption-key',secrets.token_hex(32))}
    compiled=build(params,p,arns,certificate)
    path=ROOT/'testing-template.json';path.write_text(json.dumps(compiled,separators=(',',':')))
    probe=subprocess.run(['aws','cloudformation','describe-stacks','--stack-name',STACK],capture_output=True,text=True)
    exists=probe.returncode==0
    if not exists and 'does not exist' not in probe.stderr:raise RuntimeError('Cannot inspect testing stack')
    if exists and json.loads(probe.stdout)['Stacks'][0]['StackStatus']=='ROLLBACK_FAILED':
        recover_initial_stack(compiled)
    if exists and 'Controller' in physical(STACK):operate('stop',wait=True)
    # Review before execution. Existing stateful stores may never be removed or replaced.
    name='testing-'+str(int(time.time()))
    aws('cloudformation','create-change-set','--stack-name',STACK,'--change-set-name',name,'--change-set-type','UPDATE' if exists else 'CREATE','--template-body','file://'+str(path),'--parameters',json.dumps([{'ParameterKey':k,'ParameterValue':str(v['Default'])} for k,v in compiled['Parameters'].items()]),'--capabilities','CAPABILITY_NAMED_IAM')
    for _ in range(90):
        change=aws('cloudformation','describe-change-set','--stack-name',STACK,'--change-set-name',name)
        if change['Status'] in ['CREATE_COMPLETE','FAILED']:break
        time.sleep(2)
    unchanged=change['Status']=='FAILED' and "didn't contain changes" in change.get('StatusReason','')
    if not unchanged:
        assert change['Status']=='CREATE_COMPLETE',change.get('StatusReason')
        for item in change.get('Changes',[]):
            c=item['ResourceChange'];assert c['Action']!='Remove',c
            if c['LogicalResourceId'] in ['AuditArchive','AgentCheckpointTable','AgentMemoryTable','AgentCheckpointBucket','SpaClient']:
                assert c.get('Replacement','False')=='False',c
            print('Testing change:',c['Action'],c['LogicalResourceId'],flush=True)
        aws('cloudformation','execute-change-set','--stack-name',STACK,'--change-set-name',name,'--disable-rollback')
        subprocess.run(['aws','cloudformation','wait','stack-update-complete' if exists else 'stack-create-complete','--stack-name',STACK],check=True)
    live=physical(STACK)
    network=before[0]['networkConfiguration']
    # This privileged task exists only for database creation/extension setup.
    bootstrap=aws('ecs','describe-task-definition','--task-definition',p['SchemaSyncTaskDef'])['taskDefinition']
    allowed=['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','requiresCompatibilities','cpu','memory']
    bootstrap={k:v for k,v in bootstrap.items() if k in allowed};bootstrap['family']='circini-testing-bootstrap'
    next(c for c in bootstrap['containerDefinitions'] if c['name']=='schema-sync')['secrets'].append({'name':'TEST_DATABASE_URL','valueFrom':arns['DATABASE_URL']})
    definition=aws('ecs','register-task-definition','--cli-input-json',json.dumps(bootstrap))['taskDefinition']['taskDefinitionArn']
    try:task(definition,network,'schema-sync',(ROOT/'scripts/testing/bootstrap.cjs').read_text())
    finally:aws('ecs','deregister-task-definition','--task-definition',definition)
    task(live['SchemaSyncTaskDef'],network,'schema-sync')
    after=aws('ecs','describe-services','--cluster','circini-demo','--services','frontend','backend','ai-service')['services']
    assert {s['serviceName']:s['taskDefinition'] for s in before}=={s['serviceName']:s['taskDefinition'] for s in after},'Production task definitions changed'
    print(json.dumps({'testingDeployment':'passed','imageTag':params['ImageTag'],'productionTaskDefinitionsUnchanged':True}),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('operation',choices=['deploy','start','stop','status','reconcile']);parser.add_argument('--image-tag');parser.add_argument('--minutes',type=int,default=120);parser.add_argument('--wait',action='store_true');args=parser.parse_args()
    if args.operation=='deploy':deploy(args.image_tag)
    else:operate(args.operation,args.minutes,args.wait)
