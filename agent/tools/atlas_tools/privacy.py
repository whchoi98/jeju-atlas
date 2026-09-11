"""Content-free runtime telemetry; kept identical in the two independent CodeZips.

Native controls cover Bedrock messages and Strands content. AWS distro 0.19.0
MCP spans and SDK exception events bypass those controls. At the SDK 1.44
processor dispatch boundary, copy records to an operational-field allowlist
before ANY configured exporter (including unsampled exporters) receives them.
No exporter, sampler, metrics reader, dependency, or client payload is replaced.
"""
from __future__ import annotations

import logging
import math
import os
from collections.abc import Mapping

TOOLS = frozenset({"find_places", "place_detail", "route", "weather", "sun_times", "layer", "festivals", "plan_day"})
ATTRIBUTES = frozenset({
    "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.system",
    "gen_ai.request.model", "gen_ai.response.model", "gen_ai.response.finish_reasons",
    "gen_ai.agent.name", "gen_ai.tool.name", "gen_ai.tool.status",
    "gen_ai.event.start_time", "gen_ai.event.end_time",
    "gen_ai.server.time_to_first_token", "gen_ai.server.time_per_output_token",
    "gen_ai.client.operation.duration", "gen_ai.request.max_tokens",
    "aws.local.service", "aws.local.operation", "aws.local.environment",
    "aws.remote.service", "aws.remote.operation", "aws.span.kind", "aws.region",
    "aws.remote.resource.type", "aws.remote.resource.identifier",
    "cloud.platform", "cloud.region", "telemetry.extended", "PlatformType",
    "rpc.system", "rpc.service", "rpc.method", "rpc.response.status_code",
    "mcp.method.name", "mcp.protocol.version", "http.request.method",
    "http.response.status_code", "http.status_code", "server.address", "server.port",
    "error.type", "exception.type", "exception.escaped", "retry_attempts", "finish_reason",
    "code.file.path", "code.function.name", "code.line.number",
})
EVENTS = frozenset({
    "gen_ai.system.message", "gen_ai.user.message", "gen_ai.assistant.message",
    "gen_ai.tool.message", "gen_ai.choice", "gen_ai.client.inference.operation.details",
    "exception", "memory.query", "memory.content", "memory.result",
})
APP_LOGGERS = ("atlas_agent.", "atlas_tools.", "atlas.catalog", "mcp_client.")
SDK_LOGGERS = (
    "strands", "botocore", "boto3", "bedrock_agentcore", "mcp.", "httpx", "httpcore",
    "opentelemetry", "amazon.opentelemetry", "uvicorn", "asyncio", "concurrent.futures",
)
MARKER = "_atlas_privacy_guard"


def safe_tool_name(value) -> str:
    name = value if isinstance(value, str) else ""
    short = name.removeprefix("jejuatlastools_")
    return name if short in TOOLS else "unknown"


def _attributes(values) -> dict:
    result = {}
    for key, value in (values or {}).items():
        if key.startswith("gen_ai.usage.") or key.startswith("memory.") and key.endswith(".count"):
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                result[key] = value
        elif key in ATTRIBUTES:
            result[key] = safe_tool_name(value) if key == "gen_ai.tool.name" else value
    return result


def _span_name(name: str) -> str:
    for prefix in ("execute_tool ", "mcp tools/call "):
        if name.startswith(prefix):
            return prefix + safe_tool_name(name[len(prefix):])
    # Prompt/resource names in MCP are arbitrary request inputs.
    if name.startswith(("mcp prompts/", "mcp resources/")):
        return " ".join(name.split(" ", 2)[:2])
    return name


def protect_tracer_provider(provider) -> bool:
    processor = getattr(provider, "_active_span_processor", None)
    if processor is None:
        if "Proxy" in type(provider).__name__ or "NoOp" in type(provider).__name__:
            return False
        raise RuntimeError("Unsupported tracer provider for runtime privacy")
    original = processor.on_end
    if getattr(original, MARKER, False):
        return True
    from opentelemetry.sdk.trace import Event, ReadableSpan
    from opentelemetry.trace import Link, Status

    def on_end(span):
        clean = ReadableSpan(
            name=_span_name(span.name), context=span.context, parent=span.parent,
            resource=span.resource, kind=span.kind,
            attributes=_attributes(span.attributes),
            events=[Event(event.name if event.name in EVENTS else "sdk.event",
                          _attributes(event.attributes), event.timestamp) for event in span.events],
            links=[Link(link.context, _attributes(link.attributes)) for link in span.links],
            status=Status(span.status.status_code),  # Never export exception text in a status description.
            start_time=span.start_time, end_time=span.end_time,
            instrumentation_scope=span.instrumentation_scope,
        )
        return original(clean)

    setattr(on_end, MARKER, True)
    # SDK spans already created by auto-instrumentation retain this dispatcher,
    # so protect the dispatcher itself, not just newly obtained tracers.
    processor.on_end = on_end
    return True


