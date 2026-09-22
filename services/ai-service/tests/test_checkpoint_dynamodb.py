"""The production checkpointer (DynamoDB + S3 offload) against moto's AWS mocks.

The table and bucket are created exactly as deploy/aws/app.yaml defines them,
so a schema drift between the stack and the saver fails here first.
"""
import asyncio

import boto3
import pytest
from moto import mock_aws

from config import settings
from fakes import call
from test_turn_graph import Harness, route
from workflow.checkpointing import create_checkpointer
from workflow.orchestrator import build_turn_graph

TABLE, BUCKET, REGION = "circini-agent-checkpoints", "circini-agent-checkpoints-test", "ap-southeast-2"


@pytest.fixture
def dynamodb_checkpointer(monkeypatch):
    with mock_aws():
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
        boto3.client("dynamodb", region_name=REGION).create_table(
            TableName=TABLE, BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                                  {"AttributeName": "SK", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])
        boto3.client("s3", region_name=REGION).create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        for name, value in {"CHECKPOINT_BACKEND": "dynamodb", "CHECKPOINT_TABLE": TABLE,
                            "CHECKPOINT_BUCKET": BUCKET, "AWS_REGION": REGION}.items():
            monkeypatch.setattr(settings, name, value)
        yield create_checkpointer()


def test_a_paused_question_survives_in_dynamodb_and_resumes(dynamodb_checkpointer):
    harness = Harness()
    harness.checkpointer = dynamodb_checkpointer
    harness.runner.graph = build_turn_graph(dynamodb_checkpointer)
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", call("submit_migration_spec", ready=False, findings="", targets=[],
                                          questions=["Which base model?"], requirements=""))
    assert harness.turn("Generate stg_contracts").paused

    items = boto3.client("dynamodb", region_name=REGION).scan(TableName=TABLE)["Items"]
    assert items and all("ttl" in item for item in items)  # DynamoDB TTL expires every checkpoint

    harness.models.script("router", route("generate"))
    harness.models.script("analyst", call("submit_migration_spec", ready=True, findings="", questions=[],
                                          targets=[{"file_name": "stg_contracts.sql", "purpose": "staging"}],
                                          requirements="contract_id"))
    harness.models.script("author", "```sql\nselect contract_id from {{ ref('in_scope_contracts') }}\n```")
    harness.models.script("reviewer", call("ModelReview", approved=True, issues=[]))
    result = harness.turn("Use in_scope_contracts")
    assert not result.paused and list(result.files) == ["stg_contracts.sql"]

    asyncio.run(harness.runner.forget("chat-1"))
    assert not harness.state()
