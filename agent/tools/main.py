"""JejuAtlasTools — MCP server (FastMCP, streamable-http) exposing 8 consolidated Jeju travel tools via AgentCore Gateway.

Every tool returns a JSON-serialisable dict, never raises, and degrades to {"error": ..., "fallback": true} when a
key/snapshot is missing. Descriptions are Korean one-liners that say WHEN to use the tool: the Gateway http-runtime
target does path routing (no semantic search), so the name + description is all the model sees. Logic lives in
atlas_tools/ so it is unit-tested without MCP.

Return annotations must be `dict[str, Any]` (not bare `dict`): with mcp 1.24 FastMCP only then emits structured output
(call_tool → (content, dict) tuple) — measured 2026-09-06; bare `dict` yields text blocks only.
"""
from typing import Any

from atlas_tools.privacy import configure_privacy

configure_privacy()

from mcp.server.fastmcp import FastMCP

from atlas_tools import festivals as _festivals
from atlas_tools import layers as _layers
from atlas_tools import places as _places
from atlas_tools import planner as _planner
from atlas_tools import routing as _routing
from atlas_tools import sun as _sun
from atlas_tools import weather as _weather

mcp = FastMCP("JejuAtlasTools", host="0.0.0.0", stateless_http=True)
configure_privacy()


@mcp.tool()
def find_places(query: str, lat: float | None = None, lng: float | None = None, radius_m: int | None = None,
                category: str | None = None, limit: int = 10, near: str | None = None) -> dict[str, Any]:
    """제주 장소(관광지·오름·해변·카페·맛집·올레길·박물관·시장·주차장 등)를 키워드와 선택적 기준 좌표·반경·카테고리로 검색해 좌표·출처·관측시각이 붙은 마커 목록을 돌려줍니다. 사용자가 장소 추천·'근처'·'어디'를 물으면 다른 도구보다 먼저 사용하세요. '~ 근처' 질문은 near에 그 장소 이름(예: '성산일출봉')만 주세요 — lat/lng를 직접 계산하거나 radius_m을 바꿔 여러 번 부를 필요 없이, 서버가 기준 장소를 찾아(응답 anchor) 반경을 3000→10000m까지 자동으로 넓히고 10km 안에 하나도 없으면 반경 제한 없이 한 번 더 찾아 한 번에 답을 줍니다(근처 검색은 near 하나로 끝난다). 카탈로그 결과에 카카오맵 최신 상업 POI를 합칩니다(KAKAO_REST_API_KEY 없으면 카탈로그만). 응답의 anchor(기준 장소)·anchor_match(exact|fuzzy)·radius_used_m(실제 반경, null 이면 반경 제한 없이 찾은 먼 결과)·widened 를 확인하고, anchor_match 가 fuzzy 면 기준 장소가 사용자가 말한 곳과 다를 수 있으니 답변에 밝히세요. exhaustive: true(더 넓혀도 결과 없음) 또는 fewer_than_limit: true(근처에 그만큼 없음)가 있으면 재호출하지 마세요."""
    return _places.find_places(query, lat=lat, lng=lng, radius_m=radius_m, category=category, limit=limit, near=near)


@mcp.tool()
def place_detail(id: str) -> dict[str, Any]:
    """장소 id(find_places 결과의 id, 예: poi_0008 또는 kakao:12345)로 주소·태그·평균 체류 시간·카카오맵/카카오내비 딥링크를 가져옵니다. 특정 장소를 자세히 설명하거나 길 안내 링크를 붙일 때 사용하세요."""
    return _places.place_detail(id)


@mcp.tool()
def route(stops: list[dict], mode: str = "car") -> dict[str, Any]:
    """{lat,lng} 좌표 2~12개를 순서대로 잇는 경로(거리·소요시간·폴리라인·구간 legs)를 계산합니다. mode 는 car(카카오 자동차, 기본)·walk·transit·straight. 사용자가 이동 시간·경로·동선을 물을 때 사용하세요. 카카오 키가 없거나 실패하면 직선 경로(fallback=true)를 돌려줍니다."""
    return _routing.route(stops, mode)


