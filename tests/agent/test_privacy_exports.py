"""Exercise actual OpenTelemetry exporters for both independently packaged guards."""
from __future__ import annotations

import importlib.util
import json
import logging
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SENTINEL = "atlas-private-question-answer-cookie-tool-argument-sentinel"


def privacy_module(component):
    package = "atlas_agent" if component == "guide" else "atlas_tools"
    spec = importlib.util.spec_from_file_location(
        f"atlas_{component}_privacy_fixture", ROOT / "agent" / component / package / "privacy.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PrivacyExports(unittest.TestCase):
    def setUp(self):
        original = logging.getLogRecordFactory()
        self.addCleanup(logging.setLogRecordFactory, original)
        environ = patch.dict(os.environ, {}, clear=True)
        environ.start()
        self.addCleanup(environ.stop)
        guard = patch("socket.socket.connect", side_effect=AssertionError("Network exporters are forbidden"))
        guard.start()
        self.addCleanup(guard.stop)

    def test_span_export_removes_content_and_retains_tool_usage_status_and_timing(self):
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
        from opentelemetry.trace import Status, StatusCode

        for component in ("guide", "tools"):
            with self.subTest(component=component):
                privacy = privacy_module(component)
                exporter = InMemorySpanExporter()
                provider = TracerProvider()
                provider.add_span_processor(SimpleSpanProcessor(exporter))
                self.addCleanup(provider.shutdown)
                privacy.protect_tracer_provider(provider)
                privacy.protect_tracer_provider(provider)  # Idempotent after runtime initialization.
                with provider.get_tracer("aws.runtime.fixture").start_as_current_span(
                    "execute_tool jejuatlastools_find_places", attributes={
                        "gen_ai.tool.name": "jejuatlastools_find_places",
                        "gen_ai.usage.input_tokens": 42, "gen_ai.usage.output_tokens": 9,
                        "gen_ai.input.messages": SENTINEL, "gen_ai.output.messages": SENTINEL,
                        "gen_ai.tool.call.arguments": SENTINEL, "http.request.header.cookie": SENTINEL,
                    },
                ) as span:
                    span.add_event("gen_ai.user.message", {"content": SENTINEL, "gen_ai.tool.name": "find_places"})
                    span.record_exception(RuntimeError(SENTINEL))
                    span.set_status(Status(StatusCode.ERROR, SENTINEL))
                exported = exporter.get_finished_spans()[0]
                self.assertNotIn(SENTINEL, exported.to_json())
                self.assertEqual(exported.name, "execute_tool jejuatlastools_find_places")
                self.assertEqual(exported.attributes["gen_ai.tool.name"], "jejuatlastools_find_places")
                self.assertEqual(exported.attributes["gen_ai.usage.input_tokens"], 42)
                self.assertEqual(exported.attributes["gen_ai.usage.output_tokens"], 9)
                self.assertEqual(exported.status.status_code, StatusCode.ERROR)
                self.assertGreaterEqual(exported.end_time, exported.start_time)

    def test_log_export_removes_message_bodies_arguments_and_exception_text(self):
        from opentelemetry._logs import LogRecord
        from opentelemetry.sdk._logs import LoggerProvider
        from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor, InMemoryLogRecordExporter

        for component in ("guide", "tools"):
            with self.subTest(component=component):
                provider = LoggerProvider()
                exporter = InMemoryLogRecordExporter()
                provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
                self.addCleanup(provider.shutdown)
                privacy = privacy_module(component)
                privacy.protect_logger_provider(provider)
                logger = provider.get_logger("amazon.opentelemetry.genai.fixture")
                logger.emit(LogRecord(body={
                    "role": "assistant", "content": SENTINEL,
                    "message": {"content": SENTINEL, "tool_calls": [{
                        "function": {"name": "jejuatlastools_place_detail", "arguments": SENTINEL},
                    }]},
                }, attributes={"exception.message": SENTINEL, "gen_ai.usage.output_tokens": 9},
                    event_name="gen_ai.assistant.message"))
                record = exporter.get_finished_logs()[0].log_record
                self.assertNotIn(SENTINEL, json.dumps({"body": record.body, "attributes": dict(record.attributes)}))
                self.assertEqual(record.body["role"], "assistant")
                self.assertEqual(record.body["message"]["tool_calls"][0]["function"]["name"], "jejuatlastools_place_detail")
                self.assertEqual(record.attributes["gen_ai.usage.output_tokens"], 9)
                provider.get_logger("atlas.catalog").emit(LogRecord(body="catalog ready count=137"))
                self.assertEqual(exporter.get_finished_logs()[-1].log_record.body, "catalog ready count=137")

    def test_configured_python_logging_keeps_safe_diagnostics_without_raw_exceptions(self):
        privacy = privacy_module("guide")
        privacy.configure_privacy()
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        handler = Capture()
        logger = logging.getLogger("atlas.catalog")
        before = logger.level
        logger.setLevel(logging.WARNING)
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        self.addCleanup(logger.setLevel, before)
        try:
            raise RuntimeError(SENTINEL)
        except RuntimeError as error:
            logger.warning("catalog refresh failed type=%s", error, exc_info=True)
        self.assertNotIn(SENTINEL, " ".join(records))
        self.assertIn("RuntimeError", records[0])
        self.assertEqual(os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"], "false")
        self.assertIn("gen_ai_unredacted_attributes=", os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"])


if __name__ == "__main__":
    unittest.main()
