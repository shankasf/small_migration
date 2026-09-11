#!/usr/bin/env python3
"""Compile the reviewed controller into CloudFormation and deploy with the AWS CLI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone, timedelta
import yaml
from business_hours_controller import plan

ROOT = Path(__file__).resolve().parents[1]

def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))

def main():
    resources = aws('cloudformation', 'describe-stack-resources', '--stack-name', 'circini-app')['StackResources']
    physical = {r['LogicalResourceId']: r['PhysicalResourceId'] for r in resources if r['ResourceStatus'] != 'DELETE_COMPLETE'}
    outputs = {o['OutputKey']: o['OutputValue'] for o in aws('cloudformation', 'describe-stacks', '--stack-name', 'circini-app')['Stacks'][0]['Outputs']}
    template = yaml.safe_load((ROOT / 'deploy/aws/business-hours.yaml').read_text())
    template['Resources']['Controller']['Properties']['Code']['ZipFile'] = (ROOT / 'scripts/business_hours_controller.py').read_text()
    owner = os.environ.get('GITHUB_RUN_ID')
    lease = {'owner': owner, 'until': (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()} if owner else {}
    with tempfile.TemporaryDirectory(prefix='circini-hours-') as directory:
        compiled = Path(directory) / 'template.json'
        compiled.write_text(json.dumps(template))
        subprocess.run(['aws', 'cloudformation', 'deploy', '--stack-name', 'circini-business-hours',
            '--template-file', str(compiled), '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset',
            '--parameter-overrides', 'ListenerArn='+physical.get('HttpsListener', physical['HttpListener']),
            'FrontendTargetArn='+physical['FrontendTargetGroup'], 'BackendTargetArn='+physical['BackendTargetGroup'],
            'AlertTopicArn='+outputs['SecurityAlertTopicArn'],
            'InitiallyOpen='+str(bool(owner) or plan(datetime.now(timezone.utc))['publicOpen']).lower(),
            'InitialLease='+json.dumps(lease)], check=True)
    print(json.dumps(aws('scheduler', 'get-schedule', '--name', 'circini-business-hours'), default=str))

if __name__ == '__main__':
    main()
