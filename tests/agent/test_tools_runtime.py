"""Run with the Tools CodeZip's own venv; all AWS and external sockets are blocked."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "agent/tools"
sys.path.insert(0, str(TOOLS))


class ToolsRuntime(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="atlas-tools-test-")
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, {
            "AWS_REGION": "ap-northeast-2", "AWS_EC2_METADATA_DISABLED": "true",
            "ATLAS_CATALOG_CACHE_DIR": temp.name,
            "AWS_CONFIG_FILE": os.devnull, "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            "BOTO_CONFIG": os.devnull,
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)
        original_factory = logging.getLogRecordFactory()
        self.addCleanup(logging.setLogRecordFactory, original_factory)
        for target in ("socket.socket.connect", "botocore.client.BaseClient._make_api_call"):
            block = patch(target, side_effect=AssertionError("External I/O is forbidden in source tests"))
            block.start()
            self.addCleanup(block.stop)
        import catalog
        from atlas_tools import catalog_client
        from atlas_tools.external import keys
        catalog_client.reset_backend()
        keys.reset_cache()
        catalog._last_check = 0
        catalog._current = None
        self.addCleanup(lambda: catalog._current.close() if catalog._current else None)

    def load_main(self):
        spec = importlib.util.spec_from_file_location("atlas_tools_fixture_main", TOOLS / "main.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_actual_fastmcp_registers_eight_tools_with_structured_output(self):
        main = self.load_main()
        tools = asyncio.run(main.mcp.list_tools())
        self.assertEqual({tool.name for tool in tools}, {
            "find_places", "place_detail", "route", "weather", "sun_times", "layer", "festivals", "plan_day",
        })
        self.assertTrue(all(tool.outputSchema for tool in tools))
        result = asyncio.run(main.mcp.call_tool("find_places", {"query": "성산일출봉", "limit": 3}))
        self.assertIsInstance(result, tuple, "mcp 1.24 must preserve structured tool results")
        content, structured = result
        self.assertTrue(content)
        self.assertEqual(structured["items"][0]["id"], "poi_0008")
        self.assertEqual(structured["items"][0]["name"], "성산일출봉")
        self.assertIn("오마이제주", structured["items"][0]["source"])

    def test_packaged_place_detail_preserves_real_source_and_missing_official_fields(self):
        main = self.load_main()
        detail = main.place_detail("poi_0008")
        self.assertEqual(detail["id"], "poi_0008")
        self.assertEqual(detail["name"], "성산일출봉")
        self.assertIn("오마이제주", detail["source"])
        self.assertNotIn("official_details", detail)
        self.assertNotIn("verified", json.dumps(detail).lower())

    def test_missing_provider_keys_do_not_trigger_ssm_or_fabricate_a_road_route(self):
        from atlas_tools import routing
        from atlas_tools.external import keys

        self.assertIsNone(keys.get_key("KAKAO_REST_API_KEY"))
        result = routing.route([{"lat": 33.45, "lng": 126.55}, {"lat": 33.46, "lng": 126.56}], "car")
        self.assertTrue(result["fallback"])
        self.assertEqual(result["mode"], "straight")
        self.assertIn(result["provider"], ("straight", "haversine"))
        self.assertNotIn("/ohmyjeju/", json.dumps(result))
        self.assertNotIn("agentcore/.env", keys.missing_key_response("kakao")["how_to"])


if __name__ == "__main__":
    unittest.main()
