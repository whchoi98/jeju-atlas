"""Rule-based intent prefetch for JejuAtlasGuide — run the obvious tool calls BEFORE the model is asked.

Why: measured 2026-09-07 on staging (plan 10 실측), an ordinary turn costs the model TWICE — once to decide
which tool to call (2.5~3 s with thinking disabled) and once to write the answer (TTFT 2 s + 4~5 s of
generation). For the four most common intents the tool choice is not a judgement call at all:

| intent                        | prefetched calls                                                       |
|-------------------------------|------------------------------------------------------------------------|
| "<place> 근처 <category>"      | find_places(query, near, category, limit=5)                            |
| "<place> 날씨/일출"            | weather(near, hours), + sun_times(near, date) when a sun word is there |
| "<place> 주차"                 | layer(layer="parking", near)                                           |
| "<A>에서 <B>까지 얼마나"        | find_places(query=A, limit=1), find_places(query=B, limit=1)           |

`plan_prefetch` returns those calls (possibly several — they run in parallel) or `[]`, which means "no
prefetch, run the normal tool loop". `execute_prefetch` runs them on the shared Gateway MCP client
(`main.tools[0]`, already warmed at boot) and the caller seeds the results into the conversation, so
Sonnet 5 is called exactly once, to write the answer.

Design rules this module is bound by:
- The route intent prefetches only the two place lookups, never `route` itself (Ruling R2): `route` needs
  both stops' coordinates, which only exist after those lookups return, and the model composes the stops.
- The prompt text may feed tool ARGUMENTS only (place name, category). Coordinates never come from the
  prompt — `near=` makes the tools resolve the anchor server-side from the catalog.
- `near=` is never simply the token adjacent to the NEAR/trigger word: the anchor is the nearest candidate
  to its LEFT that `is_place` accepts (`left_anchor`, Ruling R6). An unresolvable anchor is not a degraded
  turn but a SILENT wrong answer — the tools answer `{"error": "unresolvable_near"}` (or worse, some
  unrelated row) with status "success" — so anything that is not a place must be skipped, not passed on.
- …and `near=` is never a place from some OTHER part of the prompt either: each rule anchors on the place
  its own trigger word is ATTACHED to, and the NEAR-word fallback (`near_place`, which has no attachment
  relation to any trigger) may only speak when `place_candidates` finds exactly one place in the whole
  prompt. A prompt naming two places with nothing attached to the trigger prefetches nothing: the wrong one
  of two names the user typed is a place the tools resolve "exact", so R7 cannot see it either.
- A result is only seeded when `seedable` accepts it (Ruling R7): the parser cannot be perfect, so the
  RESULT is verified semantically — success, a JSON object with no `error`, an anchor that resolved
  exactly to a name the user actually typed, and, for a route stop, a first item that names the place
  that was looked up. Whatever fails is dropped and the model calls that tool itself.
- Any failure — timeout, exception, no rule match, prefetch disabled, guard rejection — degrades to the
  normal tool loop (Ruling R1). Nothing here may raise into the turn or reach the user as an error.
- The MCP call uses the BARE tool name; only the seeded `toolUse` block carries the Gateway prefix
  (`gateway_tool_name`, Ruling R4), because that is the name the model was given.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

from .privacy import safe_tool_name

log = logging.getLogger(__name__)

PREFETCH_ENV = "ATLAS_PREFETCH"
TOOL_USE_PREFIX = "prefetch-"       # toolUseId of the nth planned call: "prefetch-1", "prefetch-2", …
GATEWAY_PREFIX = "jejuatlastools_"   # same constant as streaming.STRIP_PREFIX / tool_budget.STRIP_PREFIX
DEFAULT_TIMEOUT_S = 3.0
NEARBY_LIMIT = 5                    # find_places for "근처" — one call, server widens the radius itself
ROUTE_STOP_LIMIT = 1                # route stops only need the single best match per name
HOURS_TODAY = 12
HOURS_TOMORROW = 24
SCAN_TOKENS = 4                     # how many tokens LEFT of a NEAR/trigger word the anchor scan may read
EN_PHRASE_WORDS = 4                 # an English place name may span words ("Jeju City Hall"), like _EN_NAME

try:
    KST: tzinfo = ZoneInfo("Asia/Seoul")
except Exception:  # pragma: no cover - a container image shipped without tzdata
    KST = timezone(timedelta(hours=9))  # Korea has had no DST since 1988, so the fixed offset is exact


@dataclass(frozen=True)
class PrefetchCall:
    """One planned MCP tool call. `tool` is the bare MCP name ("find_places" | "weather" | "sun_times" | "layer")."""

    tool: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class PrefetchResult:
    """One completed prefetch. `text` is the tool's JSON exactly as the MCP server returned it."""

    call: PrefetchCall
    tool_use_id: str
    text: str
    status: str            # "success" | "error"
    ms: int
    service_grounding: bool = False


def grounding_prefetch(grounding: dict | None) -> list[PrefetchResult]:
    """Seed already-validated BFF results; this performs no provider/Gateway call."""
    if grounding is None:
        return []
    items = [{**item.get("details", {}), **{key: value for key, value in item.items() if key != "details"}}
             for item in grounding["items"]]
    payload = {
        "items": items, "total": len(items), "query": grounding["query"], "provider": "kakao",
        "source": "Kakao Local", "observed_at": grounding["queried_at"],
        "sources": [{"provider": "kakao", "label": "Kakao Local", "observed_at": grounding["queried_at"]}],
        "anchor": grounding["anchor"], "anchor_match": "exact" if grounding["anchor"] else None,
        "fallback": grounding["status"] != "ready", "message": grounding["message"],
        "native_grounding": grounding["status"], "_atlas_transient_grounding": True,
    }
    return [PrefetchResult(
        call=PrefetchCall("find_places", {"query": grounding["query"], "limit": 3}),
        tool_use_id="atlas-native-1", text=json.dumps(payload, ensure_ascii=False),
        status="success", ms=0, service_grounding=True,
    )]


