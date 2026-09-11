"""Probe local graph readiness without emitting response bodies or coordinates."""
import json
import re
from urllib.request import ProxyHandler, build_opener

URL = 'http://127.0.0.1:8002/status?json=%7B%22verbose%22%3Atrue%7D'


def healthy(*, opener=None):
    opener = opener or build_opener(ProxyHandler({})).open
    try:
        with opener(URL, timeout=3) as response:
            if response.status != 200:
                return False
            raw = response.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            return False
        status = json.loads(raw)
        return (isinstance(status, dict) and status.get("has_tiles") is True
                and re.fullmatch(r"3\.8\.3(?:[-+][A-Za-z0-9.]+)?", str(status.get("version", ""))) is not None
                and isinstance(status.get("tileset_last_modified"), (int, float))
                and status["tileset_last_modified"] > 0
                and {"route", "height", "status"} <= set(status.get("available_actions", [])))
    except Exception:
        return False


if __name__ == "__main__":
    raise SystemExit(0 if healthy() else 1)
