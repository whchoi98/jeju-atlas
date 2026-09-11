"""Validate immutable artifacts, then replace PID 1 with the quiet routing server."""
import json
import os
import sys

from runtime import CONFIG_PATH, DATA_ROOT, ENGINE_VERSION, validate_artifacts


def main():
    try:
        validate_artifacts(DATA_ROOT, verify_hashes=False)
        if not CONFIG_PATH.is_file():
            raise ValueError()
        print(json.dumps({"event": "routing_starting", "engine_version": ENGINE_VERSION}), flush=True)
    except Exception:
        print('{"event":"routing_start_failed","code":"invalid_artifact"}', file=sys.stderr, flush=True)
        return 1
    # The native HTTP implementation must not emit request coordinates through any logger.
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    os.execv("/usr/local/bin/valhalla_service",
             ["valhalla_service", str(CONFIG_PATH), "1"])


if __name__ == "__main__":
    sys.exit(main())
