"""System prompt loader — perf-routing plan 08 Task 4.

`system.md` holds everything common to every streaming mode (role, tools, rules) and speaks only of
writing the "답변 본문" (answer body); it never tells the model to produce MapResponseV2 itself. Each mode
appends its own format section:

- "derive" (default; also every unrecognised value — a typo in ATLAS_STRUCTURED_MODE must not silently
  ask the model for a structured-output round trip it will never use): `format_derive.md` — write the
  body in plain text only, the server derives MapResponseV2 from the turn's tool results (see
  `atlas_agent.derive`), zero model round trips for the map.
- "single" / "two_stage": `format_structured.md` — the model must build MapResponseV2 itself (the two
  modes differ only in *when* that structured-output call happens, not in what it must contain).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent
SYSTEM_PROMPT_PATH = PROMPTS_DIR / "system.md"
FORMAT_DERIVE_PATH = PROMPTS_DIR / "format_derive.md"
FORMAT_STRUCTURED_PATH = PROMPTS_DIR / "format_structured.md"

# Modes whose model output IS MapResponseV2 itself. Everything else (including "derive" and any
# unrecognised value) gets the plain-text-body format section — see the module docstring.
_STRUCTURED_OUTPUT_MODES = frozenset({"single", "two_stage"})


@lru_cache(maxsize=8)
def load_system_prompt(mode: str = "derive") -> str:
    """system.md + a blank line + the mode's format section, stripped.

    An unknown `mode` is treated as "derive" (never "single"/"two_stage") — asking an unrecognised mode
    to emit MapResponseV2 would silently break the very modes derive exists to avoid paying for.
    """
    format_path = FORMAT_STRUCTURED_PATH if mode in _STRUCTURED_OUTPUT_MODES else FORMAT_DERIVE_PATH
    common = SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()
    format_section = format_path.read_text(encoding="utf-8").strip()
    return f"{common}\n\n{format_section}".strip()
