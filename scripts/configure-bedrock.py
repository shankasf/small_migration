#!/usr/bin/env python3
"""Validate the candidate Bedrock key before storing it; never print credentials."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))


def main():
    region = os.environ.get('BEDROCK_REGION', 'ap-southeast-2')
    model = os.environ.get('BEDROCK_MODEL', 'openai.gpt-oss-120b-1:0')
    assert re.fullmatch(r'[a-z]{2}-[a-z]+-\d', region), 'Invalid Bedrock region'
    assert model == 'openai.gpt-oss-120b-1:0', 'Unvalidated Bedrock model'
    bootstrap = os.environ.get('BEDROCK_BOOTSTRAP_KEY', '').strip()
    key = bootstrap or aws('secretsmanager', 'get-secret-value', '--secret-id', 'circini/bedrock-api-key')['SecretString']
    assert key.startswith('ABSK') and '\n' not in key, 'Bedrock bearer key is missing or invalid'
    url = f'https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions'

    def call(messages, **extra):
        body = json.dumps({'model': model, 'messages': messages, 'max_tokens': 512,
                           'reasoning_effort': 'low', 'store': False, **extra}).encode()
        request = urllib.request.Request(url, data=body,
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)

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

    # Keep the existing embedding space: do not replace its OpenAI credential.
    embedding_key = aws('secretsmanager', 'get-secret-value', '--secret-id', 'circini/openai-api-key')['SecretString']
    request = urllib.request.Request('https://api.openai.com/v1/embeddings',
        data=json.dumps({'model': 'text-embedding-3-small', 'input': ['readiness check'], 'dimensions': 1536}).encode(),
        headers={'Authorization': 'Bearer ' + embedding_key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=45) as response:
        assert len(json.load(response)['data'][0]['embedding']) == 1536
    if bootstrap:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key'
            path.write_text(key)
            path.chmod(0o600)
            aws('secretsmanager', 'put-secret-value', '--secret-id', 'circini/bedrock-api-key',
                '--secret-string', f'file://{path}')
    print(json.dumps({'bedrockPreflight': 'passed', 'model': model, 'region': region,
                      'toolRoundtrip': 'passed', 'existingEmbeddings': 'passed'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Provider errors and local variable values must not enter CI logs.
        raise SystemExit(f'Bedrock configuration failed ({type(error).__name__}); tasks were not replaced') from None