def covered_discovery_call(tool: str, arguments: Any, grounding: dict | None) -> bool:
    """Keep a grounded commercial request on its current source; other tools remain available."""
    if grounding is None:
        return False
    tool = tool.removeprefix(GATEWAY_PREFIX)
    args = arguments if isinstance(arguments, dict) else {}
    if tool == "place_detail":
        return str(args.get("id", "")).startswith("kakao:")
    if tool != "find_places":
        return False
    category = str(args.get("category") or "")
    query = str(args.get("query") or "")
    if category in {"맛집", "음식점", "식당", "카페", "숙소", "숙박", "호텔", "주차장"}:
        return True
    if any(norm_text(query) == norm_text(item["name"]) for item in grounding["items"]):
        return True
    if re.search(r"카페|커피|맛집|음식점|식당|숙소|숙박|호텔|주차장|caf[eé]|coffee|restaurant|hotel|parking", query, re.I):
        return True
    if category:
        return False
    anchor = grounding.get("anchor")
    if anchor and norm_text(query) == norm_text(anchor["name"]) and not str(anchor["id"]).startswith("kakao:"):
        return False
    return not bool(re.search(r"오름|해변|해수욕장|올레|숲|공원|한라산|일출봉|박물관|beach|trail|hallasan|museum|park|seongsan", query, re.I))


class GuideGroundingPolicy(HookProvider):
    """Per-conversation source guard; the existing ToolBudget still owns all call ceilings."""
    def __init__(self):
        self.grounding: dict | None = None

    def register_hooks(self, registry: HookRegistry, **_: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self.check)

    def check(self, event: BeforeToolCallEvent) -> None:
        if event.cancel_tool:
            return
        use = event.tool_use or {}
        if covered_discovery_call(str(use.get("name") or ""), use.get("input"), self.grounding):
            event.cancel_tool = (
                "현재 카카오 조회 자료가 이미 제공되었습니다. 그 자료로 답하고, 조회 실패·빈 결과를 기존 상업 카탈로그로 "
                "대신하지 마세요. Use the provided current Kakao reference; do not repeat or substitute a legacy commercial lookup."
            )


# ---- vocabulary ------------------------------------------------------------------------------------------
PLACE = r"(?P<place>[가-힣A-Za-z0-9·]{2,20}?)"
NEAR = r"(근처|주변|인근|가까운|앞|옆|near|around|close to)"
# What the user says -> the `category` value find_places accepts. The VALUES must stay inside the tools'
# own taxonomy (`catalog.CATEGORIES` = 관광지·오름·해변·카페·맛집·올레길·박물관·시장·문화시설·레포츠·숙박·쇼핑): the
# catalog rejects any other category at build time and both backends filter on exact equality
# (`AND p.category = ?`), so an off-taxonomy value can only ever return 0 rows — a `success` result that
# tells the model to answer "결과가 없다" while the real rows sit right there. Plan 10 wrote 음식점/숙소 here
# (fix round 1: → 맛집/숙박); tests/product/test_agent_prefetch.py asserts the values against CATEGORIES.
CATEGORY_WORDS = {"카페": "카페", "커피": "카페", "맛집": "맛집", "식당": "맛집", "음식점": "맛집", "밥집": "맛집", "해변": "해변", "해수욕장": "해변", "오름": "오름", "관광지": "관광지", "볼거리": "관광지", "박물관": "박물관", "시장": "시장", "숙소": "숙박", "cafe": "카페", "cafes": "카페", "coffee": "카페", "restaurant": "맛집", "restaurants": "맛집", "beach": "해변"}

# Longest first so "cafes" wins over "cafe" and "해수욕장" is never split.
_WHAT = "|".join(re.escape(w) for w in sorted(CATEGORY_WORDS, key=len, reverse=True))
WHAT = rf"(?P<what>{_WHAT})"
_PARTICLE = r"(?:의|에|에서|은|는|이|가|를|을)?"
_FILLER = r"(?:[가-힣A-Za-z0-9·]{1,10}\s+){0,2}?"   # non-greedy: "근처 예쁜 카페" keeps the FIRST category word

# "<place> 근처 <category>" and "<category> near <place>". The place character class excludes whitespace, so
# a Korean place is always the token adjacent to the NEAR word; the English tail may span words
# ("cafes near Hamdeok beach").
NEARBY_PLACE_FIRST = re.compile(rf"{PLACE}\s*{_PARTICLE}\s*{NEAR}\s*{_FILLER}{WHAT}", re.IGNORECASE)
NEARBY_WHAT_FIRST = re.compile(rf"{WHAT}\s*{_PARTICLE}\s*{NEAR}\s+(?P<tail>[가-힣A-Za-z0-9·][가-힣A-Za-z0-9·\s]{{0,29}})", re.IGNORECASE)
# What the user says right after the category word to EXCLUDE it ("카페 말고 맛집", "맛집 빼고"). Rule 1 read
# the category word alone and seeded a search for the very thing the user ruled out, and R7 verifies the
# ANCHOR only — never the category — so the result was seeded, the model searched the category it DID want
# (different arguments, so the tool budget's dedupe never saw a repeat) and `derive` merged both result
# sets: up to `NEARBY_LIMIT` markers of the excluded category on the map. Anchored at the start (`^`) and
# tested against the text FOLLOWING the captured category word, so only an immediate exclusion counts —
# with one particle allowed in between, because "카페는 빼고" is the same sentence as "카페 빼고" (a particle
# followed by an exclusion word is never anything else). A particle followed by a request verb is not an
# exclusion and still prefetches ("카페도 알려줘", "맛집은 어디야").
EXCLUDE_WORDS = re.compile(r"^\s*(?:은|는|이|가|을|를|도|만)?\s*(?:말고|말구|빼고|제외|아니고|아니라|대신)")
# Place next to a NEAR word with no category attached — the fallback anchor for the weather/parking rules.
NEAR_PLACE_FIRST = re.compile(rf"{PLACE}\s*{_PARTICLE}\s*{NEAR}", re.IGNORECASE)
NEAR_PLACE_LAST = re.compile(rf"{NEAR}\s+(?P<tail>[가-힣A-Za-z0-9·][가-힣A-Za-z0-9·\s]{{0,29}})", re.IGNORECASE)

WEATHER_WORDS = re.compile(r"(날씨|기온|비\s*올|비가|우산|바람|weather|rain)", re.IGNORECASE)
# `(?<![가-힣])` keeps "성산일출봉" from reading as a sunrise question while "일출시간" (no space) still does.
SUN_WORDS = re.compile(r"(?<![가-힣])(일출|일몰|해돋이|해넘이|sunrise|sunset)", re.IGNORECASE)
WEATHER_PLACE = re.compile(rf"{PLACE}\s*(?:의|에|에서|은|는)?\s*(내일|오늘|오전|오후|아침|저녁|날씨|weather)", re.IGNORECASE)
TOMORROW_WORDS = re.compile(r"내일|tomorrow", re.IGNORECASE)

