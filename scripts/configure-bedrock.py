#!/usr/bin/env python3
"""Validate the candidate Bedrock key before storing it; never print credentials."""
import json
import requests
import os
from pathlib import Path
import re
import subprocess
import tempfile


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))


def post(host, path, key, body):
    # TLS verification stays enabled; credentials must never follow a redirect.
    with requests.post(f'https://{host}{path}', json=body, timeout=90, allow_redirects=False,
                       headers={'Authorization': 'Bearer ' + key}) as response:
        if response.status_code != 200:
            raise RuntimeError('Provider preflight did not return HTTP 200')
        return response.json()


def main():
    region = os.environ.get('BEDROCK_REGION', 'ap-southeast-2')
    model = os.environ.get('BEDROCK_MODEL', 'openai.gpt-oss-120b-1:0')
    assert re.fullmatch(r'[a-z]{2}-[a-z]+-\d', region), 'Invalid Bedrock region'
    assert model == 'openai.gpt-oss-120b-1:0', 'Unvalidated Bedrock model'
    bootstrap = os.environ.get('BEDROCK_BOOTSTRAP_KEY', '').strip()
    key = bootstrap or aws('secretsmanager', 'get-secret-value', '--secret-id', 'circini/bedrock-api-key')['SecretString']
    assert key.startswith('ABSK') and '\n' not in key, 'Bedrock bearer key is missing or invalid'
    host = f'bedrock-runtime.{region}.amazonaws.com'

    def call(messages, **extra):
        return post(host, '/openai/v1/chat/completions', key,
                    {'model': model, 'messages': messages, 'max_tokens': 512,
                     'reasoning_effort': 'low', 'store': False, **extra})

    messages = [{'role': 'user', 'content': 'Call readiness_check with value 7.'}]
    result = call(messages, tools=[{'type': 'function', 'function': {'name': 'readiness_check',
        'description': 'Check readiness', 'parameters': {'type': 'object', 'properties': {'value': {'type': 'integer'}},
        'required': ['value'], 'additionalProperties': False}}}],
        tool_choice={'type': 'function', 'function': {'name': 'readiness_check'}})
    message = result['choices'][0]['message']
    tool = message['tool_calls'][0]
    assert tool['function']['name'] == 'readiness_check'
    assert json.loads(tool['function']['arguments']) == {'value': 7}
    messages += [message, {'role': 'tool', 'tool_call_id': tool['id'], 'content': 'Ready. Reply OK.'}]
    result = call(messages)
    assert 'OK' in result['choices'][0]['message']['content'] and result['usage']['total_tokens'] > 0

    # Exercise the exact regional Titan API used by search and long-term memory.
    assert region == 'ap-southeast-2', 'Titan embeddings are approved in Sydney'
    response = post(host, '/model/amazon.titan-embed-text-v2:0/invoke', key,
                    {'inputText': 'readiness check', 'dimensions': 1024, 'normalize': True})
    assert len(response['embedding']) == 1024
    if bootstrap:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key'
            path.write_text(key)
            path.chmod(0o600)
            aws('secretsmanager', 'put-secret-value', '--secret-id', 'circini/bedrock-api-key',
                '--secret-string', f'file://{path}')
    print(json.dumps({'bedrockPreflight': 'passed', 'model': model, 'region': region,
                      'toolRoundtrip': 'passed', 'titanEmbeddings': 'passed'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Provider errors and local variable values must not enter CI logs.
        raise SystemExit(f'Bedrock configuration failed ({type(error).__name__}); tasks were not replaced') from None
