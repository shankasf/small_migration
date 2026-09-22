"""
OpenTelemetry setup for the AI service (architecture doc §10) — Deep's item 3.

Traces/metrics use gen_ai.* semantic conventions so the client's monitoring
platform can consume AI-governance signals without bespoke integration.
Export destination is config-led: OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is
set, otherwise spans are recorded in-process only.
"""

from typing import Optional

from config import settings

_tracer = None
_guardrail_counter = None
_token_counter = None


def init_telemetry(app=None) -> None:
    """Initialise the tracer/meter providers and FastAPI instrumentation."""
    global _tracer, _guardrail_counter, _token_counter
    if not settings.OTEL_ENABLED:
        return
    try:
        from opentelemetry import trace, metrics
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

        resource = Resource.create({"service.name": settings.OTEL_SERVICE_NAME})

        tracer_provider = TracerProvider(resource=resource)
        readers = []
        if settings.OTEL_EXPORTER_OTLP_ENDPOINT:
            endpoint = settings.OTEL_EXPORTER_OTLP_ENDPOINT.rstrip("/")
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

            tracer_provider.add_span_processor(
                BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
            )
            readers.append(
                PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics"))
            )

        trace.set_tracer_provider(tracer_provider)
        metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=readers))

        _tracer = trace.get_tracer("circini-ai-service")
        meter = metrics.get_meter("circini-ai-service")
        _guardrail_counter = meter.create_counter(
            "circini.guardrail.decisions",
            description="Guardrail decisions by outcome",
        )
        _token_counter = meter.create_counter(
            "gen_ai.client.token.usage",
            description="LLM tokens consumed",
        )

        if app is not None:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app, tracer_provider=tracer_provider)

        print(
            f"[OTEL] Started (service={settings.OTEL_SERVICE_NAME}, "
            f"exporter={settings.OTEL_EXPORTER_OTLP_ENDPOINT or 'none'})"
        )
    except Exception as exc:  # telemetry must never take the service down
        print(f"[OTEL] Initialisation failed: {exc}")


def get_tracer():
    return _tracer


def record_guardrail_decision(decision: str, stage: str) -> None:
    if _guardrail_counter is not None:
        _guardrail_counter.add(1, {"decision": decision, "stage": stage})


def record_token_usage(model: str, input_tokens: int, output_tokens: int) -> None:
    if _token_counter is not None:
        _token_counter.add(input_tokens, {"gen_ai.request.model": model, "gen_ai.token.type": "input"})
        _token_counter.add(output_tokens, {"gen_ai.request.model": model, "gen_ai.token.type": "output"})


def annotate_genai_span(span, *, model: str, provider: str,
                        input_tokens: Optional[int], output_tokens: Optional[int],
                        guardrail_decision: str, data_class: str) -> None:
    """Stamp gen_ai.* + governance attributes on the chat span."""
    if span is None:
        return
    span.set_attribute("gen_ai.operation.name", "chat")
    span.set_attribute("gen_ai.system", {"azure": "azure.ai.openai", "bedrock": "aws.bedrock"}.get(provider, "openai"))
    span.set_attribute("gen_ai.request.model", model)
    if input_tokens is not None:
        span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
    if output_tokens is not None:
        span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
    span.set_attribute("circini.guardrail.decision", guardrail_decision)
    span.set_attribute("circini.data_class", data_class)