PARKING_WORDS = re.compile(r"(주차장|주차|parking)", re.IGNORECASE)
PARKING_PLACE = re.compile(rf"{PLACE}\s*(?:의|에|에서|은|는)?\s*(?:주차장|주차|parking)", re.IGNORECASE)

ROUTE_TRIGGER = re.compile(r"(얼마나|걸려|걸리|경로|시간|가는\s*길|how\s+long|route)", re.IGNORECASE)
ROUTE_KO = re.compile(r"(?P<a>[가-힣A-Za-z0-9·]{2,20}?)\s*(?:에서|부터)\s*(?P<b>[가-힣A-Za-z0-9·]{2,20}?)\s*(?:까지|으로|로)(?![가-힣])")
# Words that end an English stop name ("from A to B how long …" must not read B as "B how long does it take").
_EN_STOP = r"(?:how|by|in|on|at|with|and|or|route|takes?|taking|driving|drive|please|today|tomorrow|is|does|do)"
_EN_NAME = r"[A-Za-z0-9·]+(?:\s+[A-Za-z0-9·]+){0,3}?"
ROUTE_EN = re.compile(
    rf"\bfrom\s+(?P<a>{_EN_NAME})\s+to\s+(?P<b>{_EN_NAME})(?=\s*[?.,!]|\s+{_EN_STOP}\b|\s*$)",
    re.IGNORECASE,
)

# Words that look like a place to the regexes but are not one. Time words, the intent words themselves and
# the request verbs ("... 알려주고 오늘 날씨" would otherwise anchor on "알려주고").
STOPWORDS = frozenset({
    "내일", "오늘", "모레", "어제", "지금", "당장", "이제", "오전", "오후", "아침", "저녁", "점심", "새벽", "밤", "낮",
    "주말", "이번", "다음", "요즘", "하루", "이틀", "일정", "코스", "동선",
    "날씨", "기온", "우산", "바람", "강수", "일출", "일몰", "해돋이", "해넘이", "시간", "정보", "상황", "실시간",
    "주차", "주차장", "공영", "무료", "유료", "공공", "자리",
    "근처", "주변", "주변에", "인근", "가까운", "여기", "거기", "저기", "우리", "아이", "혼자", "가족", "커플", "친구",
    # A device-location phrasing, not a name: "내 위치 근처 맛집" anchored on "위치" ("내" is one char and
    # already rejected) and spent a Gateway round trip inside the turn on an anchor R7 drops afterwards.
    "위치", "현재", "현위치",
    "추천", "어디", "얼마나", "렌터카", "버스", "택시", "도보", "차로",
    "weather", "rain", "sunrise", "sunset", "today", "tomorrow", "near", "around", "parking", "time", "now",
    "please", "recommend",
})
# Request verbs / connectives; a candidate containing one of these is a clause, not a place name. The two
# predicate endings 까/는데 ("비 올까?", "온다는데") are here for the same reason the verbs are: they end a
# CLAUSE, and the weather rule now counts the place candidates a prompt offers, so a junk candidate is not
# merely a wasted round trip — it makes a one-place prompt look ambiguous and costs the fallback its anchor.
NOT_PLACE = re.compile(r"(알려|보여|추천|찾아|말해|가르쳐|해줘|해주|줄래|부탁|어때|어디|얼마|같이|그리고|줘$|주고$|하고$|랑$|까$|는데$"
                       r"|가능해$|해요$|할까$|있어$|있나$|있나요$|되나$|되나요$|될까$|걸려$|걸릴까$|가요$|나요$|세요$|시나요$|어요$|을까$|주차장$)")  # sentence-final verbs are never places
