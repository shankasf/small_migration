"""Run checks with the live backend image and retrieve only its check output."""
import json
from pathlib import Path
import subprocess
import tempfile


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))


services = aws('ecs', 'describe-services', '--cluster', 'circini-demo', '--services', 'backend', 'frontend', 'ai-service')['services']
backend = next(service for service in services if service['serviceName'] == 'backend')
for service in services:
    assert service['runningCount'] == service['desiredCount'] and service['pendingCount'] == 0
    print(json.dumps({'service': service['serviceName'], 'running': service['runningCount'], 'taskDefinition': service['taskDefinition']}))

command = Path('scripts/check-github-live.cjs').read_text()
overrides = {'containerOverrides': [{'name': 'backend', 'command': ['node', '-e', command]}]}
with tempfile.TemporaryDirectory(prefix='circini-github-check-') as directory:
    path = Path(directory) / 'overrides.json'
    path.write_text(json.dumps(overrides))
    result = aws('ecs', 'run-task', '--cluster', 'circini-demo', '--launch-type', 'FARGATE',
                 '--task-definition', backend['taskDefinition'], '--network-configuration', json.dumps(backend['networkConfiguration']),
                 '--overrides', f'file://{path}', '--started-by', 'github-production-check')
assert not result.get('failures'), 'Could not start production verification task'
task_arn = result['tasks'][0]['taskArn']
print(f'Verification task: {task_arn}', flush=True)
subprocess.run(['aws', 'ecs', 'wait', 'tasks-stopped', '--cluster', 'circini-demo', '--tasks', task_arn], check=True)
task = aws('ecs', 'describe-tasks', '--cluster', 'circini-demo', '--tasks', task_arn)['tasks'][0]
container = next(item for item in task['containers'] if item['name'] == 'backend')
stream = f"backend/backend/{task_arn.rsplit('/', 1)[-1]}"
messages = aws('logs', 'get-log-events', '--log-group-name', '/ecs/circini', '--log-stream-name', stream)['events']
for event in messages:
    print(event['message'])
assert container.get('exitCode') == 0, 'Production verification task failed'
assert any('"githubProductionCheck":"passed"' in event['message'] for event in messages), 'Missing production verification result'
