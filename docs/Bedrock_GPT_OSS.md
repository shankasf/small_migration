# Bedrock GPT-OSS 120B

Chat supports `LLM_PROVIDER=bedrock` with `BEDROCK_MODEL=openai.gpt-oss-120b-1:0`.
Set `BEDROCK_REGION` and `PROCESSING_REGION` to `ap-southeast-2`, and
`APPROVED_LLM_HOST=bedrock-runtime.ap-southeast-2.amazonaws.com`.
The service uses the regional `/openai/v1/chat/completions` endpoint.

The Bedrock key is a separate Secrets Manager record, `circini/bedrock-api-key`,
injected by ECS as `AWS_BEARER_TOKEN_BEDROCK`. To bootstrap or rotate it, load
the local key file into the temporary GitHub Actions secret
`CIRCINI_BEDROCK_BOOTSTRAP_KEY` through stdin. The deployment checks inference,
tool calls and the existing embedding service before storing the candidate key
and replacing tasks. Remove that temporary Actions secret after a successful
release. Never put the credential into workflow inputs, repository files or logs.

GPT-OSS is text-only. File-search vectors continue to use the existing
`text-embedding-3-small` model and OpenAI credential, explicitly configured with
`EMBEDDING_PROVIDER=openai` and `APPROVED_EMBEDDING_HOST=api.openai.com`.
This preserves compatibility with saved vectors; it is not an all-Bedrock data
boundary. Existing guardrails, disabled tracing, PHI and voice restrictions remain.

Live SDK checks found two differences from OpenAI: `<reasoning>` can arrive in
message content, and `response_format` does not reliably constrain typed output.
The adapter strips reasoning incrementally, requests streaming token usage,
and supplies a final-result function for typed router/specialist outputs. The
Agents SDK still validates the returned JSON with the original Pydantic schemas.
Structured agents use non-streaming `Runner.run`; the main chat supports streaming.

The release gates include CI, image scans, Bedrock inference preflight, ECS
stability, semantic file search, and authenticated impact-analysis checks with
the expected provider/model and nonzero token usage.

To restore OpenAI chat, set `LLM_PROVIDER=openai`,
`APPROVED_LLM_HOST=api.openai.com`, `PROCESSING_REGION=unverified`, and redeploy.
The prior OpenAI key/model configuration is retained.

References checked 2026-09-22:

- [AWS Chat Completions API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)
- [AWS GPT-OSS 120B model](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html)
- [AWS OpenAI model parameters](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html)
- [OpenAI GPT-OSS 120B](https://developers.openai.com/api/docs/models/gpt-oss-120b)
- [AWS pricing](https://aws.amazon.com/bedrock/pricing/) (Sydney standard tier: $0.1545 input / $0.6180 output per million tokens.)