# A stopword with a particle stuck on it ("날씨도", "기온도", "오늘은"). `PARTICLES` deliberately refuses to
# strip "도" off a 3-char token so the island names survive (마라도/제주도), so these forms never reach the
# exact-set lookup in `is_place`. Full match with one optional particle, like POSITION_WORD/FACILITY_WORD,
# so a real name that merely BEGINS with a stopword is untouched.
_KO_STOPWORDS = sorted((w for w in STOPWORDS if re.fullmatch(r"[가-힣]+", w)), key=len, reverse=True)
_KO_CATEGORIES = sorted((w for w in CATEGORY_WORDS if re.fullmatch(r"[가-힣]+", w)), key=len, reverse=True)
# A category word with a particle ("카페도", "맛집은") is a category, not a place — mirror of STOPWORD_FORM.
CATEGORY_FORM = re.compile(rf"^(?:{'|'.join(map(re.escape, _KO_CATEGORIES))})(?:에서|으로|에|의|은|는|이|가|도|로|만|랑|이랑)?$")
STOPWORD_FORM = re.compile(rf"^(?:{'|'.join(map(re.escape, _KO_STOPWORDS))})(?:에서|으로|에|의|은|는|이|가|도|로|만|랑)?$")
# A quantity phrase joined to the next noun with 과/와 — "성산일출봉 근처 카페 두 곳과 날씨 알려줘". The token
# sitting immediately before the weather word is "곳과", which `is_place` accepted, so the anchor scan
# stopped there and the turn spent a Gateway round trip on weather(near="곳과") that R7 dropped afterwards.
# A counter is never a place name (fix round 2, minor).
COUNTER_JOIN = re.compile(r"^(?:[한두세네]|다섯|여섯|일곱|여덟|아홉|열|몇|\d+)?\s*(?:곳|개|군데|명|가지|팀|분)(?:과|와)$")
# A candidate whose LAST word is an English function or time word: the bare word the left scan can land on
# ("… and rain at …" → near="and") and the phrase that grows out of it, because `_candidates` extends a
# Latin candidate LEFTWARD from the token adjacent to the trigger — so "weather near Hamdeok beach
# tomorrow" offered "Hamdeok beach tomorrow" and "… and rain at …" offered "beach and". None of them is a
# name; passing one on costs a Gateway round trip inside the turn that R7 drops afterwards (fix round 2,
# minor). It is also where an English clause ENDS, which is why `left_anchor` stops its scan here: English
# puts the place AFTER the weather word ("rain at 성산"), so walking left THROUGH "and"/"at" would hand the
# weather the place named in the previous clause — the very defect this round is about, in Latin script.
# `_EN_STOP` is reused rather than copied: it is already the vocabulary that ends an English route stop.
EN_TAIL_WORD = re.compile(rf"(?:^|\s)(?:{_EN_STOP}|tonight|yesterday|now|the|of|for)$", re.IGNORECASE)
# Relative-position nouns: "<place> 앞에/뒤에/건너편 <weather|주차>" says WHERE relative to a place, so the
# word is never itself a place a tool can resolve. WEATHER_PLACE/PARKING_PLACE capture the token sitting
# immediately before the trigger word — exactly this one — and used to hand it over as `near=`, throwing the
# real place away ("함덕해수욕장 앞에 날씨" → weather(near="앞에")). Both answers the tools then give are
# silent: the FTS catalog finds nothing and returns a plain {"error": "unresolvable_near"} dict (status
# "success", non-empty text — invisible to the executor's empty-content filter and to its error path),
# while the bundled fallback backend matches the word inside some row's summary ("… 바다를 바로 앞에 두고 …")
# and anchors the answer on THAT café, ~30 km from the place the user named (fix round 2 — same
# silent-wrong-result shape as the off-taxonomy category values of fix round 1). The particle is matched
# HERE rather than left to PARTICLES because these stems are 1~2 chars and PARTICLES will not strip a
# particle off a 1-char stem ("앞에" survived normalisation unchanged). Rejecting
# them lets the weather/parking rules fall through to near_place() (which spans the NEAR words 앞/옆) or,
# for a position word NEAR does not list, plan nothing at all — the normal tool loop (Ruling R1). Matching
# is a FULL match, so a real place name that merely contains one of these words is untouched (안덕계곡, 위미항).
# Split in two because the scan below treats them differently: a DIRECTION word points AWAY from the place
# ("<place> 뒤에/건너편"), so the place to its left is NOT what the user asked about and the scan stops
# there (round 2 keeps those prompts at `[]` until NEAR itself is widened — that is an approval, not a
# bug); a VICINITY word means "around <place>", exactly what the NEAR words mean, so the scan walks through
# it ("성산일출봉 정상 부근 날씨" → weather(near="성산일출봉")). `POSITION_WORD` — the union, i.e. what
# `is_place` rejects — is unchanged.
_DIRECTION_STEM = r"(?:앞|뒤|옆|위|아래|밑|안|밖|속|사이|건너|맞은|반대)"
_VICINITY_STEM = r"(?:부근|근방|주위|주변|일대)"
_POSITION_STEM = rf"(?:{_DIRECTION_STEM}|{_VICINITY_STEM})"
_POSITION_TAIL = r"(?:쪽|편|바다)?(?:에서|으로|에|의|은|는|이|가|도|로)?$"
POSITION_WORD = re.compile(rf"^{_POSITION_STEM}{_POSITION_TAIL}")
DIRECTION_WORD = re.compile(rf"^{_DIRECTION_STEM}{_POSITION_TAIL}")
# Facility / filler nouns: the name of a PART of the place the user already said ("한라산 정상", "성산일출봉
# 매표소", "제주공항 국내선 출구") or a bare intensifier ("바로 앞"). They are never a place a tool can
# resolve, and they sit between the real place and the NEAR/trigger word — where every anchor rule used to
# read its anchor from (fix round 3): "한라산 정상 근처 카페" planned find_places(near="정상"), and "정상"
# fuzzy-matches some row's summary in the bundled fallback backend, so the answer was about 백약이오름
# ~17 km away; "매표소" resolves to nothing at all and the tools answer {"error": "unresolvable_near"} with
# status "success". Same silent-wrong-answer shape as rounds 1~2. Rejection is a FULL match with an optional
# particle (like POSITION_WORD), so a real POI name that merely ENDS with one of these words is untouched
# ("한라산 어리목탐방안내소"); a test asserts every name in data/jeju_pois.json still passes `is_place`.
# A few of these words are in STOPWORDS too, and that is not redundant: STOPWORDS is an exact-set lookup,
# while this is the particle-tolerant form PARTICLES cannot normalise away ("주차장으로", "입구로").
FACILITY_WORDS: tuple[str, ...] = (
    "정상", "입구", "출구", "출입구", "정문", "후문", "매표소", "주차장", "주차", "정류장", "정거장", "승강장",
    "선착장", "전망대", "휴게소", "광장", "사거리", "삼거리", "교차로", "입장", "바로", "국내선", "국제선",
    "터미널", "청사", "대합실", "탑승구", "안내소", "화장실", "매점", "편의점", "로비",
)
FACILITY_WORD = re.compile(rf"^(?:{'|'.join(FACILITY_WORDS)})(?:에서|으로|에|의|은|는|이|가|도|로)?$")
# A trailing request clause the tail patterns can swallow ("Hamdeok beach 알려줘" → "Hamdeok beach").
TAIL_CLAUSE = re.compile(r"\s*(알려|추천|찾아|보여|말해|가르쳐|어디|어때|있나|있어|좀|부탁|근처|주변|인근|please|thanks).*$", re.IGNORECASE | re.S)
# Particles stripped from a captured place. "도" needs a longer stem so 2~3자 island names survive
# ("마라도"/"제주도" stay whole, "함덕해수욕장도" loses the particle).
# Coordinating particles ("A이랑 B", "A하고 B", "A과 B", "A와 B" = "A and B") are stripped too: left attached, the
# first place is rejected by NOT_PLACE's clause-verb endings (랑$/하고$) and silently vanishes from
# place_candidates(), which re-opens the two-place fallback defect (scoped re-review, 2026-09-07).
# 과/와 are NOT stripped: real names end with them ("월정리 로와") and they never reach NOT_PLACE anyway.
PARTICLES: tuple[tuple[str, int], ...] = (("에서", 2), ("이랑", 2), ("하고", 2), ("은", 2), ("는", 2), ("이", 2), ("가", 2), ("의", 2), ("에", 2), ("랑", 3), ("도", 4))
# Tokenising for the anchor scan (`left_anchor`, which walks right to left over the tokens LEFT of the
# NEAR/trigger word). The token class is the PLACE class, so "·" is part of a name and never a separator;
# the clause break is what ends a clause without being a name character — an anchor is never carried over
# from a different clause.
TOKEN = re.compile(r"[가-힣A-Za-z0-9·]+")
CONNECTIVE_TAIL = re.compile(r"(하고|다가|면서|고서)$")
COUNTER_PHRASE = re.compile(r"^(?:\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)?\s*(?:곳|개|군데|명|시간|분|박|잔|병)$")  # number optional: a bare counter is not a place either
# A NEAR word as a whole token (with an optional particle): ends the attached-place scan (see left_anchor).
NEAR_TOKEN = re.compile(rf"^{NEAR}(?:에서|으로|에|의|은|는|이|가|도|로)?$")
LATIN_TOKEN = re.compile(r"[A-Za-z0-9·]+")
CLAUSE_BREAK = re.compile(r"[?!.,;:~/()\[\]{}<>\"'\n]")