def _event_body(value):
    if not isinstance(value, Mapping):
        return None
    result = {}
    for key, item in value.items():
        if key == "role" and item in ("system", "user", "assistant", "tool"):
            result[key] = item
        elif key == "name":
            result[key] = safe_tool_name(item)
        elif key == "finish_reason" and item in (
            "end_turn", "tool_use", "max_tokens", "stop_sequence", "stop", "length",
            "guardrail_intervened", "content_filtered", "error",
        ):
            result[key] = item
        elif key == "index" and isinstance(item, int) and 0 <= item <= 100:
            result[key] = item
        elif key in ("message", "function") and isinstance(item, Mapping):
            result[key] = _event_body(item)
        elif key == "tool_calls" and isinstance(item, (list, tuple)):
            result[key] = [_event_body(call) for call in item[:32]]
    return result or None


def protect_logger_provider(provider) -> bool:
    processor = getattr(provider, "_multi_log_record_processor", None)
    if processor is None:
        if "Proxy" in type(provider).__name__ or "NoOp" in type(provider).__name__:
            return False
        raise RuntimeError("Unsupported logger provider for runtime privacy")
    original = processor.on_emit
    if getattr(original, MARKER, False):
        return True
    from opentelemetry._logs import LogRecord
    from opentelemetry.sdk._logs import ReadWriteLogRecord

    def on_emit(data):
        record = data.log_record
        scope = getattr(data.instrumentation_scope, "name", "") or ""
        body = record.body if isinstance(record.body, str) and scope.startswith(APP_LOGGERS) else _event_body(record.body)
        clean = LogRecord(
            timestamp=record.timestamp, observed_timestamp=record.observed_timestamp,
            trace_id=record.trace_id, span_id=record.span_id, trace_flags=record.trace_flags,
            severity_text=record.severity_text, severity_number=record.severity_number,
            body=body, attributes=_attributes(record.attributes),
            event_name=record.event_name if record.event_name in EVENTS else None,
        )
        return original(ReadWriteLogRecord(clean, resource=data.resource,
                                          instrumentation_scope=data.instrumentation_scope, limits=data.limits))

    setattr(on_emit, MARKER, True)
    processor.on_emit = on_emit
    return True


def _protect_python_logging() -> None:
    original = logging.getLogRecordFactory()
    if getattr(original, MARKER, False):
        return

    def factory(*args, **kwargs):
        record = original(*args, **kwargs)
        if isinstance(record.msg, BaseException):
            record.msg = type(record.msg).__name__
        if isinstance(record.args, tuple):
            record.args = tuple(type(value).__name__ if isinstance(value, BaseException) else value for value in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: type(value).__name__ if isinstance(value, BaseException) else value
                           for key, value in record.args.items()}
        # SDK free-text diagnostics may contain request bodies, URLs with keys,
        # or str(exception). Their operational detail remains in safe spans.
        if record.name == "root" or record.name.startswith(SDK_LOGGERS):
            record.msg = "sdk_event logger=%s level=%s"
            record.args = (record.name, record.levelname)
            record.message = record.getMessage()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return record

    setattr(factory, MARKER, True)
    logging.setLogRecordFactory(factory)


def configure_privacy() -> None:
    os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "false"
    options = [part.strip() for part in os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN", "").split(",")
               if part.strip() and not part.strip().startswith("gen_ai_unredacted_attributes=")]
    os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"] = ",".join([*options, "gen_ai_unredacted_attributes="])
    _protect_python_logging()
    try:
        from opentelemetry.trace import get_tracer_provider
        from opentelemetry._logs import get_logger_provider
    except ImportError:
        # Tools' uninstrumented CodeZip intentionally has no telemetry SDK.
        return
    protect_tracer_provider(get_tracer_provider())
    protect_logger_provider(get_logger_provider())
