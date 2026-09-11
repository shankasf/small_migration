#!/usr/bin/env python3
"""Exercise the public API from the exact live backend image without exporting secrets."""
import base64
import gzip
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))


stable_deadline = time.monotonic() + 1200
while True:
    backend = aws('ecs', 'describe-services', '--cluster', 'circini-demo', '--services', 'backend')['services'][0]
    stable = backend['runningCount'] == backend['desiredCount'] and backend['pendingCount'] == 0
    stable = stable and all(d.get('rolloutState') == 'COMPLETED' for d in backend['deployments'])
    if stable:
        break
    assert time.monotonic() < stable_deadline, 'Backend did not stabilize before verification deadline'
    print(json.dumps({'fileLibraryProgress': 'waiting for backend steady state'}), flush=True)
    time.sleep(15)
source = Path('scripts/diagnose-github-chat.cjs').read_bytes()
encoded = base64.b64encode(gzip.compress(source, mtime=0)).decode()
# /tmp is the task's explicitly writable ephemeral volume. The code is trusted repository code.
command = "require('node:fs').writeFileSync('/tmp/github-chat-diagnostic.cjs',require('node:zlib').gunzipSync(Buffer.from('" + encoded + "','base64')));require('/tmp/github-chat-diagnostic.cjs')"
environment = []
for name in ():
    if os.environ.get(name):
        environment.append({'name': name, 'value': os.environ[name]})
overrides = {'containerOverrides': [{'name': 'backend', 'command': ['node', '-e', command], 'environment': environment}]}
serialized = json.dumps(overrides, separators=(',', ':'))
assert len(serialized.encode()) <= 8192, 'ECS overrides exceed the 8192-byte limit'
with tempfile.TemporaryDirectory(prefix='circini-file-library-') as directory:
    path = Path(directory) / 'overrides.json'
    path.write_text(serialized)
    result = aws('ecs', 'run-task', '--cluster', 'circini-demo', '--launch-type', 'FARGATE',
                 '--task-definition', backend['taskDefinition'], '--network-configuration', json.dumps(backend['networkConfiguration']),
                 '--overrides', f'file://{path}', '--started-by', 'github-chat-diagnostic')
assert not result.get('failures') and result.get('tasks'), 'Could not start file-library verification'
arn = result['tasks'][0]['taskArn']
print(f'GitHub read-only diagnostic task: {arn}', flush=True)
stream = f"backend/backend/{arn.rsplit('/', 1)[-1]}"
next_token = None
passed = False
deadline = time.monotonic() + 600
while True:
    task = aws('ecs', 'describe-tasks', '--cluster', 'circini-demo', '--tasks', arn)['tasks'][0]
    try:
        args = ['logs', 'get-log-events', '--log-group-name', '/ecs/circini', '--log-stream-name', stream, '--start-from-head']
        if next_token:
            args += ['--next-token', next_token]
        logs = aws(*args)
        next_token = logs.get('nextForwardToken')
        for event in logs['events']:
            try:
                value = json.loads(event['message'])
            except json.JSONDecodeError:
                continue
            if any(key in value for key in ('githubChatDiagnostic', 'githubChatDiagnosticError')):
                print(json.dumps(value), flush=True)
                passed |= 'githubChatDiagnostic' in value
    except subprocess.CalledProcessError:
        if task['lastStatus'] == 'STOPPED':
            raise
    if task['lastStatus'] == 'STOPPED':
        container = next(c for c in task['containers'] if c['name'] == 'backend')
        assert container.get('exitCode') == 0 and passed, 'Production file-library verification failed'
        break
    if time.monotonic() >= deadline:
        aws('ecs', 'stop-task', '--cluster', 'circini-demo', '--task', arn, '--reason', 'File-library verification timeout')
        raise TimeoutError('Verification timed out; temporary key expires automatically')
    time.sleep(15)