def gateway_tool_name(tool: str) -> str:
    """Name the model was given for `tool` (Ruling R4) — the Gateway prefixes every MCP tool."""
    return tool if tool.startswith(GATEWAY_PREFIX) else f"{GATEWAY_PREFIX}{tool}"


def kst_today() -> date:
    """Today's calendar day in Asia/Seoul — the only clock the user's "내일" can mean."""
    return datetime.now(KST).date()


def kst_tomorrow(today: date | None = None) -> str:
    """KST tomorrow as YYYY-MM-DD. `today` is injectable so callers/tests never depend on the wall clock."""
    return ((today or kst_today()) + timedelta(days=1)).isoformat()


def prefetch_enabled(raw: str | None) -> bool:
    """ATLAS_PREFETCH: "1"/"true"/"on"/"yes" (default) enable, "0"/"false"/"off"/"no" disable.

    An unrecognised value keeps prefetch ON with a warning: this is a latency feature, and a typo must not
    silently take it away (same defensive shape as _structured_mode/routing_mode).
    """
    value = (raw or "").strip().lower()
    if not value:
        return True
    if value in {"1", "true", "on", "yes", "y", "enable", "enabled"}:
        return True
    if value in {"0", "false", "off", "no", "n", "disable", "disabled"}:
        return False
    log.warning("invalid %s — prefetch stays on", PREFETCH_ENV)
    return True


# ---- place extraction ------------------------------------------------------------------------------------
def normalise_place(raw: str | None) -> str:
    """Trim a captured place: collapse whitespace, cut a trailing request clause, drop a trailing particle."""
    name = re.sub(r"\s+", " ", str(raw or "")).strip()
    name = TAIL_CLAUSE.sub("", name)
    name = name.strip(" \t·,.!?~'\"()[]{}<>:;")
    for particle, min_stem in PARTICLES:
        if particle == "도" and " " in name:
            continue  # "카페 델문도" is a name, "함덕해수욕장도" is a place + particle: a multi-word name keeps its 도
        if name.endswith(particle) and len(name) - len(particle) >= min_stem:
            name = name[: -len(particle)]
            break
    return name.strip()


def is_place(name: str | None) -> bool:
    """True when `name` can be handed to a tool's `near=`/`query=` as a place name."""
    value = (name or "").strip()
    if len(value) < 2 or value.isdigit():
        return False
    lowered = value.lower()
    if lowered in STOPWORDS or value in STOPWORDS:
        return False
    if lowered in CATEGORY_WORDS or value in CATEGORY_WORDS:   # "카페"/"cafes" is what we search FOR
        return False
    if POSITION_WORD.match(value):     # "앞에"/"뒤에"/"건너편" — a position, not a place
        return False
    if FACILITY_WORD.match(value):     # "정상"/"입구"/"매표소" — a part of a place, not a place
        return False
    if STOPWORD_FORM.match(value):     # "날씨도"/"기온도"/"오늘은" — a stopword wearing a particle
        return False
    if CATEGORY_FORM.match(value):   # "카페도"/"맛집은" — a category wearing a particle
        return False
    if COUNTER_PHRASE.match(value):     # "두 곳"/"3곳" — a quantity, not a place
        return False
    if COUNTER_JOIN.match(value):      # "곳과"/"두 곳과" — a counter joined with 과/와
        return False
    if EN_TAIL_WORD.search(value):     # "and"/"at"/"beach and"/"Hamdeok beach tomorrow"
        return False
    return not NOT_PLACE.search(value)


def _candidates(tokens: list[str], index: int) -> list[str]:
    """`tokens[index]` alone, then the Latin phrases ending at it — "beach" → "Hamdeok beach".

    A Korean place is always one token (the PLACE class has no whitespace), but an English one is not, so a
    rejected Latin token is retried with its neighbours attached, up to `EN_PHRASE_WORDS` words.
    """
    out = [tokens[index]]
    if LATIN_TOKEN.fullmatch(tokens[index]):
        for start in range(index - 1, max(index - EN_PHRASE_WORDS + 1, -1), -1):
            if not LATIN_TOKEN.fullmatch(tokens[start]):
                break
            out.append(" ".join(tokens[start : index + 1]))
    return out


def left_anchor(left_context: str) -> str:
    """The best place candidate in `left_context` — the prompt up to and INCLUDING the token adjacent to a
    NEAR/trigger word — searching right to left; `""` when there is none.

    Reading the adjacent token alone is what fix rounds 2 and 3 both broke on: whatever noun happens to sit
    between the real place and the NEAR word became `near=`. So the adjacent token is only the FIRST
    candidate here; when it is not a place (a facility/filler noun, a category word, a time word) the scan
    keeps walking left until it finds one. It stops at
      - a clause boundary (punctuation) — the place named in another clause is not this anchor,
      - a DIRECTION word ("<place> 뒤에/건너편") — the place to its left is not the spot the user asked about,
      - a request verb / connective (`NOT_PLACE`) — that is a clause, not a place,
      - an English function word (`EN_TAIL_WORD`) — the same clause break in Latin script, and the reason
        an English trigger ("… and rain at 성산") cannot reach the place named in the clause before it, and
      - `SCAN_TOKENS` tokens, so a long prompt cannot reach across half a sentence for an anchor.
    """
    tokens = TOKEN.findall(CLAUSE_BREAK.split(left_context)[-1])
    for index in range(len(tokens) - 1, max(len(tokens) - 1 - SCAN_TOKENS, -1), -1):
        if index == len(tokens) - 1 and CONNECTIVE_TAIL.search(tokens[index]):
            # The token right before the trigger word ending in -하고/-고/-다가 is a verb clause ("산책하고 날씨"),
            # not "<place> and": PARTICLES strips 하고 as a noun joiner for counting, so check the raw token here.
            break
        for candidate in _candidates(tokens, index):
            name = normalise_place(candidate)
            if is_place(name):
                return name
        if DIRECTION_WORD.match(tokens[index]) or NOT_PLACE.search(tokens[index]) or EN_TAIL_WORD.search(tokens[index]):
            break
        if NEAR_TOKEN.match(tokens[index]):
            # "<place> 근처(에서) <trigger>": the place left of a NEAR word belongs to that NEAR relation (the
            # nearby rule / the single-place fallback), not to this trigger word — "함덕해수욕장이랑 성산일출봉
            # 근처에서 산책하고 날씨 알려줘" must not attach the weather to 성산일출봉 (scoped re-review).
            break
    return ""