@mcp.tool()
def weather(lat: float | None = None, lng: float | None = None, hours: int = 12, near: str | None = None) -> dict[str, Any]:
    """좌표의 시간별 예보(기온·강수확률·하늘·강수형태·풍속)와 현재 관측값을 기상청(API허브) 우선, 실패 시 Open-Meteo 로 가져옵니다. 날씨·비 올 확률·야외 활동(오름·해변·올레길) 추천 전에 사용하세요. 답변에는 observed_at 과 source 를 함께 말합니다. 좌표 대신 near 에 장소 이름을 주면 find_places 와 **같은 턴에 동시에** 호출할 수 있습니다(좌표를 기다리지 마세요) — 서버가 카탈로그에서 기준 장소를 찾아 좌표로 씁니다. 응답의 anchor(기준 장소)·anchor_match(exact|fuzzy)를 확인하세요."""
    return _weather.weather(lat, lng, hours, near)


@mcp.tool()
def sun_times(lat: float | None = None, lng: float | None = None, date: str | None = None, near: str | None = None) -> dict[str, Any]:
    """좌표와 날짜(YYYY-MM-DD, 생략 시 오늘)의 일출·일몰·박명·골든아워 시각을 로컬 계산(astral)으로 돌려줍니다. 일출 명소·일몰 카페·아침 브리핑을 안내할 때 사용하세요(네트워크·키 불필요). 좌표 대신 near 에 장소 이름을 주면 find_places 와 **같은 턴에 동시에** 호출할 수 있습니다(좌표를 기다리지 마세요) — 서버가 카탈로그에서 기준 장소를 찾아 좌표로 씁니다. 응답의 anchor(기준 장소)·anchor_match(exact|fuzzy)를 확인하세요."""
    return _sun.sun_times(lat, lng, date, near)


@mcp.tool()
def layer(layer: str, bbox: str | None = None, near: str | None = None) -> dict[str, Any]:
    """지도 영역 bbox('minLng,minLat,maxLng,maxLat') 안의 실시간 레이어를 돌려줍니다. layer 는 parking(공영주차 가능대수)·ev(전기차 충전소)·road(노면·통제). 사용자가 주차·충전·도로 통제를 물을 때 사용하세요. stale=true 면 관측시각이 오래된 것이니 그 사실을 밝힙니다. bbox 대신 near 에 장소 이름을 주면 find_places 와 **같은 턴에 동시에** 호출할 수 있습니다(좌표를 기다리지 마세요) — 서버가 기준 장소 주변 사각형을 자동으로 만듭니다. 응답의 anchor·anchor_match·bbox 를 확인하세요."""
    return _layers.layer(layer, bbox, near)


@mcp.tool()
def festivals(start_date: str, end_date: str | None = None) -> dict[str, Any]:
    """기간(YYYY-MM-DD, end_date 생략 시 start_date 이후 전체) 안에 열리는 제주 축제·행사를 한국관광공사 TourAPI 스냅샷에서 조회합니다. 사용자가 여행 날짜의 축제·행사·이벤트를 물을 때 사용하세요."""
    return _festivals.festivals(start_date, end_date)


@mcp.tool()
def plan_day(stops: list[dict], start_time: str = "09:00", constraints: dict | None = None) -> dict[str, Any]:
    """{id?, name, lat, lng, stay_min?} 장소 2~12개를 방문 순서·체류 시간·실이동시간이 붙은 하루 일정(Itinerary)으로 만듭니다. constraints 는 {keep_order, mode(car|walk|straight), date, end_time, default_stay_min}. 사용자가 '일정', '코스', '하루 동선', '몇 시에'를 원할 때 find_places 로 좌표를 확보한 뒤 사용하세요."""
    return _planner.plan_day(stops, start_time, constraints)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
