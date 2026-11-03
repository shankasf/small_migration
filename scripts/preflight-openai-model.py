#!/usr/bin/env python3
"""Confirm the production OpenAI key can use OPENAI_MODEL BEFORE new tasks start.

Runs the current ai-service task definition as a one-off task, so the check uses
the same Secrets Manager key and network path as the service. A model the
account cannot use fails the deploy while the running tasks keep serving.
"""
import json
import os
import re
import subprocess

MODEL = os.environ.get('OPENAI_MODEL', '').strip()
if not re.fullmatch(r'[A-Za-z0-9._:-]{1,100}', MODEL):
    raise SystemExit('OPENAI_MODEL is missing or malformed')


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))

existing = aws('ecs', 'list-task-definitions', '--family-prefix', 'circini-ai-service', '--sort', 'DESC', '--max-items', '1')
if not existing.get('taskDefinitionArns'):
    print('First deployment: no ai-service task definition yet, skipping model preflight')
    raise SystemExit(0)
exports = {e['Name']: e['Value'] for e in aws('cloudformation', 'list-exports')['Exports']}
# Fixed code only; the model id reaches the task as an environment variable.
check = (
    "import os,sys,json,urllib.request,urllib.error\n"
    "req=urllib.request.Request('https://api.openai.com/v1/models/'+os.environ['CHECK_MODEL'],"
    "headers={'Authorization':'Bearer '+os.environ.get('OPENAI_API_KEY','')})\n"
    "try:\n"
    "    urllib.request.urlopen(req,timeout=20)\n"
    "    print('model available')\n"
    "except urllib.error.HTTPError as e:\n"
    "    print('model check failed: HTTP',e.code)\n"
    "    sys.exit(1)\n"
)
network = {'awsvpcConfiguration': {'subnets': exports['circini-AppSubnets'].split(','), 'securityGroups': [exports['circini-SgApp']], 'assignPublicIp': 'DISABLED'}}
override = {'containerOverrides': [{'name': 'ai-service', 'command': ['python', '-c', check],
                                    'environment': [{'name': 'CHECK_MODEL', 'value': MODEL}]}]}
result = aws('ecs', 'run-task', '--cluster', 'circini-demo', '--launch-type', 'FARGATE', '--task-definition', existing['taskDefinitionArns'][0],
             '--network-configuration', json.dumps(network), '--overrides', json.dumps(override))
if result.get('failures') or not result.get('tasks'):
    raise RuntimeError('Could not start the OpenAI model preflight task')
arn = result['tasks'][0]['taskArn']
subprocess.run(['aws', 'ecs', 'wait', 'tasks-stopped', '--cluster', 'circini-demo', '--tasks', arn], check=True)
task = aws('ecs', 'describe-tasks', '--cluster', 'circini-demo', '--tasks', arn)['tasks'][0]
container = next(c for c in task['containers'] if c['name'] == 'ai-service')
if container.get('exitCode') != 0:
    raise SystemExit(f'The OpenAI account cannot use {MODEL}; running tasks were left in place')
print(f'OpenAI model preflight passed for {MODEL}')