def place_candidates(text: str) -> list[str]:
    """Every distinct place name `text` offers, left to right — i.e. how many places the user named.

    The weather rule needs the COUNT, not the names: its `near_place` fallback has no relation to the
    weather word (see `_plan_weather`), so it may only speak for a prompt that names exactly ONE place —
    the one case where an unattached anchor cannot be the wrong one. Scanning reuses `left_anchor`'s
    machinery so "a place" means the same thing in both: a clause boundary separates chunks, a Korean place
    is one token, and a Latin place may span words — hence a Latin token followed by another Latin token is
    skipped and the run is counted once, at the phrase that ends on its last token ("Hamdeok beach"). A
    function word ends that run (`EN_TAIL_WORD`), so a sentence naming two English places around one
    ("cafes near Hamdeok beach and rain at Seongsan Ilchulbong") counts as the two places it is.
    """
    names: list[str] = []
    for chunk in CLAUSE_BREAK.split(text):
        tokens = TOKEN.findall(chunk)
        for index, token in enumerate(tokens):
            following = tokens[index + 1] if index + 1 < len(tokens) else ""
            if (LATIN_TOKEN.fullmatch(token) and LATIN_TOKEN.fullmatch(following)
                    and not EN_TAIL_WORD.search(following)):
                continue    # part of a longer Latin phrase — counted at the end of the run
            for candidate in _candidates(tokens, index):
                name = normalise_place(candidate)
                if is_place(name):
                    if name not in names:
                        names.append(name)
                    break
    return names


def _first_place(pattern: re.Pattern[str], text: str) -> str:
    """First `place`-group match of `pattern` whose LEFT context yields a usable place name."""
    for match in pattern.finditer(text):
        name = left_anchor(text[: match.end("place")])
        if name:
            return name
    return ""


def _attached_place(trigger: re.Pattern[str], text: str) -> str:
    """The place the first resolvable occurrence of `trigger` is ATTACHED to — `left_anchor` from that word.

    `_first_place` can only reach the triggers a `<place>`-carrying pattern spells out (WEATHER_PLACE lists
    날씨/weather and the time words), which leaves the rest of the trigger vocabulary — 기온·비가·비 올·우산·
    바람·rain — with no attachment rule at all. This reads the anchor for those with the same right-to-left
    scan, so it inherits every stop `left_anchor` has: a clause boundary, a direction word, a request verb,
    an English function word and the SCAN_TOKENS budget. `""` when the trigger has no place attached to it.
    """
    for match in trigger.finditer(text):
        name = left_anchor(text[: match.start()])
        if name:
            return name
    return ""


def _first_tail_place(pattern: re.Pattern[str], text: str) -> str:
    """First `tail`-group match — the patterns whose place FOLLOWS the NEAR word ("near Hamdeok beach")."""
    for match in pattern.finditer(text):
        name = normalise_place(match.group("tail"))
        if is_place(name):
            return name
    return ""


def near_place(text: str) -> str:
    """The place a NEAR word points at, with no category attached ("성산 근처 …" → "성산")."""
    return _first_place(NEAR_PLACE_FIRST, text) or _first_tail_place(NEAR_PLACE_LAST, text)


# ---- rules -----------------------------------------------------------------------------------------------
def _plan_nearby(text: str) -> list[PrefetchCall]:
    """Rule 1 — "<place> 근처 <category>" / "<category> near <place>".

    An immediately excluded category ("카페 말고 맛집") plans NOTHING: the model runs the ordinary tool loop
    and searches the category the user actually wants (Ruling R1). Aborting the whole rule rather than
    retrying the next match is deliberate — NEARBY_WHAT_FIRST would otherwise match the "<…해수욕장> 주변
    <tail>" of the same sentence and take the exclusion clause itself as the anchor ("함덕해수욕장 주변 맛집
    말고 카페 알려줘" → near="맛집 말고 카페"), trading one wrong seed for a worse one.
    """
    for pattern, group in ((NEARBY_PLACE_FIRST, "place"), (NEARBY_WHAT_FIRST, "tail")):
        for match in pattern.finditer(text):
            if EXCLUDE_WORDS.match(text[match.end("what"):]):
                return []
            # "place" sits LEFT of the NEAR word, so the anchor is scanned for there (a filler noun between
            # the two is skipped); "tail" FOLLOWS it ("cafes near Hamdeok beach") and is taken as captured.
            place = (left_anchor(text[: match.end(group)]) if group == "place"
                     else normalise_place(match.group(group)))
            if not is_place(place):
                continue
            what = match.group("what")
            category = CATEGORY_WORDS.get(what) or CATEGORY_WORDS.get(what.lower())
            if not category:  # pragma: no cover - WHAT is built from CATEGORY_WORDS itself
                continue
            return [PrefetchCall("find_places", {"query": what, "near": place, "category": category, "limit": NEARBY_LIMIT})]
    return []


