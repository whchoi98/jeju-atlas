"""festivals — TourAPI snapshot (weekly, Korea-side runner) first; live TourAPI only when a key exists and no snapshot.
TourAPI's gateway (apis.data.go.kr) times out from AWS (PLAN.md 8장 #22), hence snapshot-first.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from . import geo, snapshots
from .external import keys, tourapi

SNAPSHOT_MAX_AGE_S = 14 * 86400.0
CATEGORY = "축제"


def _iso(value: Any) -> str | None:
    s = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _overlaps(item_start: str | None, item_end: str | None, start: str, end: str | None) -> bool:
    s = item_start or "0000-01-01"
    e = item_end or item_start or "9999-12-31"
    return e >= start and (end is None or s <= end)


def _item(raw: dict[str, Any], source: str, observed_at: str | None, id_prefix: str = "") -> dict[str, Any] | None:
    try:
        lat, lng = float(raw["lat"]), float(raw["lng"])
    except (KeyError, TypeError, ValueError):
        return None
    if not geo.in_jeju(lat, lng):
        return None
    return {"id": f"{id_prefix}{raw.get('id')}", "name": str(raw.get("name") or ""), "lat": lat, "lng": lng, "category": CATEGORY,
            "summary": str(raw.get("summary") or raw.get("address") or ""), "start": _iso(raw.get("start")), "end": _iso(raw.get("end")),
            "url": raw.get("url"), "source": raw.get("source") or source, "observed_at": observed_at}


def festivals(start_date: str, end_date: str | None = None) -> dict[str, Any]:
    start = _iso(start_date)
    if start is None:
        return {"error": "invalid_date", "message": "start_date 는 YYYY-MM-DD(또는 YYYYMMDD)여야 합니다.", "fallback": True, "provider": "snapshot"}
    end = None
    if end_date:
        end = _iso(end_date)
        if end is None:
            return {"error": "invalid_date", "message": "end_date 는 YYYY-MM-DD(또는 YYYYMMDD)여야 합니다.", "fallback": True, "provider": "snapshot"}
    try:
        snap = snapshots.load("festivals")
        if snap is not None:
            items = [it for it in (_item(r, snap.get("source") or "", snap.get("observed_at")) for r in snap.get("items") or [] if isinstance(r, dict)) if it]
            items = [it for it in items if _overlaps(it["start"], it["end"], start, end)]
            return {"items": items, "observed_at": snap.get("observed_at"), "source": snap.get("source"),
                    "stale": snapshots.is_stale(snap, SNAPSHOT_MAX_AGE_S), "provider": "snapshot", "warnings": []}
        if keys.has_provider("tourapi"):
            res = tourapi.tour_festivals(start.replace("-", ""), end.replace("-", "") if end else None, limit=50)
            if not res.get("error"):
                observed_at = geo.now_iso()
                items = [it for it in (_item(r, res.get("source") or tourapi.SOURCE, observed_at, "tourapi:") for r in res.get("items") or []) if it]
                return {"items": items, "observed_at": observed_at, "source": res.get("source"), "stale": False, "provider": "tourapi", "warnings": []}
            return {"error": res["error"], "message": res.get("message", "TourAPI 호출 실패"), "fallback": True, "items": [], "provider": "tourapi"}
    except Exception as exc:  # noqa: BLE001
        return {"error": "unexpected_error", "message": f"축제 조회 중 오류({type(exc).__name__})", "fallback": True, "items": [], "provider": "snapshot"}
    return {"error": "no_data", "message": "축제 스냅샷이 없고 TOURAPI_SERVICE_KEY 도 없습니다. 국내 러너를 실행해 snapshots/festivals.json 을 만드세요.",
            "fallback": True, "items": [], "provider": "snapshot"}
