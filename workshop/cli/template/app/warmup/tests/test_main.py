"""Run from app/warmup: uv run --frozen python -m unittest discover -s tests -v."""

import io
import logging
import socket
import unittest
from unittest.mock import patch

from main import invoke, logger


class WarmupTests(unittest.TestCase):
    def test_same_prompt_returns_same_response_without_network(self):
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")):
            first = invoke({"prompt": "제주에서 CLI 연결 확인"})
            second = invoke({"prompt": "제주에서 CLI 연결 확인"})
        self.assertEqual(first, second)
        self.assertEqual(first["echo"], "제주에서 CLI 연결 확인")
        self.assertEqual(first["mode"], "deterministic")
        self.assertIs(first["modelInvoked"], False)

    def test_application_logs_only_metadata(self):
        prompt = "PROMPT_CONTENT_MUST_NOT_APPEAR_IN_LOGS"
        captured = io.StringIO()
        handler = logging.StreamHandler(captured)
        logger.addHandler(handler)
        try:
            invoke({"prompt": prompt})
        finally:
            logger.removeHandler(handler)
        self.assertNotIn(prompt, captured.getvalue())
        self.assertIn("warmup_complete", captured.getvalue())

    def test_invalid_payloads_are_bounded_errors(self):
        for payload in (None, [], {}, {"prompt": 42}, {"prompt": "x" * 513}):
            with self.subTest(payload_type=type(payload).__name__):
                response = invoke(payload)
                self.assertEqual(response["error"], "invalid_prompt")
                self.assertIs(response["modelInvoked"], False)
                self.assertNotIn("echo", response)


if __name__ == "__main__":
    unittest.main()
