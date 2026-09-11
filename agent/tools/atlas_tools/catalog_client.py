"""Atlas catalog access — uses this CodeZip's catalog.py, with bundled POIs as fallback.

    search(q, lat, lng, radius_m, category, limit) -> list[dict]
    get(id) -> dict | None

The package root contains `catalog.py` (FTS5 index at $ATLAS_CATALOG_PATH).
When the module is missing or lacks the two callables we use `catalog_fallback` (same signatures).
"""
from __future__ import annotations

import importlib
import logging
from types import ModuleType
from typing import Any

log = logging.getLogger(__name__)
_backend: ModuleType | None = None


def _load_backend() -> ModuleType:
    global _backend
    if _backend is None:
        try:
            mod = importlib.import_module("catalog")
            if not (callable(getattr(mod, "search", None)) and callable(getattr(mod, "get", None))):
                raise ImportError("catalog module lacks search/get")
            _backend = mod
        except ImportError as exc:
            from . import catalog_fallback

            log.info("catalog backend unavailable type=%s — using bundled fallback", type(exc).__name__)
            _backend = catalog_fallback
    return _backend


def reset_backend() -> None:
    global _backend
    _backend = None


def backend_name() -> str:
    return _load_backend().__name__


def search(q: str, lat: float | None = None, lng: float | None = None, radius_m: int | None = None,
           category: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    return list(_load_backend().search(q, lat, lng, radius_m, category, limit))


def get(id: str) -> dict[str, Any] | None:  # noqa: A002
    return _load_backend().get(id)