def _plan_weather(text: str, today: date | None) -> list[PrefetchCall]:
    """Rule 2 — weather for the place the weather word is ATTACHED to, plus sun times for that same place.

    The anchor is read from the weather word outwards, never from the prompt at large: WEATHER_PLACE first
    (the plan's own rule — a `<place>` in front of 날씨/weather/내일/오늘/…), then the same right-to-left
    scan from the weather word itself, which is the only thing that covers the rest of WEATHER_WORDS
    (기온·비가·비 올·우산·바람·rain — words WEATHER_PLACE does not list as a trigger).

    `near_place(text)` — the place next to the FIRST NEAR word ANYWHERE in the prompt — used to be the
    fallback for all of them, and it has no clause or attachment relation to the weather word at all, so a
    prompt naming two places seeded the weather of the one the user did not ask about (the review's finding,
    the same defect the parking rule had in de06395):
      "성산일출봉 근처 카페 알려주고 함덕해수욕장 기온도 알려줘" → weather(near="성산일출봉")
      "함덕 근처 맛집 찾아줘, 그리고 성산일출봉에 비 올까?"      → weather(near="함덕")
    R7 cannot catch this class — the wrong anchor IS a name the prompt used, so the tools resolve it
    "exact" and `seedable` passes it, then the seeded result tells the model not to look again: a silent
    wrong place, like fix rounds 1~3. So the fallback now only speaks when `place_candidates` finds exactly
    ONE place in the whole prompt, the one case where an unattached anchor cannot be the wrong one; two or
    more places with nothing attached to the weather word plan NOTHING (Ruling R1, the normal tool loop).
    """
    if not WEATHER_WORDS.search(text):
        return []
    place = _first_place(WEATHER_PLACE, text) or _attached_place(WEATHER_WORDS, text)
    if not place and len(place_candidates(text)) == 1:
        # One place in the whole prompt: the weather can only be about that one. This is what keeps the
        # prompts where the place is present but NOT to the left of the trigger ("함덕해수욕장 앞에 날씨
        # 어때", "… 카페 알려주고 오늘 날씨도") on the fast path instead of the tool loop.
        place = near_place(text)
    if not place:
        return []
    tomorrow = bool(TOMORROW_WORDS.search(text))
    calls = [PrefetchCall("weather", {"near": place, "hours": HOURS_TOMORROW if tomorrow else HOURS_TODAY})]
    if SUN_WORDS.search(text):
        # The companion call rides on the WEATHER anchor, never on one of its own — except when the sun
        # word is demonstrably attached to a DIFFERENT place ("성산일출봉 일출이랑 함덕해수욕장 날씨"), which
        # is this very defect one call over and just as invisible to R7. Then it is simply not prefetched.
        sun_place = _attached_place(SUN_WORDS, text)
        if not sun_place or sun_place == place:
            arguments: dict[str, Any] = {"near": place}
            if tomorrow:  # today is the tool's own default, so the argument is only sent when it differs
                arguments["date"] = kst_tomorrow(today)
            calls.append(PrefetchCall("sun_times", arguments))
    return calls


def _plan_parking(text: str) -> list[PrefetchCall]:
    """Rule 3 — realtime parking layer around a named place.

    The place the user attached the parking word to comes FIRST, exactly as in `_plan_weather` and in plan
    10 rule 3 (`(주차|주차장|parking)` + `<place>`); `near_place` is only the fallback for a parking word that
    stands alone ("성산 근처 공영주차장", "parking near Hamdeok beach"). The reverse order — which the review
    caught — reads the first NEAR-word place ANYWHERE in the prompt, so a compound question fetched the
    parking layer for a place the user never mentioned parking about ("협재해수욕장 근처 카페 알려줘. 성산일출봉
    주차장은 어때?" → layer(near="협재해수욕장")). `near_place` has no clause or proximity relation to the
    parking word at all, and R7 cannot catch this class: the wrong anchor is still a name the prompt used,
    so the tools resolve it "exact" and the guard passes it — a silent wrong place, like rounds 2 and 3.
    """
    if not PARKING_WORDS.search(text):
        return []
    place = _first_place(PARKING_PLACE, text)
    if not place and len(place_candidates(text)) == 1:  # _first_place may return "" — treat any falsy as "no place"
        # The NEAR fallback is safe only when the prompt names ONE place (same guard as `_plan_weather`):
        # with two places and no attachment, the first NEAR-word place is a coin flip R7 cannot catch.
        place = near_place(text)
    if not place:
        return []
    return [PrefetchCall("layer", {"layer": "parking", "near": place})]


def _plan_route(text: str) -> list[PrefetchCall]:
    """Rule 4 — "<A>에서 <B>까지 얼마나": warm both stop lookups only; the model calls `route` (Ruling R2)."""
    if not ROUTE_TRIGGER.search(text):
        return []
    for pattern in (ROUTE_KO, ROUTE_EN):
        for match in pattern.finditer(text):
            start, end = normalise_place(match.group("a")), normalise_place(match.group("b"))
            if is_place(start) and is_place(end) and start != end:
                return [PrefetchCall("find_places", {"query": start, "limit": ROUTE_STOP_LIMIT}),
                        PrefetchCall("find_places", {"query": end, "limit": ROUTE_STOP_LIMIT})]
    return []


def _dedupe(calls: list[PrefetchCall]) -> list[PrefetchCall]:
    seen: set[str] = set()
    out: list[PrefetchCall] = []
    for call in calls:
        key = f"{call.tool}\x1f{json.dumps(call.arguments, sort_keys=True, ensure_ascii=False, default=str)}"
        if key not in seen:
            seen.add(key)
            out.append(call)
    return out


def plan_prefetch(prompt: str, *, today: date | None = None) -> list[PrefetchCall]:
    """Tool calls worth running before the model sees `prompt`; `[]` means "run the normal tool loop".

    Rules are independent and all matching ones are returned (they execute in parallel), in rule order:
    nearby search, weather (+ sun times), parking, route stops. `today` injects the KST calendar day used
    for "내일" so callers and tests never depend on the wall clock.
    """
    text = (prompt or "").strip()
    if not text:
        return []
    calls = _plan_nearby(text) + _plan_weather(text, today) + _plan_parking(text) + _plan_route(text)
    calls = _dedupe(calls)
    if calls:
        log.info("prefetch plan tools=%s", [safe_tool_name(c.tool) for c in calls])
    return calls


# ---- executor --------------------------------------------------------------------------------------------
def result_status(result: Any) -> str:
    """"success" | "error" from a strands MCPToolResult (a TypedDict, i.e. a plain dict at runtime)."""
    status = result.get("status") if isinstance(result, dict) else None
    if status in ("success", "error"):
        return str(status)
    return "error" if isinstance(result, dict) and result.get("isError") else "success"


def result_text(result: Any) -> str:
    """The tool's JSON text, exactly as the MCP server returned it (`json` blocks are re-serialised)."""
    content = result.get("content") if isinstance(result, dict) else None
    parts: list[str] = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("text"), str) and block["text"].strip():
            parts.append(block["text"])
        elif "json" in block:
            try:
                parts.append(json.dumps(block["json"], ensure_ascii=False, default=str))
            except (TypeError, ValueError):  # pragma: no cover - default=str makes dumps total in practice
                continue
    return "\n".join(parts).strip()


