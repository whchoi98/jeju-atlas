"""Run with .local/atlas-guide-venv/bin/python; external boundaries are blocked."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
GUIDE = ROOT / "agent/guide"
sys.path.insert(0, str(GUIDE))

PLACE = {
    "id": "poi_0008", "name": "성산일출봉", "category": "관광지",
    "lat": 33.4581, "lng": 126.9425, "summary": "화산 지형",
    "source": "Ohmyjeju Curation", "observed_at": None,
}
QUESTION = "Plan a short family visit to Seongsan Ilchulbong and Gwangchigi Beach."


async def collect(events):
    return [event async for event in events]


class OfflineGuide(unittest.TestCase):
    def setUp(self):
        # Literal fake credentials only prevent credential-provider discovery.
        # Even an accidental SDK API call or socket connection fails the test.
        environment = patch.dict(os.environ, {
            "AWS_REGION": "ap-northeast-2", "AWS_DEFAULT_REGION": "ap-northeast-2",
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_ACCESS_KEY_ID": "atlas-test-only",
            "AWS_SECRET_ACCESS_KEY": "atlas-test-only-not-a-secret",
            "AWS_CONFIG_FILE": os.devnull, "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            "BOTO_CONFIG": os.devnull,
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        for target in ("socket.socket.connect", "botocore.client.BaseClient._make_api_call"):
            guard = patch(target, side_effect=AssertionError("External I/O is forbidden in source tests"))
            guard.start()
            self.addCleanup(guard.stop)
        original_factory = logging.getLogRecordFactory()
        self.addCleanup(logging.setLogRecordFactory, original_factory)

    def load_main(self):
        spec = importlib.util.spec_from_file_location("atlas_guide_fixture_main", GUIDE / "main.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_http_runtime_target_url_and_sigv4_prefix_are_atlas_owned(self):
        from mcp_client import client

        for value in ("https://gateway.example.test", "https://gateway.example.test/mcp",
                      "https://gateway.example.test/mcp/"):
            with self.subTest(value=value):
                os.environ["AGENTCORE_GATEWAY_JEJUATLASTOOLS_URL"] = value
                captured = {}

                def transport(url, **kwargs):
                    captured.update(url=url, **kwargs)
                    return "transport-fixture"

                with patch.object(client, "aws_iam_streamablehttp_client", side_effect=transport):
                    result = client.get_atlas_gateway_mcp_client()
                    self.assertEqual(result._prefix, "jejuatlastools")
                    self.assertEqual(result._transport_callable(), "transport-fixture")
                self.assertEqual(captured, {
                    "url": "https://gateway.example.test/JejuAtlasTools/invocations",
                    "aws_service": "bedrock-agentcore", "aws_region": "ap-northeast-2",
                })
        os.environ.pop("AGENTCORE_GATEWAY_JEJUATLASTOOLS_URL")
        os.environ["AGENTCORE_GATEWAY_OHMYJEJUTOOLS_URL"] = "https://unrelated.example.test"
        self.assertEqual(client.get_all_gateway_mcp_clients(), [])

    def test_warm_failure_releases_the_real_mcp_client_for_the_next_consumer(self):
        from mcp_client.client import warm_tools
        from strands.tools.mcp.mcp_client import MCPClient
        from strands.types.collections import PaginatedList

        client = MCPClient(lambda: None, prefix="jejuatlastools")
        with patch.object(client, "start") as start, patch.object(client, "list_tools_sync",
            side_effect=[RuntimeError("tool-list-private-sentinel"), PaginatedList([object()] * 8, token=None)]):
            self.assertEqual(warm_tools([client]), {})
            client.add_consumer("atlas-test-conversation")
            try:
                self.assertEqual(len(asyncio.run(client.load_tools())), 8)
                self.assertEqual(start.call_count, 2)
            finally:
                client.remove_consumer("atlas-test-conversation")

    def test_prefetch_calls_bare_tools_but_seeds_the_same_names_seen_by_the_model(self):
        from atlas_agent.prefetch import PrefetchCall, execute_prefetch
        from atlas_agent.streaming import seeded_messages

        client = SimpleNamespace(call_tool_async=AsyncMock(return_value={
            "status": "success", "content": [{"text": json.dumps({"items": [PLACE]}, ensure_ascii=False)}],
        }))
        calls = [PrefetchCall("find_places", {"query": "성산일출봉", "limit": 3})]
        results = asyncio.run(execute_prefetch(calls, client))
        client.call_tool_async.assert_awaited_once_with(
            tool_use_id="prefetch-1", name="find_places", arguments={"query": "성산일출봉", "limit": 3})
        messages = seeded_messages("성산일출봉을 알려 주세요.", results)
        self.assertEqual(messages[1]["content"][0]["toolUse"]["name"], "jejuatlastools_find_places")
        self.assertEqual(messages[2]["content"][0]["toolResult"]["toolUseId"], "prefetch-1")

    def test_new_tool_prefix_keeps_actual_tool_status_and_derived_markers(self):
        from atlas_agent.streaming import run_turn

        class FixtureAgent:
            async def stream_async(self, prompt, **kwargs):
                yield {"type": "tool_use_stream", "current_tool_use": {
                    "toolUseId": "atlas-tool-1", "name": "jejuatlastools_find_places",
                }}
                yield {"message": {"role": "user", "content": [{"toolResult": {
                    "toolUseId": "atlas-tool-1", "status": "success",
                    "content": [{"text": json.dumps({"items": [PLACE]}, ensure_ascii=False)}],
                }}]}}
                yield {"data": "성산일출봉의 자료를 안내합니다."}

        events = asyncio.run(collect(run_turn(FixtureAgent(), "성산일출봉을 알려 주세요.", mode="derive")))
        self.assertEqual(events[0], {"type": "status", "stage": "thinking"})
        self.assertIn({"type": "status", "stage": "tool", "tool": "find_places"}, events)
        result = next(event for event in events if event["type"] == "map")
        self.assertEqual(result["markers"][0]["id"], "poi_0008")
        self.assertEqual(result["markers"][0]["source"], "Ohmyjeju Curation")
        self.assertEqual(events[-1]["type"], "done")

    def test_tool_budget_still_cancels_duplicates_and_resets_between_turns(self):
        from atlas_agent.tool_budget import ToolBudget

        budget = ToolBudget(per_tool=3, total=12)
        first = SimpleNamespace(tool_use={"name": "jejuatlastools_find_places", "input": {"query": "성산"}}, cancel_tool=None)
        second = SimpleNamespace(tool_use={"name": "jejuatlastools_find_places", "input": {"query": "성산"}}, cancel_tool=None)
        budget.check(first)
        budget.check(second)
        self.assertIsNone(first.cancel_tool)
        self.assertIn("`find_places`", second.cancel_tool)
        self.assertNotIn("jejuatlastools_", second.cancel_tool)
        budget.reset()
        third = SimpleNamespace(tool_use=first.tool_use, cancel_tool=None)
        budget.check(third)
        self.assertIsNone(third.cancel_tool)

    def test_seoul_sol_astra_model_fields_and_planning_scope_remain_unchanged(self):
        from atlas_agent import routing
        from model import load

        self.assertEqual(routing.select_model_id(QUESTION), ("deep", "global.openai.gpt-6-astra"))
        self.assertEqual(routing.select_model_id("What are the visiting hours at Seongsan Ilchulbong?"),
                         ("fast", "global.openai.gpt-5.6-sol"))
        self.assertEqual(routing.classify("카페 추천\n\n[Service catalog reference data]\nplan a visit"), "fast")
        load._MODEL_CACHE.clear()
        self.addCleanup(load._MODEL_CACHE.clear)
        fast = load.load_model("global.openai.gpt-5.6-sol")
        deep = load.load_model("global.openai.gpt-6-astra", thinking="adaptive:medium")
        self.assertEqual(fast.get_config()["additional_request_fields"], {"reasoning": {"effort": "none"}})
        self.assertEqual(deep.get_config()["additional_request_fields"], {"reasoning": {"effort": "medium"}})
        self.assertEqual(load.BEDROCK_REGION, "ap-northeast-2")
        self.assertIs(load.load_model("global.openai.gpt-5.6-sol"), fast)
        self.assertNotIn("reasoning_effort", deep.get_config()["additional_request_fields"])
        self.assertNotIn("cache_config", fast.get_config())

    def test_memory_is_disabled_without_atlas_id_and_preserves_actor_namespaces_and_redaction(self):
        from memory import session

        os.environ["MEMORY_OHMYJEJUAGENTMEMORY_ID"] = "unrelated-memory"
        self.assertIsNone(session.get_memory_session_manager("conversation-1", "actor-1"))
        os.environ["ATLAS_MEMORY_ID"] = "atlas-test-memory"
        with patch.object(session, "KakaoRedactingSessionManager") as manager:
            session.get_memory_session_manager("conversation-1", "actor-1")
            config, region = manager.call_args.args
            self.assertEqual((config.memory_id, config.actor_id, config.session_id, region),
                             ("atlas-test-memory", "actor-1", "conversation-1", "ap-northeast-2"))
            self.assertIn("/summaries/actor-1/conversation-1", config.retrieval_config)
        original = {"role": "assistant", "content": [{"toolUse": {
            "name": "jejuatlastools_place_detail", "toolUseId": "tool-1", "input": {"id": "kakao:12345"},
        }}]}
        redacted = session.redact_kakao_message(original)
        self.assertEqual(redacted["content"][0]["toolUse"]["input"]["id"], "kakao:redacted")
        self.assertEqual(original["content"][0]["toolUse"]["input"]["id"], "kakao:12345")

    def test_packaged_entrypoint_starts_without_external_config_and_rejects_bad_payload_as_sse(self):
        main = self.load_main()
        self.assertEqual(main.tools, [])
        self.assertEqual(main.WARM, {})
        self.assertIn("제주 아틀라스(Jeju Atlas)", main.SYSTEM_PROMPT)
        self.assertIn("Ohmyjeju Curation", main.SYSTEM_PROMPT)
        self.assertEqual(main.MODEL_FAST, "global.openai.gpt-5.6-sol")
        self.assertEqual(main.MODEL_DEEP, "global.openai.gpt-6-astra")

        async def invoke_bad():
            response = await main.invoke({"prompt": {"private-sentinel": "bad"}, "stream": True}, None)
            return await collect(response)

        events = asyncio.run(invoke_bad())
        self.assertEqual([event["type"] for event in events], ["error", "map", "done"])
        self.assertEqual(events[0]["code"], "bad_request")
        self.assertNotIn("private-sentinel", json.dumps(events))

    def test_stream_failure_finishes_with_safe_error_map_done(self):
        from atlas_agent.streaming import run_turn

        class BrokenAgent:
            async def stream_async(self, prompt, **kwargs):
                raise RuntimeError("question-cookie-token-private-sentinel")
                yield {}

        events = asyncio.run(collect(run_turn(BrokenAgent(), "fixture-only", mode="derive")))
        self.assertEqual([event["type"] for event in events], ["status", "error", "map", "done"])
        self.assertNotIn("question-cookie-token-private-sentinel", json.dumps(events))


if __name__ == "__main__":
    unittest.main()
