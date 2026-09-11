#!/usr/bin/env python3
"""Move the public origin using only domain-related CloudFormation changes.

Keep deployed images, all unrelated resources, and existing provider callbacks.
Run through production-status.yml with the deployment concurrency lock.
"""
import json
from pathlib import Path
import subprocess
import time
import yaml

DOMAIN = 'migration-agent.uat.signify.net.nz'
CERT = 'arn:aws:acm:ap-southeast-2:026146807914:certificate/5f12ecf3-ce00-4840-ac77-e4b0ce039953'
OUT = Path('domain-evidence')
OUT.mkdir(exist_ok=True)

class CfnLoader(yaml.SafeLoader):
    pass

def intrinsic(loader, tag, node):
    value = (loader.construct_scalar(node) if isinstance(node, yaml.ScalarNode)
             else loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode)
             else loader.construct_mapping(node))
    if tag == 'GetAtt' and isinstance(value, str):
        value = value.split('.', 1)
    return {tag if tag in ('Ref', 'Condition') else 'Fn::' + tag: value}

CfnLoader.add_multi_constructor('!', intrinsic)

def aws(*args):
    output = subprocess.check_output(['aws', *args, '--output', 'json'], text=True)
    return json.loads(output) if output.strip() else {}

def template(stack):
    body = aws('cloudformation', 'get-template', '--stack-name', stack)['TemplateBody']
    return body if isinstance(body, str) else json.dumps(body)

def read_template(path):
    return yaml.load(Path(path).read_text(), Loader=CfnLoader)

def deploy(stack, body, overrides, allowed):
    old = aws('cloudformation', 'describe-stacks', '--stack-name', stack)['Stacks'][0]
    assert old['StackStatus'] in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'), old['StackStatus']
    (OUT / (stack + '-before.json')).write_text(json.dumps({'stack': old, 'template': template(stack)}, indent=2))
    path = OUT / (stack + '-template.json')
    path.write_text(body)
    params = [{'ParameterKey': p['ParameterKey'], 'UsePreviousValue': True}
              for p in old['Parameters'] if p['ParameterKey'] not in overrides]
    params += [{'ParameterKey': k, 'ParameterValue': v} for k, v in overrides.items()]
    name = 'signify-domain-' + str(int(time.time()))
    aws('cloudformation', 'create-change-set', '--stack-name', stack, '--change-set-name', name,
        '--change-set-type', 'UPDATE', '--template-body', 'file://' + str(path),
        '--parameters', json.dumps(params), '--capabilities', 'CAPABILITY_NAMED_IAM')
    for _ in range(90):
        change = aws('cloudformation', 'describe-change-set', '--stack-name', stack, '--change-set-name', name)
        if change['Status'] in ('CREATE_COMPLETE', 'FAILED'):
            break
        time.sleep(2)
    (OUT / (stack + '-change-set.json')).write_text(json.dumps(change, indent=2))
    if change['Status'] == 'FAILED' and "didn't contain changes" in change.get('StatusReason', ''):
        print(stack, 'already configured', flush=True)
        return
    assert change['Status'] == 'CREATE_COMPLETE', change.get('StatusReason')
    for item in change.get('Changes', []):
        resource = item['ResourceChange']
        assert resource['LogicalResourceId'] in allowed, resource
        assert resource['Action'] != 'Remove', resource
        print(stack, resource['Action'], resource['LogicalResourceId'], resource.get('Replacement', ''), flush=True)
    aws('cloudformation', 'execute-change-set', '--stack-name', stack, '--change-set-name', name)
    subprocess.run(['aws', 'cloudformation', 'wait', 'stack-update-complete', '--stack-name', stack], check=True)
    print(stack, 'UPDATE_COMPLETE', flush=True)

