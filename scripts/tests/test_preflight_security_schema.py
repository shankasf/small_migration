"""The full additive schema must fit ECS overrides without omitting statements."""
import base64
import gzip
import json
import re
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch


class SchemaPreflightTest(unittest.TestCase):
    def test_all_sql_survives_compression_and_fits_ecs(self):
        overrides = []

        def aws(command, **kwargs):
            operation = command[2]
            if operation == 'list-task-definitions':
                result = {'taskDefinitionArns': ['schema-task']}
            elif operation == 'list-exports':
                result = {'Exports': [{'Name': 'circini-AppSubnets', 'Value': 'subnet-a,subnet-b'},
                                      {'Name': 'circini-SgApp', 'Value': 'sg-app'}]}
            elif operation == 'run-task':
                overrides.append(command[command.index('--overrides') + 1])
                result = {'tasks': [{'taskArn': 'verification-task'}]}
            elif operation == 'describe-tasks':
                result = {'tasks': [{'containers': [{'name': 'schema-sync', 'exitCode': 0}]}]}
            else:
                self.fail('Unexpected AWS operation: ' + operation)
            return json.dumps(result)

        with patch('subprocess.check_output', side_effect=aws), patch('subprocess.run'):
            runpy.run_path('scripts/preflight-security-schema.py', run_name='__main__')
        self.assertEqual(len(overrides), 1)
        self.assertLessEqual(len(overrides[0].encode()), 8192)
        command = json.loads(overrides[0])['containerOverrides'][0]['command'][2]
        encoded = re.search(r"Buffer.from\('([^']+)','base64'\)", command).group(1)
        source = gzip.decompress(base64.b64decode(encoded)).decode()
        for filename in ('file-library', 'chat-search', 'titan-embeddings', 'message-feedback'):
            for statement in Path(f'services/backend/prisma/sql/{filename}.sql').read_text().split(';'):
                if statement.strip():
                    self.assertIn(json.dumps(statement.strip()), source)
        self.assertIn('tokensValidAfter', source)
        self.assertIn('impactState', source)
