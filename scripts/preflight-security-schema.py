#!/usr/bin/env python3
"""Add backward-compatible columns using the existing schema task BEFORE new app tasks start."""
import json
from pathlib import Path
import subprocess


def aws(*args):
    return json.loads(subprocess.check_output(['aws', *args, '--output', 'json'], text=True))

existing = aws('ecs', 'list-task-definitions', '--family-prefix', 'circini-schema-sync', '--sort', 'DESC', '--max-items', '1')
if not existing.get('taskDefinitionArns'):
    print('First deployment: schema-sync will initialise the database after stack creation')
    raise SystemExit(0)
exports = {e['Name']: e['Value'] for e in aws('cloudformation', 'list-exports')['Exports']}
sql = [
    'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokensValidAfter" TIMESTAMP(3)',
    'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "roleManagedLocally" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "GeneratedOutput" ADD COLUMN IF NOT EXISTS "validation" JSONB',
]
# Versioned additive DDL is checked in with the release; no user-supplied SQL.
sql.append('CREATE EXTENSION IF NOT EXISTS vector')
sql.extend(statement.strip() for statement in Path('services/backend/prisma/sql/file-library.sql').read_text().split(';') if statement.strip())
# Fixed statements only; no user input is interpolated into SQL or shell code.
script = "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{for(const q of " + json.dumps(sql) + ") await p.$executeRawUnsafe(q)})().catch(()=>{console.error('Additive schema preflight failed');process.exitCode=1}).finally(()=>p.$disconnect())"
network = {'awsvpcConfiguration': {'subnets': exports['circini-AppSubnets'].split(','), 'securityGroups':[exports['circini-SgApp']], 'assignPublicIp':'DISABLED'}}
override = {'containerOverrides': [{'name':'schema-sync', 'command':['node','-e',script]}]}
result = aws('ecs','run-task','--cluster','circini-demo','--launch-type','FARGATE','--task-definition',existing['taskDefinitionArns'][0], '--network-configuration',json.dumps(network), '--overrides',json.dumps(override))
if result.get('failures') or not result.get('tasks'):
    raise RuntimeError('Could not start additive schema preflight')
arn = result['tasks'][0]['taskArn']
subprocess.run(['aws','ecs','wait','tasks-stopped','--cluster','circini-demo','--tasks',arn], check=True)
task = aws('ecs','describe-tasks','--cluster','circini-demo','--tasks',arn)['tasks'][0]
container = next(c for c in task['containers'] if c['name']=='schema-sync')
if container.get('exitCode') != 0:
    raise RuntimeError('Additive schema preflight did not pass')
print('Additive security schema preflight passed')
