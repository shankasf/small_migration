"""Wait for completed ECS rollouts without restarting services."""
import json
import subprocess
import time


def main():
    deadline = time.monotonic() + 1200
    while True:
        result = json.loads(subprocess.check_output([
            'aws', 'ecs', 'describe-services', '--cluster', 'circini-demo',
            '--services', 'backend', 'frontend', 'ai-service', '--output', 'json'], text=True))
        services = result.get('services', [])
        ready = not result.get('failures') and len(services) == 3 and all(
            service['desiredCount'] > 0 and service['runningCount'] == service['desiredCount']
            and service['pendingCount'] == 0 and len(service['deployments']) == 1
            and service['deployments'][0].get('rolloutState') == 'COMPLETED'
            for service in services)
        print(json.dumps({'ecsStable': ready, 'services': [{
            'name': s['serviceName'], 'desired': s['desiredCount'], 'running': s['runningCount'],
            'pending': s['pendingCount'], 'rollouts': [d.get('rolloutState') for d in s['deployments']],
        } for s in services]}), flush=True)
        if ready:
            return
        if time.monotonic() >= deadline:
            raise TimeoutError('ECS services did not complete their rollouts within 20 minutes')
        time.sleep(15)


if __name__ == '__main__':
    main()
