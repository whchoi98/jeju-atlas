#!/usr/bin/env python3
"""One explicit live English guide turn, then check its telemetry for content.

The request is synthetic. Session cookies, CSRF proofs and conversation tokens
are never written to the report or console.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid

import boto3
import requests

from deploy import connect, save


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required for the single billable guide turn")
    session = connect()
    control = session.client("bedrock-agentcore-control")
    runtime_ids = ("Ohmyjeju_OhmyjejuAgent-7fiRWV5uVi", "Ohmyjeju_OhmyjejuTools-BzugIP8Xga")
    versions = []
    for runtime_id in runtime_ids:
        state = control.get_agent_runtime(agentRuntimeId=runtime_id)
        if state["status"] != "READY" or state["environmentVariables"].get("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT") != "false":
            raise RuntimeError("Deploy and verify both privacy-enabled runtimes before this check")
        versions.append({"id": runtime_id, "version": state["agentRuntimeVersion"]})
    marker = "privacy-check-" + uuid.uuid4().hex
    question = ("Plan a short family visit to Seongsan Ilchulbong and Gwangchigi Beach. "
                "Use confirmed visiting information and cite sources. "
                f"Diagnostic marker {marker}; do not repeat this marker in the answer.")
    http = requests.Session()
    base = "https://jeju-atlas.whchoi.net"
    config = http.get(base + "/api/config", timeout=20)
    config.raise_for_status()
    proof = config.json()["guide"]["csrf_token"]
    started_at = datetime.now(timezone.utc)
    started = time.monotonic()
    response = http.post(base + "/api/guide",
                         headers={"Origin": base, "X-Atlas-CSRF": proof},
                         json={"message": question, "locale": "en", "request_id": str(uuid.uuid4())},
                         timeout=(10, 115))
    frames = []
    if response.status_code == 200:
        for raw in response.text.replace("\r\n", "\n").split("\n\n"):
            name, data = None, None
            for line in raw.splitlines():
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
            if name and name != "session" and data is not None:
                frames.append({"event": name, "data": data})
    maps = [item["data"] for item in frames if item["event"] == "map"]
    answer = maps[-1].get("answer", "") if maps else "".join(
        item["data"].get("delta", "") for item in frames if item["event"] == "text")
    tools = sorted({item["data"]["tool"] for item in frames
                    if item["event"] == "status" and item["data"].get("tool")})
    report = {
        "startedAt": started_at.isoformat(), "versions": versions,
        "inputMarker": marker,
        "httpStatus": response.status_code, "elapsedSeconds": round(time.monotonic() - started, 3),
        "answer": answer, "tools": tools, "modelTurns": 1, "passed": False,
    }
    if (response.status_code != 200 or not answer or len(answer) < 100
            or any(item["event"] == "error" for item in frames) or "plan_day" not in tools):
        save("guide-privacy-live.json", report)
        raise RuntimeError("The English itinerary must complete before its telemetry is evaluated")
    print(json.dumps({"guideComplete": True, "seconds": report["elapsedSeconds"], "tools": tools}), flush=True)
    logs = session.client("logs")
    start_ms = int(started_at.timestamp() * 1000)
    end_ms = int(datetime.now(timezone.utc).timestamp() * 1000) + 5000
    report["logWindow"] = {"startMs": start_ms, "endMs": end_ms}
    groups = [("/aws/bedrock-agentcore/runtimes/" + runtime_id + "-DEFAULT", None) for runtime_id in runtime_ids]
    if any(item["logGroupName"] == "/aws/spans"
           for item in logs.describe_log_groups(logGroupNamePrefix="/aws/spans")["logGroups"]):
        groups.append(("/aws/spans", '"Ohmyjeju_OhmyjejuAgent.DEFAULT"'))
    events = []
    # Exporters batch records. Poll the same invocation window; never invoke again.
    for attempt in range(7):
        events = []
        for group, pattern in groups:
            options = {"filterPattern": pattern} if pattern else {}
            for page in logs.get_paginator("filter_log_events").paginate(
                logGroupName=group, startTime=start_ms, endTime=end_ms, **options):
                events.extend(page.get("events", []))
        joined = "\n".join(item["message"] for item in events)
        if "global.openai.gpt-6-astra" in joined and ("gen_ai.usage." in joined or "gen_ai.tool.name" in joined):
            break
        if attempt < 6:
            time.sleep(20)
    fragments = [answer[index:index + 100] for index in range(0, max(0, len(answer) - 99), 100)]
    leaks = {
        "inputMarker": marker in joined,
        "question": question in joined,
        "answerFragment": any(fragment in joined for fragment in fragments),
    }
    report["telemetry"] = {
        "eventsObserved": len(events), "modelMetadataPresent": "global.openai.gpt-6-astra" in joined,
        "toolMetadataPresent": "gen_ai.tool.name" in joined or any(name in joined for name in tools),
        "tokenCountsPresent": "gen_ai.usage." in joined, "contentLeaks": leaks,
    }
    report["passed"] = (bool(events) and report["telemetry"]["modelMetadataPresent"]
                        and report["telemetry"]["toolMetadataPresent"] and not any(leaks.values()))
    save("guide-privacy-live.json", report)
    # Retain raw synthetic-window evidence privately, without printing other users' events.
    evidence = Path(__file__).resolve().parents[1] / ".local/guide-privacy-telemetry.json"
    evidence.write_text(json.dumps(events, ensure_ascii=False))
    evidence.chmod(0o600)
    print(json.dumps({"passed": report["passed"], "telemetry": report["telemetry"]}), flush=True)
    if not report["passed"]:
        raise RuntimeError("Live telemetry privacy verification failed")


if __name__ == "__main__":
    main()
