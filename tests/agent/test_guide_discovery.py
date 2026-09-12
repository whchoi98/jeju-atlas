"""Offline contract tests for BFF-provided native Guide grounding."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

GUIDE = Path(__file__).resolve().parents[2] / "agent/guide"
sys.path.insert(0, str(GUIDE))


def grounding():
    return {
        "version": 1, "kind": "search", "status": "ready", "source": "Kakao Local",
        "category": "카페", "query": "", "anchor": None,
        "queried_at": "2026-09-12T10:00:00.000Z", "message": "Use these current results.",
        "items": [{
            "id": "kakao:12345", "name": "현재 카페", "category": "카페",
            "lat": 33.45, "lng": 126.55, "source": "Kakao Local",
            "observed_at": "2026-09-12T10:00:00.000Z",
            "address": "테스트로 1", "phone": "064-000-0000", "url": "https://place.map.kakao.com/12345",
            "details": {"id": "kakao:12345", "name": "현재 카페",
                        "facilities": {"parking": "yes"}, "hours_week": [], "sources": []},
        }],
    }


async def collect(source):
    return [event async for event in source]


class GuideDiscoveryTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {
            "AWS_REGION": "ap-northeast-2", "AWS_DEFAULT_REGION": "ap-northeast-2",
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_ACCESS_KEY_ID": "atlas-test-only",
            "AWS_SECRET_ACCESS_KEY": "atlas-test-only-not-a-secret",
            "AWS_CONFIG_FILE": os.devnull, "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            "BOTO_CONFIG": os.devnull,
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("socket.socket.connect", "botocore.client.BaseClient._make_api_call"):
            boundary = patch(name, side_effect=AssertionError("External I/O is forbidden"))
            boundary.start()
            self.addCleanup(boundary.stop)
        factory = logging.getLogRecordFactory()
        self.addCleanup(logging.setLogRecordFactory, factory)

    def load_main(self):
        spec = importlib.util.spec_from_file_location("atlas_discovery_fixture_main", GUIDE / "main.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_payload_preserves_the_question_and_validates_separate_bounded_grounding(self):
        from atlas_agent.payload import parse_payload
        raw = grounding()
        parsed = parse_payload({"prompt": "카페 추천", "grounding": raw})
        self.assertEqual(parsed.prompt, "카페 추천")
        self.assertEqual(getattr(parsed, "grounding", None), raw)
        self.assertEqual(len(parsed.grounding["items"]), 1)
        raw["items"][0]["name"] = "mutated after parsing"
        self.assertNotEqual(parsed.grounding["items"][0]["name"], raw["items"][0]["name"])

    def test_payload_rejects_tokens_forged_native_records_and_oversized_context(self):
        from atlas_agent.payload import parse_payload
        changes = [
            lambda value: value.update(selection_token="never-forward-this-proof"),
            lambda value: value["items"][0].update(selection_token="never-forward-this-proof"),
            lambda value: value["items"][0]["details"].update(token="never-forward-this-proof"),
            lambda value: value["items"][0].update(id="legacy-place"),
            lambda value: value["items"][0].update(lat=35),
            lambda value: value["items"][0].update(url="https://other.example/12345"),
            lambda value: value["items"][0]["details"].update(base_note="x" * 20_000),
            lambda value: value.update(items=value["items"] * 4),
            lambda value: value.update(kind={}),
            lambda value: value.update(status=[]),
        ]
        for change in changes:
            raw = grounding()
            change(raw)
            with self.subTest(change=change), self.assertRaises(ValueError):
                parse_payload({"prompt": "카페 추천", "grounding": raw})

    def test_service_results_seed_model_context_and_derived_markers_without_gateway_calls(self):
        from atlas_agent import prefetch
        from atlas_agent.streaming import run_turn
        self.assertTrue(callable(getattr(prefetch, "grounding_prefetch", None)))
        captured = []

        class Agent:
            async def stream_async(self, prompt, **kwargs):
                captured.append(prompt)
                yield {"data": "현재 카페를 소개합니다."}

        raw = grounding()
        raw["anchor"] = {"id": "kakao:999", "name": "선택 카페", "lat": 33.4, "lng": 126.5}
        prefetched = prefetch.grounding_prefetch(raw)
        events = asyncio.run(collect(run_turn(Agent(), "여기 근처 카페", prefetched=prefetched)))
        self.assertIsInstance(captured[0], list)
        tool_result = captured[0][-1]["content"][0]["toolResult"]
        self.assertEqual(json.loads(tool_result["content"][0]["text"])["items"][0]["id"], "kakao:12345")
        result = next(event for event in events if event["type"] == "map")
        self.assertEqual(result["markers"][0]["id"], "kakao:12345")
        self.assertEqual(result["markers"][0]["source"], "Kakao Local")

    def test_covered_commercial_tools_are_blocked_but_nature_weather_and_planning_remain(self):
        from atlas_agent import prefetch
        self.assertTrue(hasattr(prefetch, "GuideGroundingPolicy"))
        policy = prefetch.GuideGroundingPolicy()
        policy.grounding = grounding()
        for tool, arguments, blocked in [
            ("find_places", {"query": "카페", "category": "카페"}, True),
            ("find_places", {"query": "현재 카페"}, True),
            ("place_detail", {"id": "kakao:12345"}, True),
            ("find_places", {"query": "해변", "category": "해변"}, False),
            ("find_places", {"query": "한라산국립공원"}, False),
            ("weather", {"near": "한라산"}, False),
            ("plan_day", {"stops": []}, False),
        ]:
            event = SimpleNamespace(tool_use={"name": f"jejuatlastools_{tool}", "input": arguments}, cancel_tool=None)
            policy.check(event)
            self.assertEqual(bool(event.cancel_tool), blocked, (tool, arguments))
        policy.grounding = None
        event = SimpleNamespace(tool_use={"name": "jejuatlastools_find_places", "input": {"query": "카페"}}, cancel_tool=None)
        policy.check(event)
        self.assertIsNone(event.cancel_tool)

    def test_failed_native_search_is_seeded_as_unavailable_without_legacy_retry(self):
        from atlas_agent import prefetch
        self.assertTrue(callable(getattr(prefetch, "grounding_prefetch", None)))
        raw = grounding()
        raw.update(status="unavailable", items=[], queried_at=None)
        seeded = prefetch.grounding_prefetch(raw)
        self.assertEqual(len(seeded), 1)
        self.assertTrue(prefetch.seedable(seeded[0], "카페 추천")[0])
        result = json.loads(seeded[0].text)
        self.assertEqual(result["items"], [])
        self.assertTrue(result["fallback"])

    def test_transient_lookup_redaction_preserves_user_preferences_and_omits_native_blobs(self):
        from memory import session
        self.assertTrue(callable(getattr(session, "redact_transient_lookup_message", None)))
        user = {"role": "user", "content": [{"text": "해산물 알레르기가 있어요. 카페 추천"}]}
        self.assertEqual(session.redact_transient_lookup_message(user), user)
        source = {"role": "user", "content": [{"toolResult": {
            "toolUseId": "atlas-native-1", "status": "success",
            "content": [{"text": json.dumps(grounding(), ensure_ascii=False)}],
        }}]}
        saved = session.redact_transient_lookup_message(source)
        self.assertNotIn("12345", json.dumps(saved))
        self.assertNotIn("126.55", json.dumps(saved))
        self.assertNotIn("현재 카페", json.dumps(saved, ensure_ascii=False))
        self.assertIn("12345", json.dumps(source))
        assistant = {"role": "assistant", "content": [{"text": "현재 카페 064-000-0000"},
            {"toolUse": {"toolUseId": "route-1", "name": "route", "input": {"stops": grounding()["items"]}}}]}
        saved = session.redact_transient_lookup_message(assistant)
        self.assertNotIn("064-000", json.dumps(saved))
        self.assertNotIn("12345", json.dumps(saved))

    def test_memory_write_funnel_omits_grounded_turn_content(self):
        from memory import session
        manager = session.KakaoRedactingSessionManager.__new__(session.KakaoRedactingSessionManager)
        manager.omit_lookup_content = True
        original = {"role": "assistant", "content": [{"text": "현재 카페 064-000-0000"}]}
        with patch.object(session.AgentCoreMemorySessionManager, "append_message") as append:
            manager.append_message(original, None)
        serialized = json.dumps(append.call_args.args[0], ensure_ascii=False)
        self.assertNotIn("064-000", serialized)
        self.assertEqual(original["content"][0]["text"], "현재 카페 064-000-0000")

    def test_main_prefetch_reuses_service_grounding_and_keeps_weather_calls(self):
        main = self.load_main()
        from atlas_agent.prefetch import PrefetchCall
        calls = [PrefetchCall("find_places", {"query": "카페", "category": "카페"}),
                 PrefetchCall("weather", {"near": "한라산"})]
        with patch.object(main, "PREFETCH", True), patch.object(main, "tools", [object()]), \
                patch.object(main, "plan_prefetch", return_value=calls), \
                patch.object(main, "execute_prefetch", new=AsyncMock(return_value=[])) as execute:
            results = asyncio.run(main._prefetch("카페와 날씨", grounding()))
        self.assertEqual([call.tool for call in execute.call_args.args[0]], ["weather"])
        self.assertEqual(len(results), 1)
        self.assertEqual(json.loads(results[0].text)["provider"], "kakao")

    def test_grounded_turn_cleans_cached_results_and_restores_memory_policy(self):
        main = self.load_main()
        from atlas_agent import prefetch
        self.assertTrue(callable(getattr(main, "_grounded_turn", None)))
        policy = prefetch.GuideGroundingPolicy()
        memory = SimpleNamespace(omit_lookup_content=False)

        class Agent:
            messages = []
            _atlas_grounding_policy = policy
            _atlas_memory_manager = memory

            async def stream_async(self, prompt, **kwargs):
                self.messages.extend(deepcopy(prompt))
                self.messages.append({"role": "assistant", "content": [{"text": "現在 064-000-0000"}]})
                assert memory.omit_lookup_content
                assert policy.grounding
                yield {"data": "현재 카페입니다."}

        agent = Agent()
        events = asyncio.run(collect(main._grounded_turn(
            agent, "해산물 알레르기가 있어요. 추천해 주세요.", prefetch.grounding_prefetch(grounding()), grounding())))
        self.assertEqual(events[0], {"type": "grounding", "version": 1})
        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse(memory.omit_lookup_content)
        self.assertIsNone(policy.grounding)
        saved = json.dumps(agent.messages, ensure_ascii=False)
        self.assertNotIn("12345", saved)
        self.assertNotIn("064-000", saved)
        self.assertIn("해산물 알레르기", saved)

    def test_history_trimming_does_not_leave_native_payloads_in_the_cached_agent(self):
        main = self.load_main()
        from atlas_agent import prefetch
        policy = prefetch.GuideGroundingPolicy()
        memory = SimpleNamespace(omit_lookup_content=False)

        class Agent:
            _atlas_grounding_policy = policy
            _atlas_memory_manager = memory

            def __init__(self):
                self.messages = [{"role": "assistant", "content": [{"text": "older answer"}]} for _ in range(20)]

            async def stream_async(self, prompt, **kwargs):
                # SlidingWindowConversationManager removes old messages in place.
                self.messages[:] = deepcopy(prompt)
                yield {"data": "현재 카페를 안내합니다."}

        agent = Agent()
        asyncio.run(collect(main._grounded_turn(agent, "현재 추천", prefetch.grounding_prefetch(grounding()), grounding())))
        self.assertNotIn("12345", json.dumps(agent.messages))

    def test_closing_the_outer_stream_immediately_restores_grounding_and_memory_guards(self):
        main = self.load_main()
        from atlas_agent import prefetch
        policy = prefetch.GuideGroundingPolicy()
        memory = SimpleNamespace(omit_lookup_content=False)

        class Agent:
            messages = []
            _atlas_grounding_policy = policy
            _atlas_memory_manager = memory

            async def stream_async(self, prompt, **kwargs):
                yield {"data": "현재 카페"}

        async def close():
            source = main._grounded_turn(Agent(), "추천", prefetch.grounding_prefetch(grounding()), grounding())
            outer = main._guarded_stream("test-conversation", source)
            await anext(outer)
            self.assertTrue(memory.omit_lookup_content)
            await outer.aclose()
            self.assertFalse(memory.omit_lookup_content)
            self.assertIsNone(policy.grounding)
        asyncio.run(close())


if __name__ == "__main__":
    unittest.main()