async def execute_prefetch(calls: list[PrefetchCall], client: Any, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> list[PrefetchResult]:
    """Run `calls` in parallel on the shared Gateway MCP `client`, dropping whatever does not come back.

    `client` is the process-wide strands MCPClient (`main.tools[0]`, warmed at boot), so these calls reuse
    the live MCP session. A call that times out, raises, or returns no content is logged and left out: the
    model then simply calls that tool itself (Ruling R1 — a prefetch failure is never user visible).
    An `error` result IS kept — it carries the server's message and `derive` already ignores error results.
    """
    if not calls or client is None:
        return []

    async def run_one(index: int, call: PrefetchCall) -> PrefetchResult | None:
        tool_use_id = f"{TOOL_USE_PREFIX}{index}"
        started = time.monotonic()
        try:
            result = await asyncio.wait_for(
                client.call_tool_async(tool_use_id=tool_use_id, name=call.tool, arguments=dict(call.arguments)),
                timeout_s,
            )
        except asyncio.CancelledError:  # the turn itself is being cancelled — never swallow it
            raise
        except TimeoutError:
            log.warning("prefetch %s timed out after %.1fs — leaving it to the model", safe_tool_name(call.tool), timeout_s)
            return None
        except Exception as exc:
            log.warning("prefetch %s failed type=%s — leaving it to the model", safe_tool_name(call.tool), type(exc).__name__)
            return None
        text = result_text(result)
        if not text:
            log.warning("prefetch %s returned no content — leaving it to the model", safe_tool_name(call.tool))
            return None
        ms = int((time.monotonic() - started) * 1000)
        log.info("prefetch %s ok in %d ms (%s, %d chars)", safe_tool_name(call.tool), ms, result_status(result), len(text))
        return PrefetchResult(call=call, tool_use_id=tool_use_id, text=text, status=result_status(result), ms=ms)

    done = await asyncio.gather(*(run_one(i, c) for i, c in enumerate(calls, start=1)), return_exceptions=True)
    out: list[PrefetchResult] = []
    for item in done:
        if isinstance(item, PrefetchResult):
            out.append(item)
        elif isinstance(item, asyncio.CancelledError):
            raise item
        elif isinstance(item, BaseException):  # pragma: no cover - run_one catches Exception itself
            log.warning("prefetch task failed type=%s", type(item).__name__)
    return out


# ---- seeding guard (Ruling R7) ---------------------------------------------------------------------------
def norm_text(text: Any) -> str:
    """NFC + all whitespace removed + casefold — how a resolved name is compared with the user's own words.

    Same normalisation `derive._norm` and `places._anchor_match` use, so "함덕 해수욕장" and "함덕해수욕장"
    are one name and comparison never depends on tokenisation.
    """
    return "".join(unicodedata.normalize("NFC", str(text or "")).split()).casefold()


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _seedable(result: Any, prompt: str | None) -> tuple[bool, str]:
    status = getattr(result, "status", None)
    if status != "success":
        return False, f"status={status!r}"
    text = getattr(result, "text", None)
    if not isinstance(text, str) or not text.strip():
        return False, "text is not JSON"
    try:
        payload = json.loads(text)
    except ValueError:
        return False, "text is not JSON"
    if not isinstance(payload, dict):
        return False, "text is not a JSON object"
    if "error" in payload:
        return False, f"payload carries error={payload.get('error')!r}"
    if getattr(result, "service_grounding", False):
        # BFF already resolved the signed selection/exact anchor. A user saying
        # "here" need not repeat that native place's full name in the question.
        return True, ""

    call = getattr(result, "call", None)
    tool = getattr(call, "tool", "") or ""
    arguments = getattr(call, "arguments", None)
    arguments = arguments if isinstance(arguments, dict) else {}

    # (d) A route stop is `find_places(query=<name>, limit=1)` with no `near`, so it has no anchor to
    # verify — the single item IS the verification: it must be the place that was looked up. Containment
    # either way, like the tools' own _anchor_match, because the catalog's name is often the longer one
    # ("한라산" → "한라산 성판악탐방안내소"). A stop resolved to some other place would put that place's
    # coordinates into the model's `route` call, i.e. a route between places the user never asked about.
    if tool == "find_places" and _as_int(arguments.get("limit")) == ROUTE_STOP_LIMIT:
        items = payload.get("items")
        first = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else None
        name = norm_text(first.get("name")) if first is not None else ""
        query = norm_text(arguments.get("query"))
        if not name:
            return False, "route stop returned no items"
        if not query or not (name in query or query in name):
            return False, f"route stop item {first.get('name')!r} does not match query {arguments.get('query')!r}"

    # (c) The anchor is where a wrong prefetch becomes a SILENT wrong answer: the tools resolve `near=`
    # against the catalog with a ranked text match, so near="제주공항" answers about 용두암 (~5 km away)
    # with status "success". Two conditions, both required: the tools themselves must call the match
    # exact, AND the resolved name must be one the user actually typed. The second is one-directional on
    # purpose — the tools call containment in EITHER direction exact, so near="한라산" →
    # "한라산 성판악탐방안내소" is exact there while being a place the user never named; seeding it would
    # answer about that place and centre the map on it. Dropping it only costs the latency win.
    anchor = payload.get("anchor")
    wants_anchor = bool(str(arguments.get("near") or "").strip())
    if wants_anchor or isinstance(anchor, dict):
        if not isinstance(anchor, dict):
            # `near` given but nothing resolved. find_places answers this with anchor=None, items=[] and
            # NO "error" key (places.py:340-347), so it is invisible to every check above — and seeding it
            # tells the model "there is nothing there" about a place it never actually looked at.
            return False, f"near={arguments.get('near')!r} resolved to no anchor at all"
        if payload.get("anchor_match") != "exact":
            return False, f"anchor_match={payload.get('anchor_match')!r} is not exact"
        name = str(anchor.get("name") or "").strip()
        if not norm_text(name):
            return False, "the anchor carries no name"
        if norm_text(name) not in norm_text(prompt):
            return False, f"anchor {name!r} is not a name the prompt used"
    return True, ""


def seedable(result: Any, prompt: str | None) -> tuple[bool, str]:
    """May `result` be seeded into the conversation as an already-run tool call? `(ok, reason)`.

    Ruling R7. `reason` is empty when `ok`, and otherwise says why the result was dropped (logged at INFO
    by the caller). A rejected result is not an error: the model simply calls that tool itself (R1).

    Why a guard at all: the rule-based parser (`plan_prefetch`) reads a place name out of free text and
    cannot be perfect, and a prefetch built on the wrong place does not fail loudly — the tools answer
    `status: "success"` about a DIFFERENT place, or about no place at all. This check is semantic (does the
    resolved place match what the user wrote?) rather than lexical, so it catches parser mistakes the
    parser itself cannot see. Never raises: an unreadable result is simply not seedable.
    """
    try:
        return _seedable(result, prompt)
    except Exception as exc:  # noqa: BLE001 — a guard that raises would take the whole turn down
        return False, f"unreadable result ({type(exc).__name__}: {exc})"
