#!/usr/bin/env python3
"""Operate the AWS controller with GitHub OIDC/normal AWS CLI credentials."""
import argparse
import json
import subprocess
import tempfile
import time
from pathlib import Path

FUNCTION = 'circini-business-hours'


def invoke(payload, optional=False):
    lookup = subprocess.run(['aws', 'lambda', 'get-function-configuration', '--function-name', FUNCTION], text=True, capture_output=True)
    if lookup.returncode:
        if optional and 'ResourceNotFoundException' in lookup.stderr:
            print('Business-hours controller is not installed yet.')
            return None
        raise RuntimeError('Cannot read the business-hours controller: ' + lookup.stderr.strip())
    with tempfile.TemporaryDirectory(prefix='circini-hours-invoke-') as directory:
        result = Path(directory) / 'result.json'
        for attempt in range(8):
            call = subprocess.run(['aws', 'lambda', 'invoke', '--function-name', FUNCTION,
                '--cli-binary-format', 'raw-in-base64-out', '--payload', json.dumps(payload), str(result)], text=True, capture_output=True)
            if call.returncode == 0:
                metadata = json.loads(call.stdout)
                body = json.loads(result.read_text())
                if metadata.get('FunctionError'):
                    raise RuntimeError('Business-hours controller failed: ' + json.dumps(body))
                return body
            if 'TooManyRequestsException' not in call.stderr:
                raise RuntimeError('Controller invocation failed: ' + call.stderr.strip())
            time.sleep(3 + attempt)
        raise RuntimeError('Controller is busy; retry this operation')


def operate(payload, optional=False, wait=False, wait_seconds=2400, pending_ok=False):
    requested = dict(payload)
    if wait:
        # Reserve enough startup time even when the requested open window is short.
        payload = {**payload, 'minutes': max(90, payload['minutes'])}
    result = invoke(payload, optional)
    if result is None:
        return
    print(json.dumps(result), flush=True)
    if not wait:
        return
    deadline = time.monotonic() + wait_seconds
    while not result.get('publicReady'):
        if time.monotonic() >= deadline:
            if pending_ok:
                print('Startup still pending; refresh AWS credentials before the next wait.', flush=True)
                return
            raise TimeoutError('Database/application did not become ready within this startup phase')
        time.sleep(15)
        result = invoke({'operation': 'reconcile'})
        print(json.dumps(result), flush=True)
    # The requested maintenance window begins when the application is ready.
    print(json.dumps(invoke(requested)), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['hold', 'release', 'status', 'reconcile', 'plan'])
    parser.add_argument('--owner')
    parser.add_argument('--minutes', type=int, default=180)
    parser.add_argument('--at', help='ISO timestamp; read-only plan only')
    parser.add_argument('--optional', action='store_true', help='Allow a controller not installed yet')
    parser.add_argument('--wait', action='store_true', help='Wait for database and application readiness after hold')
    parser.add_argument('--wait-seconds', type=int, default=2400, help='Startup phase duration, 15–2400 seconds')
    parser.add_argument('--pending-ok', action='store_true', help='Allow pending startup in the first credential phase')
    args = parser.parse_args()
    if not 5 <= args.minutes <= 180: parser.error('--minutes must be 5–180')
    if not 15 <= args.wait_seconds <= 2400: parser.error('--wait-seconds must be 15–2400')
    if args.pending_ok and not args.wait: parser.error('--pending-ok requires --wait')
    payload = {'operation': args.operation}
    if args.operation in ['hold', 'release']:
        if not args.owner: parser.error('--owner is required')
        payload['owner'] = args.owner
        if args.operation == 'hold': payload['minutes'] = args.minutes
    if args.at:
        if args.operation != 'plan': parser.error('--at is read-only and requires plan')
        payload['at'] = args.at
    if args.wait and args.operation != 'hold': parser.error('--wait requires hold')
    operate(payload, args.optional, args.wait, args.wait_seconds, args.pending_ok)


if __name__ == '__main__':
    main()