def main():
    assert aws('sts', 'get-caller-identity')['Account'] == '026146807914'
    cert = aws('acm', 'describe-certificate', '--certificate-arn', CERT)['Certificate']
    assert cert['Status'] == 'ISSUED', cert['Status']
    assert DOMAIN in cert['SubjectAlternativeNames'], cert['SubjectAlternativeNames']
    print('Certificate issued for', DOMAIN, 'expires', cert['NotAfter'], flush=True)
    (OUT / 'certificate.json').write_text(json.dumps(cert, indent=2))
    app_stack = aws('cloudformation', 'describe-stacks', '--stack-name', 'circini-app')['Stacks'][0]
    prior = {p['ParameterKey']: p['ParameterValue'] for p in app_stack['Parameters']}
    old_domain = prior.get('IntegrationAppDomain') or prior['AppDomain']
    old_cert = prior.get('AdditionalCertificateArn') or prior['CertificateArn']
    assert old_domain != DOMAIN, 'Expected retained integration callback domain'
    alb = aws('elbv2', 'describe-load-balancers', '--names', 'circini-demo')['LoadBalancers'][0]
    cname = subprocess.check_output(['dig', '+short', 'CNAME', DOMAIN], text=True).strip().rstrip('.')
    assert cname == alb['DNSName'], (cname, alb['DNSName'])
    print('DNS points to existing ALB:', cname, flush=True)
    # Attach the new certificate first: immediately fixes SNI without replacing tasks.
    listener = next(l for l in aws('elbv2', 'describe-listeners', '--load-balancer-arn', alb['LoadBalancerArn'])['Listeners'] if l['Port'] == 443)
    (OUT / 'listener-before.json').write_text(json.dumps(listener, indent=2))
    for certificate_arn in (CERT, old_cert):
        aws('elbv2', 'add-listener-certificates', '--listener-arn', listener['ListenerArn'], '--certificates',
            json.dumps([{'CertificateArn': certificate_arn}]))
    subprocess.run(['curl', '--fail', '--silent', '--show-error', '--retry', '5', 'https://' + DOMAIN + '/api/health'], check=True)
    # Keep the live YAML text: normalizing !GetAtt scalars into JSON arrays
    # causes CloudFormation to replace otherwise unchanged task definitions.
    app = template('circini-app')
    reference_text = Path('deploy/aws/app.yaml').read_text()
    parsed = yaml.load(app, Loader=CfnLoader)
    if 'AdditionalCertificateArn' not in parsed['Parameters']:
        parameters = reference_text[reference_text.index('  AdditionalCertificateArn:'):reference_text.index('  AppDomain:')]
        assert app.count('  AppDomain:') == 1
        app = app.replace('  AppDomain:', parameters + '  AppDomain:', 1)
        conditions = reference_text[reference_text.index('  HasAdditionalCertificate:'):reference_text.index('  UseAzure:')]
        assert app.count('  UseAzure:') == 1
        app = app.replace('  UseAzure:', conditions + '  UseAzure:', 1)
        certificate = reference_text[reference_text.index('  AdditionalHttpsCertificate:'):reference_text.index('  # ------------------------------------------------------- task definitions')]
        anchor = '  # ------------------------------------------------------- task definitions'
        assert app.count(anchor) == 1
        app = app.replace(anchor, certificate + anchor, 1)
        old_line = next(line for line in app.splitlines() if 'Name: PUBLIC_APP_URL,' in line)
        new_line = next(line for line in reference_text.splitlines() if 'Name: PUBLIC_APP_URL,' in line)
        app = app.replace(old_line, new_line, 1)
    updated = yaml.load(app, Loader=CfnLoader)
    assert all(updated['Resources'][key] == value for key, value in parsed['Resources'].items()
               if key != 'BackendTaskDef'), 'Unrelated resource definition changed'
    identity = template('circini-cognito')
    identity_parsed = yaml.load(identity, Loader=CfnLoader)
    if 'AdditionalAppUrl' not in identity_parsed['Parameters']:
        reference_id = read_template('deploy/aws/cognito.yaml')
        identity_parsed['Parameters']['AdditionalAppUrl'] = reference_id['Parameters']['AdditionalAppUrl']
        identity_parsed.setdefault('Conditions', {})['HasAdditionalAppUrl'] = reference_id['Conditions']['HasAdditionalAppUrl']
        for key in ('CallbackURLs', 'LogoutURLs'):
            identity_parsed['Resources']['SpaClient']['Properties'][key] = reference_id['Resources']['SpaClient']['Properties'][key]
        identity = json.dumps(identity_parsed)
    deploy('circini-cognito', identity, {'AppUrl': 'https://' + DOMAIN, 'AdditionalAppUrl': 'https://' + old_domain}, {'SpaClient'})
    deploy('circini-app', app, {'AppDomain': DOMAIN, 'CertificateArn': CERT,
        'AdditionalCertificateArn': old_cert, 'IntegrationAppDomain': old_domain},
        {'HttpsListener', 'AdditionalHttpsCertificate', 'BackendTaskDef', 'BackendService'})
    subprocess.run(['aws', 'ecs', 'wait', 'services-stable', '--cluster', 'circini-demo', '--services', 'frontend', 'backend', 'ai-service'], check=True)
    after = aws('cloudformation', 'describe-stacks', '--stack-name', 'circini-app')['Stacks'][0]
    values = {p['ParameterKey']: p['ParameterValue'] for p in after['Parameters']}
    assert values['ImageTag'] == prior['ImageTag'], 'Domain migration must preserve image tag'
    services = aws('ecs', 'describe-services', '--cluster', 'circini-demo', '--services', 'frontend', 'backend', 'ai-service')['services']
    for service in services:
        assert service['runningCount'] == service['desiredCount'] and service['runningCount'] > 0
        assert len(service['deployments']) == 1 and service['deployments'][0]['rolloutState'] == 'COMPLETED'
    (OUT / 'services-after.json').write_text(json.dumps(services, indent=2))
    print('All services stable; preserved application image:', values['ImageTag'], flush=True)
    print('External OAuth callbacks retained at https://' + old_domain, flush=True)
    subprocess.run(['bash', 'deploy/smoke-test.sh', 'https://' + DOMAIN], check=True)

if __name__ == '__main__':
    main()
