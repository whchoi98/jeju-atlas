"""layer — real-time overlays (parking | ev | road) from the runner snapshots; EV falls back to the Jeju Data Hub
dataset (static, key required). `apis.data.go.kr`-hosted feeds (환경부 EV) are unreachable from AWS (PLAN.md 8장 #22),
so ITS/EV live collection lives in the Korea-side runner (plan 5) and this tool reads its snapshot.

`parking`/`road` are snapshot-ONLY by design (no live fallback exists that AWS can reach), so until the
plan-05 runner publishes `snapshots/layers/{parking,road}.json` both return `{"error": "no_data"}`.
Spec M3 (주차 가능대수·노면, 신선도 ≤5분) therefore cannot be met by this branch alone — it is a
cross-plan dependency, not a defect of this tool.
"""
from __future__ import annotations

from typing import Any

from . import geo, places, snapshots
from .external import jejuhub, keys

LAYERS = ("parking", "ev", "road")
MAX_AGE_S = {"parking": 300.0, "road": 300.0, "ev": 86400.0}
ANCHOR_BBOX_DEGREES = 0.05  # perf-routing Task 1: near= without bbox -> anchor ± this many degrees


def _snapshot_items(snap: dict[str, Any], bbox: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    out = []
    for raw in snap.get("items") or []:
        if not isinstance(raw, dict):
            continue
        try:
            lat, lng = float(raw["lat"]), float(raw["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        if not geo.in_bbox(lat, lng, bbox):
            continue
        out.append({"id": str(raw.get("id") or f"{len(out)}"), "name": str(raw.get("name") or ""), "lat": lat, "lng": lng,
                    "status": str(raw.get("status") or "unknown"), "observed_at": raw.get("observed_at") or snap.get("observed_at"),
                    "source": raw.get("source") or snap.get("source") or ""})
    return out


def _ev_live(bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    res = jejuhub.jejuhub_ev_chargers(limit=100)
    if res.get("error"):
        return {"error": res["error"], "message": res.get("message", "전기차 충전소 데이터를 가져오지 못했습니다."), "fallback": True,
                "layer": "ev", "items": [], "observed_at": None, "source": None, "stale": True, "warnings": [], "provider": "jejuhub"}
    observed_at = geo.now_iso()
    items = []
    for i, r in enumerate(res.get("items") or []):
        if r.get("lat") is None or r.get("lng") is None or not geo.in_bbox(r["lat"], r["lng"], bbox):
            continue
        kind = "급속" if r.get("quick") else "완속"
        status = f"{kind} {r.get('charger_count') or '?'}기" + (f" · {r['hours']}" if r.get("hours") else "")
        items.append({"id": f"ev:{i}", "name": str(r.get("place") or ""), "lat": float(r["lat"]), "lng": float(r["lng"]),
                      "status": status, "observed_at": observed_at, "source": res.get("source") or ""})
    return {"layer": "ev", "items": items, "observed_at": observed_at, "source": res.get("source"), "stale": False,
            "warnings": ["ev: 실시간 상태가 아닌 제주데이터허브 충전소 목록(정적)입니다."], "provider": "jejuhub"}


def layer(layer: str, bbox: str | None = None, near: str | None = None) -> dict[str, Any]:  # noqa: A002 — MCP tool parameter name fixed by the contract
    """지도 영역 bbox('minLng,minLat,maxLng,maxLat') 안의 실시간 레이어를 돌려줍니다. bbox 대신 near 에 장소 이름
    (예: '성산일출봉')을 주면 카탈로그에서 그 장소를 찾아 기준점(anchor) 주변 ±0.05도 사각형을 bbox 로 씁니다 —
    find_places 와 같은 턴에 동시에 호출할 수 있습니다(좌표를 기다리지 마세요). bbox 가 함께 오면 near 는 무시하고
    그 bbox 를 그대로 씁니다. near 로 만든 bbox 는 응답의 anchor(기준 장소)·anchor_match(exact|fuzzy)·bbox 필드로
    확인하세요. near 를 카탈로그에서 찾을 수 없으면 error="unresolvable_near" 를 돌려줍니다.
    """
    name = str(layer or "").strip().lower()
    if name not in LAYERS:
        return {"error": "invalid_layer", "message": f"layer 는 {', '.join(LAYERS)} 중 하나여야 합니다: {name!r}", "fallback": True, "provider": "snapshot"}

    anchor: dict[str, Any] | None = None
    anchor_match: str | None = None
    box = geo.parse_bbox(bbox) if bbox else None
    if box is None and bbox:
        return {"error": "invalid_bbox", "message": "bbox 는 'minLng,minLat,maxLng,maxLat' 형식이어야 합니다.", "fallback": True, "provider": "snapshot"}
    if box is None and near:
        anchor, err = places.anchor_for(near, provider="snapshot")
        if err is not None:
            return err
        anchor_match = places._anchor_match(near, anchor["name"])
        min_lng, min_lat = anchor["lng"] - ANCHOR_BBOX_DEGREES, anchor["lat"] - ANCHOR_BBOX_DEGREES
        max_lng, max_lat = anchor["lng"] + ANCHOR_BBOX_DEGREES, anchor["lat"] + ANCHOR_BBOX_DEGREES
        box = (min_lng, min_lat, max_lng, max_lat)
        bbox = f"{min_lng},{min_lat},{max_lng},{max_lat}"
    if box is None:
        return {"error": "invalid_bbox", "message": "bbox 는 'minLng,minLat,maxLng,maxLat' 형식이거나 near 로 기준 장소를 지정해야 합니다.",
                "fallback": True, "provider": "snapshot"}

    def _finish(payload: dict[str, Any]) -> dict[str, Any]:
        if anchor is not None:
            return {**payload, "anchor": anchor, "anchor_match": anchor_match, "bbox": bbox}
        return payload

    try:
        snap = snapshots.load(f"layers/{name}")
        if snap is not None:
            return _finish({"layer": name, "items": _snapshot_items(snap, box), "observed_at": snap.get("observed_at"), "source": snap.get("source"),
                    "stale": snapshots.is_stale(snap, MAX_AGE_S[name]), "warnings": [], "provider": "snapshot"})
        if name == "ev":
            if not keys.has_provider("jejuhub"):
                return _finish({**keys.missing_key_response("jejuhub"), "layer": name, "items": [], "observed_at": None, "source": None, "stale": True, "warnings": []})
            return _finish(_ev_live(box))
    except Exception as exc:  # noqa: BLE001 — never raise
        return _finish({"error": "unexpected_error", "message": f"레이어 조회 중 오류({type(exc).__name__})", "fallback": True, "layer": name,
                "items": [], "observed_at": None, "source": None, "stale": True, "warnings": [], "provider": "snapshot"})
    return _finish({"error": "no_data", "message": f"{name} 레이어 스냅샷이 없습니다(국내 러너 미실행 또는 S3 미동기화).", "fallback": True, "layer": name,
            "items": [], "observed_at": None, "source": None, "stale": True, "warnings": [], "provider": "snapshot"})
