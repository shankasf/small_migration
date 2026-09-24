"""Compile isolated testing resources from the reviewed production definitions.

Only the named resources are copied. The cluster, network, ALB and physical RDS
remain owned by their existing stacks; no production service is updated here.
"""
import copy
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[2]
DOMAIN = 'migration.callsphere.site'
class Loader(yaml.SafeLoader):
    pass

def intrinsic(loader, tag, node):
    value = (loader.construct_scalar(node) if isinstance(node, yaml.ScalarNode)
             else loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode)
             else loader.construct_mapping(node))
    if tag == 'GetAtt' and isinstance(value, str): value = value.split('.', 1)
    return {tag if tag in ('Ref', 'Condition') else 'Fn::' + tag: value}
Loader.add_multi_constructor('!', intrinsic)

def load(path): return yaml.load(Path(path).read_text(), Loader=Loader)
def ref(name): return {'Ref': name}
def sub(value): return {'Fn::Sub': value}
def host(): return {'Field': 'host-header', 'HostHeaderConfig': {'Values': [DOMAIN]}}

def build(parameters, physical, secret_arns, certificate):
    source = load(ROOT / 'deploy/aws/app.yaml')
    names = ['LogGroup', 'AuditArchive', 'AuditArchivePolicy', 'AgentCheckpointTable', 'AgentMemoryTable',
             'AgentCheckpointBucket', 'AgentCheckpointBucketPolicy', 'Namespace', 'ExecutionRole', 'TaskRole',
             'AiServiceTaskRole', 'BackendTaskRole', 'FrontendTargetGroup', 'BackendTargetGroup',
             'FrontendTaskDef', 'BackendTaskDef', 'AiServiceTaskDef', 'SchemaSyncTaskDef',
             'BackendService', 'FrontendService', 'AiService']
    resources = {n: copy.deepcopy(source['Resources'][n]) for n in names}
    params = copy.deepcopy(source['Parameters'])
    for name, definition in params.items():
        if name in parameters: definition['Default'] = parameters[name]
    params['AppDomain']['Default'] = DOMAIN
    params['IntegrationAppDomain']['Default'] = ''
    params['CertificateArn']['Default'] = certificate
    params['AdditionalCertificateArn']['Default'] = ''
    # Keep traces distinct and disable optional third-party tracing by default.
    params['LangSmithSecretArn']['Default'] = ''
    r = resources
    r['LogGroup']['Properties']['LogGroupName'] = '/ecs/circini-testing'
    r['LogGroup']['DeletionPolicy']='Retain';r['LogGroup']['UpdateReplacePolicy']='Retain'
    for n in ['AuditArchive','AgentCheckpointBucket']:
        p=r[n]['Properties'];p['BucketName']['Fn::Sub']=p['BucketName']['Fn::Sub'].replace('circini-', 'circini-testing-',1)
        r[n]['DeletionPolicy']='Retain';r[n]['UpdateReplacePolicy']='Retain'
    for n in ['AgentCheckpointTable','AgentMemoryTable']:
        p=r[n]['Properties'];p['TableName']=p['TableName'].replace('circini-', 'circini-testing-',1)
        r[n]['DeletionPolicy']='Retain';r[n]['UpdateReplacePolicy']='Retain'
    # Service Connect uses Cloud Map directly; an HTTP namespace avoids an
    # unnecessary private Route 53 zone and its extra permissions/cost.
    r['Namespace']={'Type':'AWS::ServiceDiscovery::HttpNamespace','Properties':{'Name':'circini-testing'}}
    for n in ['ExecutionRole','TaskRole','AiServiceTaskRole','BackendTaskRole']:
        p=r[n]['Properties'];p['RoleName']=p['RoleName'].replace('circini-', 'circini-testing-',1)
    r['ExecutionRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'][0]['Resource'] = [
        sub('arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:circini/testing/*'),
        *[{'Fn::ImportValue': 'circini-Secret'+n} for n in ['OpenAi','AzureOpenAi','Bedrock']]]
    for n in ['FrontendTargetGroup','BackendTargetGroup']:
        p=r[n]['Properties'];p['Name']=p['Name'].replace('circini-', 'circini-testing-',1)
        p.setdefault('TargetGroupAttributes',[]).append({'Key':'deregistration_delay.timeout_seconds','Value':'30'})
    client=load(ROOT/'deploy/aws/cognito.yaml')['Resources']['SpaClient']
    client['Properties'].update(ClientName='circini-testing-spa', UserPoolId={'Fn::ImportValue':'circini-UserPoolId'},
        CallbackURLs=[f'https://{DOMAIN}/auth/callback'],LogoutURLs=[f'https://{DOMAIN}'])
    r['SpaClient']=client
    for n in ['FrontendTaskDef','BackendTaskDef','AiServiceTaskDef','SchemaSyncTaskDef']:
        p=r[n]['Properties'];p['Family']=p['Family'].replace('circini-', 'circini-testing-',1)
        for c in p['ContainerDefinitions']:
            for env in c.get('Environment',[]):
                if env['Name'] in ['CORS_ORIGIN','PUBLIC_APP_URL']:env['Value']=f'https://{DOMAIN}'
                if env['Name'] in ['OIDC_CLIENT_ID','OIDC_AUDIENCE']:env['Value']=ref('SpaClient')
                if env['Name']=='LANGSMITH_PROJECT':env['Value']='circini-testing'
                if env['Name']=='MAX_CONCURRENT_TURNS':env['Value']='2'
                if env['Name']=='OTEL_SERVICE_NAME':env['Value']=env['Value'].replace('circini-','circini-testing-',1)
            secrets=[]
            for value in c.get('Secrets',[]):
                name=value.get('Name','')
                # Testing requires independently registered provider apps; never
                # reuse production GitHub App private keys or user credentials.
                if name.startswith(('GITHUB_','GITLAB_','SEED_ADMIN_')):continue
                if name in secret_arns:value['ValueFrom']=secret_arns[name]
                secrets.append(value)
            if 'Secrets' in c:c['Secrets']=secrets
    for n in ['FrontendService','BackendService','AiService']:
        p=r[n]['Properties'];p['ServiceName']='testing-'+p['ServiceName'];p['Cluster']='circini-demo';p['DesiredCount']=0
        r[n].pop('DependsOn',None)
    r['FrontendService']['DependsOn']='FrontendRule'
    r['BackendService']['DependsOn']='ApiRule'
    def rule(priority, target, paths=None):
        conditions=[host()]
        if paths:conditions.append({'Field':'path-pattern','PathPatternConfig':{'Values':paths}})
        return {'Type':'AWS::ElasticLoadBalancingV2::ListenerRule','Properties':{
            'ListenerArn':physical['HttpsListener'],'Priority':priority,'Conditions':conditions,
            'Actions':[{'Type':'forward','TargetGroupArn':ref(target)}]}}
    r['ApiRule']=rule(4,'BackendTargetGroup',['/api/*','/socket.io/*'])
    r['FrontendRule']=rule(5,'FrontendTargetGroup')
    r['Gate']=rule(3,'FrontendTargetGroup',['/*'])
    r['Gate']['Properties']['Actions']=[{'Type':'fixed-response','FixedResponseConfig':{
        'StatusCode':'503','ContentType':'text/html','MessageBody':'<!doctype html><html><title>Testing is paused</title><body><h1>Testing is paused</h1><p>Start the testing environment from the Testing environment GitHub Actions workflow. It shuts down automatically after the selected duration.</p></body></html>'}}]
    r['TestingCertificate']={'Type':'AWS::ElasticLoadBalancingV2::ListenerCertificate','Properties':{
        'ListenerArn':physical['HttpsListener'],'Certificates':[{'CertificateArn':certificate}]}}
    controller=yaml.safe_load((ROOT/'deploy/aws/testing-controller.yaml').read_text())
    r.update(controller['Resources'])
    r['Controller']['Properties']['Code']['ZipFile']=(ROOT/'scripts/testing/controller.py').read_text()
    for name in ['AppDomain','IntegrationAppDomain','AdditionalCertificateArn','CertificateArn']:params.pop(name)
    conditions={k:v for k,v in source['Conditions'].items() if k not in ['HasCertificate','HasIntegrationAppDomain','HasAdditionalCertificate']}
    return {'AWSTemplateFormatVersion':'2010-09-09','Description':'On-demand testing; shared network ALB cluster and RDS, isolated app state',
            'Parameters':params,'Conditions':conditions,'Resources':r,
            'Outputs':{n:{'Value':ref(n)} for n in ['SpaClient','FrontendTargetGroup','BackendTargetGroup','Gate','SchemaSyncTaskDef','Controller']}}
