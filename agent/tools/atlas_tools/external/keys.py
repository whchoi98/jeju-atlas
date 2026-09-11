"""API key resolution for the external data-source tools.

Order: environment variable → explicitly configured secondary store → None (see agent/tools/README.md).
Results (including misses) are cached for KEY_TTL_S seconds so a missing key does not hammer a store on every call.
"""
from __future__ import annotations

import os
import time

KEY_TTL_S = 60.0
DOCS = "agent/tools/README.md"

# provider id -> environment variables that must ALL be present (the preferred credential set)
PROVIDERS: dict[str, tuple[str, ...]] = {
    "tourapi": ("TOURAPI_SERVICE_KEY",),
    "kma": ("KMA_SERVICE_KEY",),
    "jejuhub": ("JEJUHUB_PROJECT_KEY",),
    "kakao": ("KAKAO_REST_API_KEY",),
    "naver_search": ("NAVER_API_HUB_KEY_ID", "NAVER_API_HUB_KEY"),  # NAVER API HUB (current)
    "naver_maps": ("NCP_MAPS_KEY_ID", "NCP_MAPS_KEY"),
    "jeju_its": ("JEJU_ITS_KEY",),  # 제주 ITS(주차·노면·통제) — 국내 러너/레이어 스냅샷
    "ev": ("EV_SERVICE_KEY",),  # 환경부 전기차 충전소 — 국내 러너/레이어 스냅샷
}
# provider id -> alternative credential sets that also enable the provider (any complete set is enough)
ALTERNATIVES: dict[str, tuple[tuple[str, ...], ...]] = {
    "kma": (("KMA_API_HUB_KEY",),),  # 기상청 API허브 (apihub.kma.go.kr) — preferred in practice, see kma.py
    "naver_search": (("NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"),),  # developers.naver.com (ends 2027-06-30)
}

_cache: dict[str, tuple[str | None, float]] = {}


def _secondary_lookup(name: str) -> str | None:
    """Deployed runtime: SSM SecureString under $ATLAS_SECRETS_SSM_PREFIX (no-op when the prefix is unset)."""
    from . import secrets_ssm  # local import keeps boto3 optional for tests/dev

    return secrets_ssm.lookup(name)


def reset_cache() -> None:
    _cache.clear()


def get_key(name: str) -> str | None:
    """Return the secret for `name` or None. Environment wins; otherwise the secondary store (cached)."""
    env = os.environ.get(name)
    if env and env.strip():
        return env.strip()
    now = time.monotonic()
    hit = _cache.get(name)
    if hit and hit[1] > now:
        return hit[0]
    value = _secondary_lookup(name)
    value = value.strip() if isinstance(value, str) and value.strip() else None
    _cache[name] = (value, now + KEY_TTL_S)
    return value


def has_provider(provider: str) -> bool:
    credential_sets = (PROVIDERS.get(provider, ()),) + ALTERNATIVES.get(provider, ())
    return any(names and all(get_key(v) for v in names) for names in credential_sets)


def provider_status() -> dict[str, bool]:
    return {p: has_provider(p) for p in PROVIDERS}


def missing_key_response(provider: str, *var_names: str) -> dict:
    if var_names:
        names = ", ".join(var_names)
    else:
        sets = (PROVIDERS.get(provider, ()),) + ALTERNATIVES.get(provider, ())
        names = " 또는 ".join("+".join(n) for n in sets if n)
    return {
        "error": "missing_api_key",
        "provider": provider,
        "fallback": True,
        "how_to": f"{names} 전용 런타임 환경 변수({DOCS} 참고)가 설정되면 이 도구가 활성화됩니다. 지금은 카탈로그·직선 경로 폴백(find_places/route/plan_day 의 fallback 결과)을 사용하세요.",
    }
