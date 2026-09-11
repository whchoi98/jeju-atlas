#!/usr/bin/env python3
"""Check course coverage and documented wrapper commands without executing them."""
import json
from pathlib import Path
import re
import sys

from lab import AGENT_STEPS, DEPLOY_STEPS, LOCAL_STEPS, VERIFICATION_STEPS
from lab_workspace import read_template

ROOT = Path(__file__).resolve().parents[2]
COURSE = ROOT / "workshop"


def main():
    course = json.loads((COURSE / "course.json").read_text())
    expected = {f"{number:02}" for number in range(14)}
    if {item["id"] for item in course["chapters"]} != expected:
        raise ValueError("The course must cover chapters 00 through 13")
    if len({item["slug"] for item in course["chapters"]}) != len(course["chapters"]):
        raise ValueError("Duplicate chapter slug")
    steps = DEPLOY_STEPS | set(AGENT_STEPS) | set(LOCAL_STEPS) | set(VERIFICATION_STEPS)
    documented = set()
    for chapter in course["chapters"]:
        path = COURSE / "chapters" / (chapter["slug"] + ".md")
        prompt = COURSE / "prompts" / (chapter["slug"] + ".md")
        if not path.is_file() or not prompt.is_file():
            raise ValueError("Missing chapter or prompt: " + chapter["slug"])
        text = path.read_text()
        if not text.startswith("# ") or len(text) < 500:
            raise ValueError("Chapter is incomplete: " + chapter["slug"])
        for step in re.findall(r"lab\.py\s+run\s+([a-z-]+)", text):
            if step not in steps:
                raise ValueError("Undocumented wrapper step: " + step)
            documented.add(step)
        if re.search(r"(?im)\b(?:TODO|TBD|FIXME)\b", text):
            raise ValueError("Unresolved placeholder in " + chapter["slug"])
    mandatory = {"plan-bootstrap", "plan-data", "agent-build", "agent-publish", "agent-plan",
                 "agent-apply", "agent-status", "routing-fetch", "routing-build", "build-routing-push",
                 "build-push", "plan-app", "plan-origin", "plan-origin-routing", "plan-edge",
                 "plan-static", "plan-tls-probe", "verify-tls", "plan-operations", "verify"}
    if mandatory - documented:
        raise ValueError("Missing deployment coverage: " + ", ".join(sorted(mandatory - documented)))
    resource_types = set()
    resource_count = 0
    for template in (ROOT / "infra").glob("*.yaml"):
        resources = read_template(template).get("Resources", {})
        resource_count += len(resources)
        resource_types.update(value["Type"] for value in resources.values())
    coverage = (COURSE / "reference/resources.md").read_text()
    missing = [kind for kind in resource_types if kind not in coverage]
    if missing:
        raise ValueError("Infrastructure types missing from resource matrix: " + ", ".join(sorted(missing)))
    print(json.dumps({"chapters": 14, "promptCards": 14, "documentedSteps": len(documented),
                      "infrastructureDeclarations": resource_count, "infrastructureTypes": len(resource_types),
                      "passed": True}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, FileNotFoundError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
