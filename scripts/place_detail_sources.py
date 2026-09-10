"""Pure official-detail parsing and canonical-place -> provider-record matching.

No I/O, environment, credentials, clocks or SDKs. Caller example::

    hit = match_place(place, tourapi_items(list_response), "tourapi")
    if hit:
        detail = parse_tourapi(hit["record"], common, intro, info, images,
                               locale="ko", fetched_at=timestamp)
        detail["match"] = hit["match"]

parse_visitjeju(item, *, locale="ko", fetched_at=...) returns the same official
record fields. The caller adds match. Facts keep native keys, plain-text values
and label_ko/label_en, e.g. usetimeculture, restdateculture, opentimefood, info.0.
Locale describes supplied provider content, never an automatic translation.
Render strings as text/HTML-escape them; no weekly schedules or amenity booleans
are inferred. Empty/oversized fields are omitted rather than partially quoted.
Machine heritage flags are omitted from visitor facts. Known operational binary
flags get provider-qualified wording; reservation flags do not establish policy.
Optional diagnostics contain only {field, code, limit}, never source values.
Bounds use JavaScript UTF-16 units: title 256, phone 120, address 1000, overview
8000, fact key 80, labels 120, value 1000; at most 40 facts and 8 photos.
An invalid required title raises ValueError for the caller to skip that record.

match_place returns {"record": original_dict, "match": {"method": str,
"distance_m": float}} only for one eligible provider identity. Otherwise None;
explain_match supplies a reason and candidate IDs. A sample's unverified base
coordinates allow 2 km; other sources, including OSM, allow 150 m. Full names,
name_en, explicit full landmark aliases and trailing UNESCO labels only.
Distance is unrounded haversine, not confidence or independent verification.
Neither input records nor stored catalog IDs/names/coordinates are changed.

TourAPI images need their own Type1/Type3 declaration and original URL; Type3
never acquires a thumbnail. Licenses are not transferred to different images.
VisitJeju repPhoto is omitted: supplied API fixtures have no photo license.
Public website terms https://www.visitjeju.net/kr/common/terms (article 14,
checked 2026-09-10) restrict commercial website-material use. No separate blanket
API-photo grant was established. Text parsing does not assert reuse permission.
API access/HTTP 200 is not a rights grant.

TourAPI source_url is an explicit visitkorea.or.kr/knto.or.kr/data.go.kr publisher
URL or https://api.visitkorea.or.kr/. The venue homepage stays in website.
VisitJeju uses its public contentsid page.
"""
from __future__ import annotations

from datetime import datetime
from html import unescape
from html.parser import HTMLParser
import ipaddress
import math
import re
import unicodedata
from urllib.parse import parse_qsl, quote, urlsplit


SAMPLE_RADIUS_M = 2000
OSM_RADIUS_M = 150
PHOTO_LICENSES = {"Type1": "KOGL-1", "Type3": "KOGL-3"}

# Raw provider fields; stroller rental is not general child suitability.
INTRO_FIELDS = {
    "12": [
        ("accomcount", "수용 인원", "Capacity"),
        ("chkbabycarriage", "유모차 대여(제공처 값)", "Stroller rental (provider value)"),
        ("chkcreditcard", "신용카드(제공처 값)", "Credit cards (provider value)"),
        ("chkpet", "반려동물 동반(제공처 값)", "Pets (provider value)"),
        ("expagerange", "체험 가능 연령", "Activity age range"),
        ("expguide", "체험 안내", "Activities"),
        ("infocenter", "문의 안내", "Contact information"),
        ("opendate", "개장일", "Opening date"),
        ("parking", "주차 안내", "Parking information"),
        ("restdate", "휴무일", "Closed days"),
        ("useseason", "이용 시기", "Season of use"),
        ("usetime", "이용시간", "Visiting hours"),
    ],
    "14": [
        ("accomcountculture", "수용 인원", "Capacity"),
        ("chkbabycarriageculture", "유모차 대여(제공처 값)", "Stroller rental (provider value)"),
        ("chkcreditcardculture", "신용카드(제공처 값)", "Credit cards (provider value)"),
        ("chkpetculture", "반려동물 동반(제공처 값)", "Pets (provider value)"),
        ("discountinfo", "할인 안내", "Discount information"),
        ("infocenterculture", "문의 안내", "Contact information"),
        ("parkingculture", "주차 안내", "Parking information"),
        ("parkingfee", "주차 요금", "Parking fees"),
        ("restdateculture", "휴무일", "Closed days"),
        ("usefee", "이용 요금", "Admission fees"),
        ("usetimeculture", "이용시간", "Opening hours"),
        ("scale", "규모", "Size"),
        ("spendtime", "관람 소요시간", "Suggested visit duration"),
    ],
    "25": [
        ("distance", "코스 거리", "Course distance"),
        ("infocentertourcourse", "코스 문의", "Course contact information"),
        ("schedule", "코스 일정", "Course schedule"),
        ("taketime", "코스 소요시간", "Course duration"),
        ("theme", "코스 주제", "Course theme"),
    ],
    "28": [
        ("accomcountleports", "수용 인원", "Capacity"),
        ("chkbabycarriageleports", "유모차 대여(제공처 값)", "Stroller rental (provider value)"),
        ("chkcreditcardleports", "신용카드(제공처 값)", "Credit cards (provider value)"),
        ("chkpetleports", "반려동물 동반(제공처 값)", "Pets (provider value)"),
        ("expagerangeleports", "체험 가능 연령", "Activity age range"),
        ("infocenterleports", "문의 안내", "Contact information"),
        ("openperiod", "운영 기간", "Operating period"),
        ("parkingfeeleports", "주차 요금", "Parking fees"),
        ("parkingleports", "주차 안내", "Parking information"),
        ("reservation", "예약 안내", "Reservations"),
        ("restdateleports", "휴무일", "Closed days"),
        ("scaleleports", "규모", "Size"),
        ("usefeeleports", "이용 요금", "Activity fees"),
        ("usetimeleports", "이용시간", "Operating hours"),
    ],
    "38": [
        ("chkbabycarriageshopping", "유모차 대여(제공처 값)", "Stroller rental (provider value)"),
        ("chkcreditcardshopping", "신용카드(제공처 값)", "Credit cards (provider value)"),
        ("chkpetshopping", "반려동물 동반(제공처 값)", "Pets (provider value)"),
        ("culturecenter", "문화센터", "Cultural center"),
        ("fairday", "장날", "Market days"),
        ("infocentershopping", "문의 안내", "Contact information"),
        ("opendateshopping", "개장일", "Opening date"),
        ("opentime", "영업시간", "Opening hours"),
        ("parkingshopping", "주차 안내", "Parking information"),
        ("restdateshopping", "휴무일", "Closed days"),
        ("restroom", "화장실", "Restrooms"),
        ("saleitem", "판매 품목", "Products"),
        ("saleitemcost", "판매 가격 안내", "Price information"),
        ("scaleshopping", "규모", "Size"),
        ("shopguide", "매장 안내", "Shop information"),
    ],
    "39": [
        ("chkcreditcardfood", "신용카드(제공처 값)", "Credit cards (provider value)"),
        ("discountinfofood", "할인 안내", "Discount information"),
        ("firstmenu", "대표 메뉴", "Signature menu"),
        ("infocenterfood", "문의 안내", "Contact information"),
        ("kidsfacility", "어린이 놀이시설(제공처 값)", "Children's facilities (provider value)"),
        ("opendatefood", "개업일", "Opening date"),
        ("opentimefood", "영업시간", "Opening hours"),
        ("packing", "포장 안내", "Takeaway"),
        ("parkingfood", "주차 안내", "Parking information"),
        ("reservationfood", "예약 안내", "Reservations"),
        ("restdatefood", "휴무일", "Closed days"),
        ("scalefood", "규모", "Size"),
        ("seat", "좌석 수", "Seating"),
        ("smoking", "금연·흡연 안내", "Smoking policy"),
        ("treatmenu", "취급 메뉴", "Menu"),
        ("lcnsno", "인허가 번호", "Permit number"),
    ],
}
TOUR_CATEGORIES = {
    "12": {"관광지", "오름", "해변", "박물관", "문화시설"},
    "14": {"박물관", "문화시설", "관광지"},
    "25": {"올레길"},
    "28": {"레포츠", "관광지", "올레길", "오름", "해변"},
    "38": {"쇼핑", "시장"}, "39": {"맛집", "카페"},
}
VISIT_CATEGORIES = {
    "관광지": {"관광지", "오름", "해변", "박물관", "문화시설", "레포츠", "올레길"},
    "음식점": {"맛집", "카페"}, "쇼핑": {"쇼핑", "시장"}, "숙박": {"숙박"},
}


class _PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.blocked = [], [], []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "template", "iframe", "object", "svg", "math"}:
            self.blocked.append(tag)
        if self.blocked:
            return
        if tag in {"br", "p", "div", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")
        if tag == "a" and dict(attrs).get("href"):
            self.links.append(dict(attrs)["href"])

    def handle_endtag(self, tag):
        if self.blocked:
            if tag == self.blocked[-1]:
                self.blocked.pop()
            return
        if tag in {"p", "div", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(data)


def _decoded(value):
    for _ in range(3):
        decoded = unescape(value)
        if decoded == value:
            break
        value = decoded
    return value


def _diagnose(diagnostics, field, limit, code="over_limit"):
    if diagnostics is not None and field and len(diagnostics) < 40:
        item = {"field": field, "code": code, "limit": limit}
        if item not in diagnostics:
            diagnostics.append(item)


def _text(value, limit=1000, *, diagnostics=None, field=None):
    if value is None or isinstance(value, (dict, list)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    value = ("true" if value else "false") if isinstance(value, bool) else str(value)
    if len(value) > 64000:
        _diagnose(diagnostics, field, limit)
        return None
    value = _decoded(value)
    if "<" in value:
        parser = _PlainHTML()
        parser.feed(value)
        parser.close()
        value = "".join(parser.parts)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    value = "\n".join(re.sub(r"[^\S\n]+", " ", line).strip() for line in value.splitlines())
    value = re.sub(r"\n{3,}", "\n\n", value).strip()
    try:
        length = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        _diagnose(diagnostics, field, limit, "invalid_text")
        return None
    if length > limit:
        _diagnose(diagnostics, field, limit)
        return None
    return value or None


def _url(value):
    if not isinstance(value, str):
        return None
    value = unescape(value.strip())
    if len(value) > 2048 or not re.match(r"^https?://", value, re.I) or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower().rstrip(".")
        if not host or parts.username or parts.password or "." not in host or host.endswith((".localhost", ".local", ".internal")):
            return None
        _ = parts.port
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        private = {
            "servicekey", "apikey", "key", "accesstoken", "token", "secret", "clientsecret",
            "password", "auth", "authtoken", "authkey", "authorization", "authentication",
            "credential", "credentials", "signature", "awsaccesskeyid", "secretaccesskey",
            "xamzcredential", "xamzsignature", "xamzsecuritytoken",
        }
        if any(re.sub(r"[_-]", "", key).casefold() in private for key, _ in parse_qsl(parts.query)):
            return None
    except ValueError:
        return None
    return value


def _website(value):
    if not isinstance(value, str) or len(value) > 16000:
        return None
    parser = _PlainHTML()
    parser.feed(_decoded(value))
    for href in parser.links:
        safe = _url(href)
        if safe:
            return safe
    return _url(_text(value, 2048))


def _tourapi_source_url(*values):
    for value in values:
        url = _url(value)
        if url:
            host = urlsplit(url).hostname.lower().rstrip(".")
            if any(host == domain or host.endswith("." + domain)
                   for domain in ("visitkorea.or.kr", "knto.or.kr", "data.go.kr")):
                return url
    return "https://api.visitkorea.or.kr/"


def _number(value, minimum, maximum):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) and minimum <= number <= maximum else None


def tourapi_items(payload):
    """Accept an API envelope, item list, one raw item, or an empty value."""
    if payload is None or payload == "" or payload == {}:
        return []
    if isinstance(payload, list):
        if not all(isinstance(item, dict) for item in payload):
            raise ValueError("TourAPI items must be objects")
        return list(payload)
    if not isinstance(payload, dict):
        raise ValueError("Invalid TourAPI response shape")
    if "response" not in payload:
        return [payload]
    response = payload["response"]
    if not isinstance(response, dict):
        raise ValueError("Invalid TourAPI response")
    code = response.get("header", {}).get("resultCode")
    if code is not None and str(code) not in {"0000", "00", "0"}:
        raise ValueError("TourAPI reported an error")
    body = response.get("body") or {}
    items = body.get("items") or {}
    return tourapi_items(items.get("item") if isinstance(items, dict) else items)


def visitjeju_items(payload):
    if isinstance(payload, list):
        if not all(isinstance(item, dict) for item in payload):
            raise ValueError("VisitJeju items must be objects")
        return list(payload)
    if not isinstance(payload, dict):
        raise ValueError("Invalid VisitJeju response shape")
    if "items" not in payload and "contentsid" in payload:
        return [payload]
    if str(payload.get("result")) != "200":
        raise ValueError("VisitJeju reported an error")
    return visitjeju_items(payload.get("items") or [])


def _one(payload):
    rows = tourapi_items(payload)
    if len(rows) > 1:
        raise ValueError("Expected one TourAPI identity")
    return rows[0] if rows else {}


def _provider_id(item, provider):
    value = item.get("contentid" if provider == "tourapi" else "contentsid")
    if isinstance(value, bool) or value is None:
        raise ValueError("Missing provider identity")
    value = str(value).strip()
    pattern = r"\d{1,32}" if provider == "tourapi" else r"[A-Za-z0-9_-]{1,100}"
    if not re.fullmatch(pattern, value):
        raise ValueError("Invalid provider identity")
    return value


def _metadata(locale, fetched_at):
    if locale not in {"ko", "en"}:
        raise ValueError("Provider locale must be ko or en")
    if not isinstance(fetched_at, str) or len(fetched_at) > 40:
        raise ValueError("Caller must supply fetched_at")
    try:
        datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Invalid fetched_at") from exc


def _fact(key, ko, en, value, diagnostics=None):
    fields = {
        "key": _text(key, 80, diagnostics=diagnostics, field="facts.key"),
        "label_ko": _text(ko, 120, diagnostics=diagnostics, field=f"facts.{key}.label_ko"),
        "label_en": _text(en, 120, diagnostics=diagnostics, field=f"facts.{key}.label_en"),
        "value": _text(value, 1000, diagnostics=diagnostics, field=f"facts.{key}.value"),
    }
    return fields if all(item is not None for item in fields.values()) else None


def _visitor_fact(key, ko, en, value, locale, diagnostics=None):
    fact = _fact(key, ko, en, value, diagnostics)
    availability = key.startswith(("chkbabycarriage", "chkcreditcard", "chkpet"))
    reservation = key in {"reservation", "reservationfood"}
    if fact is None or not (availability or reservation or key == "kidsfacility"):
        return fact
    fact["label_ko"] = ko.removesuffix("(제공처 값)")
    fact["label_en"] = en.removesuffix(" (provider value)")
    code = fact["value"].casefold()
    if code not in {"0", "1", "false", "true"}:
        return fact
    positive = code in {"1", "true"}
    if reservation:
        # A bare yes/no says neither "required" nor "not required".
        wording = {
            "ko": ("제공처 표기: 아니요 · 예약 조건 확인 필요", "제공처 표기: 예 · 예약 조건 확인 필요"),
            "en": ("Provider reports no; check reservation conditions", "Provider reports yes; check reservation conditions"),
        }
    elif key == "kidsfacility":
        wording = {"ko": ("자료상 없음", "자료상 있음"), "en": ("Reported absent", "Reported present")}
    else:
        wording = {"ko": ("자료상 불가", "자료상 가능"), "en": ("Reported unavailable", "Reported available")}
    fact["value"] = wording[locale][positive]
    return fact


def _photos(listing, common, images, diagnostics=None):
    candidates = list(images)
    for item in (listing, common):
        if item.get("firstimage"):
            candidates.append({
                "originimgurl": item["firstimage"], "smallimageurl": item.get("firstimage2"),
                "cpyrhtDivCd": item.get("cpyrhtDivCd"), "credit": item.get("credit"),
            })
    grouped = {}
    for image in candidates:
        origin = _url(image.get("originimgurl"))
        if origin:
            grouped.setdefault(origin, []).append(image)
    photos = []
    for origin, rows in grouped.items():
        declarations = {str(row["cpyrhtDivCd"]) for row in rows if row.get("cpyrhtDivCd")}
        # Conflicting declarations on the SAME image are not resolved by taking
        # whichever row happened to grant broader rights.
        if len(declarations) != 1:
            continue
        declaration = next(iter(declarations))
        license_ = PHOTO_LICENSES.get(declaration)
        if not license_:
            continue
        own = next(row for row in rows if row.get("cpyrhtDivCd") == declaration)
        photos.append({
            "url": origin, "origin_url": origin,
            "thumb_url": None if license_ == "KOGL-3" else _url(own.get("smallimageurl")),
            "credit": _text(own.get("credit"), 300) or "한국관광공사",
            "license": license_, "source": "tourapi",
        })
    if len(photos) > 8:
        _diagnose(diagnostics, "photos", 8)
    return photos[:8]


def parse_tourapi(listing, common, intro, info_items, image_items, *, locale="ko", fetched_at):
    """Parse related detailCommon2/Intro2/Info2/Image2 responses or raw items.

    Nonempty common fields take precedence over the listing for the same ID.
    Dedicated infocenter fields may supply a phone; overview/notes never do.
    """
    _metadata(locale, fetched_at)
    listing, common, intro = _one(listing), _one(common), _one(intro)
    infos, images = tourapi_items(info_items), tourapi_items(image_items)
    identity = _provider_id(listing or common, "tourapi")
    content_type = str(common.get("contenttypeid") or listing.get("contenttypeid") or "")
    if content_type not in INTRO_FIELDS:
        raise ValueError("Unsupported TourAPI content type")
    for row in [listing, common, intro, *infos, *images]:
        if row.get("contentid") not in (None, "") and _provider_id(row, "tourapi") != identity:
            raise ValueError("TourAPI detail identities disagree")
        if row.get("contenttypeid") not in (None, "") and str(row["contenttypeid"]) != content_type:
            raise ValueError("TourAPI detail content types disagree")
    merged = dict(listing)
    merged.update({key: value for key, value in common.items() if value is not None and value != ""})
    diagnostics = []
    title = _text(merged.get("title"), 256)
    if not title:
        raise ValueError("Missing or over-limit TourAPI title")
    website = _website(merged.get("homepage"))
    address_parts = [_text(merged.get(key), 1000, diagnostics=diagnostics, field="address")
                     for key in ("addr1", "addr2")]
    address = None if diagnostics else _text(" ".join(part for part in address_parts if part),
                                             1000, diagnostics=diagnostics, field="address")
    contacts = {"12": "infocenter", "14": "infocenterculture", "25": "infocentertourcourse",
                "28": "infocenterleports", "38": "infocentershopping", "39": "infocenterfood"}
    facts = []
    for key, ko, en in INTRO_FIELDS[content_type]:
        fact = _visitor_fact(key, ko, en, intro.get(key), locale, diagnostics)
        if fact:
            facts.append(fact)
    info_labels = {
        "이용요금": "Admission fees", "입장료": "Admission fees", "주차요금": "Parking fees",
        "화장실": "Restrooms", "외국어안내서비스": "Foreign-language guide service",
        "한국어안내서비스": "Korean-language guide service", "장애인편의시설": "Accessibility information",
    }
    for index, row in enumerate(infos):
        label = _text(row.get("infoname"), 120, diagnostics=diagnostics, field=f"facts.info.{index}.label_ko")
        if label:
            if _norm(label) == "입장료":
                label = "입장료"
            fact = _fact(f"info.{index}", label, info_labels.get(_norm(label), "Additional information"), row.get("infotext"), diagnostics)
            if fact:
                facts.append(fact)
        if content_type == "25":
            for key, ko, en in [
                ("subname", "코스 경유지", "Course stop"), ("subdetailoverview", "경유지 소개", "Stop description"),
                ("subnum", "경유지 순서", "Stop order"), ("subcontentid", "경유지 정보 ID", "Stop content ID"),
            ]:
                fact = _fact(f"info.{index}.{key}", ko, en, row.get(key), diagnostics)
                if fact:
                    facts.append(fact)
    if len(facts) > 40:
        _diagnose(diagnostics, "facts", 40)
    record = {
        "provider": "tourapi", "provider_id": identity, "locale": locale,
        "source_url": _tourapi_source_url(common.get("source_url"), listing.get("source_url")),
        "fetched_at": fetched_at, "title": title, "address": address,
        "phone": _text(merged.get("tel"), 120, diagnostics=diagnostics, field="phone")
                 or _text(intro.get(contacts[content_type]), 120, diagnostics=diagnostics, field="phone"),
        "website": website, "latitude": _number(merged.get("mapy"), -90, 90),
        "longitude": _number(merged.get("mapx"), -180, 180),
        "overview": _text(merged.get("overview"), 8000, diagnostics=diagnostics, field="overview"), "facts": facts[:40],
        "photos": _photos(listing, common, images, diagnostics),
    }
    if diagnostics:
        record["diagnostics"] = diagnostics
    return record


def parse_visitjeju(item, *, locale="ko", fetched_at):
    """Parse one VisitJeju record; keep tags as text, not amenity assertions."""
    _metadata(locale, fetched_at)
    if not isinstance(item, dict):
        raise ValueError("VisitJeju item must be an object")
    identity = _provider_id(item, "visitjeju")
    diagnostics = []
    title = _text(item.get("title"), 256)
    if not title:
        raise ValueError("Missing or over-limit VisitJeju title")
    facts = []
    for key, ko, en in [
        ("address", "지번 주소", "Lot-number address"), ("roadaddress", "도로명 주소", "Road address"),
        ("postcode", "우편번호", "Postal code"), ("tag", "제공처 태그", "Provider tags"),
        ("alltag", "제공처 전체 태그", "All provider tags"),
    ]:
        fact = _fact(key, ko, en, item.get(key), diagnostics)
        if fact:
            facts.append(fact)
    record = {
        "provider": "visitjeju", "provider_id": identity, "locale": locale,
        "source_url": f"https://www.visitjeju.net/{'kr' if locale == 'ko' else 'en'}/detail/view?contentsid={quote(identity, safe='')}",
        "fetched_at": fetched_at, "title": title,
        "address": _text(item.get("roadaddress"), 1000, diagnostics=diagnostics, field="address")
                   or _text(item.get("address"), 1000, diagnostics=diagnostics, field="address"),
        "phone": _text(item.get("phoneno"), 120, diagnostics=diagnostics, field="phone"), "website": _website(item.get("homepage")),
        "latitude": _number(item.get("latitude"), -90, 90), "longitude": _number(item.get("longitude"), -180, 180),
        "overview": _text(item.get("introduction"), 8000, diagnostics=diagnostics, field="overview"), "facts": facts, "photos": [],
    }
    if diagnostics:
        record["diagnostics"] = diagnostics
    return record


def _norm(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", value)).casefold()


_UNESCO = {_norm(value) for value in (
    "유네스코 세계자연유산", "유네스코 세계문화유산", "유네스코 세계유산", "유네스코 세계지질공원",
    "UNESCO World Natural Heritage", "UNESCO World Heritage", "UNESCO World Heritage Site", "UNESCO Global Geopark",
)}
_ALIASES = {
    _norm(alias): _norm(name)
    for name, aliases in (
        ("성산일출봉", ("Seongsan Ilchulbong", "Seongsan Ilchulbong Peak")),
        ("비자림", ("Bijarim Forest", "Bija Forest", "제주 비자림")),
        ("한라산국립공원", ("Hallasan National Park", "Halla Mountain National Park")),
        ("협재해수욕장", ("Hyeopjae Beach", "Hyupjae Beach")),
        ("제주국제공항", ("Jeju International Airport",)),
    )
    for alias in aliases
}


def _name_key(name):
    name = _text(name, 300) or ""
    for _ in range(2):
        suffix = re.search(r"\s*(?:\[([^\[\]]+)\]|\(([^()]+)\))\s*$", name)
        if not suffix or _norm(suffix.group(1) or suffix.group(2)) not in _UNESCO:
            break
        name = name[:suffix.start()]
    return _norm(name)


def _name_method(place, title):
    if not isinstance(title, str) or not _text(title, 300):
        return None
    raw = _norm(_text(title, 300))
    for key in ("name", "name_en"):
        name = _text(place.get(key), 300)
        if name and _norm(name) == raw:
            return "exact_name" if key == "name" else "exact_name_en"
    target = _name_key(title)
    if not target:
        return None
    for key in ("name", "name_en"):
        name = _text(place.get(key), 300)
        if not name:
            continue
        canonical = _name_key(name)
        if canonical == target:
            return "unesco_suffix"
        if _ALIASES.get(canonical, canonical) == _ALIASES.get(target, target):
            return "known_landmark_alias"
    return None


def _categories(record, provider):
    if provider == "tourapi":
        return TOUR_CATEGORIES.get(str(record.get("contenttypeid", "")))
    contents = record.get("contentscd")
    if isinstance(contents, dict):
        label = contents.get("label")
        if label in VISIT_CATEGORIES:
            return VISIT_CATEGORIES[label]
        english = {"attractions": "관광지", "touristattractions": "관광지", "restaurants": "음식점",
                   "restaurant": "음식점", "shopping": "쇼핑", "accommodation": "숙박", "accommodations": "숙박"}
        if isinstance(label, str) and _norm(label) in english:
            return VISIT_CATEGORIES[english[_norm(label)]]
        contents = contents.get("value")
    # Only c1 is independently established by the supplied fixture. Other
    # categories use their provided label instead of guessing a code assignment.
    return VISIT_CATEGORIES["관광지"] if contents == "c1" else None


def _distance(lat1, lng1, lat2, lng2):
    rad = math.pi / 180
    a = math.sin((lat2 - lat1) * rad / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin((lng2 - lng1) * rad / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(min(1, max(0, a))))


def _decide(place, records, provider):
    if provider not in {"tourapi", "visitjeju"}:
        raise ValueError("Unsupported provider")
    empty = {"reason": "no_exact_name", "candidate_ids": [], "method": None, "distance_m": None}
    if not isinstance(place, dict) or not isinstance(records, list) or not _text(place.get("name"), 300):
        return None, {**empty, "reason": "invalid_input"}
    lat, lng = _number(place.get("lat"), -90, 90), _number(place.get("lng"), -180, 180)
    if lat is None or lng is None:
        return None, {**empty, "reason": "invalid_coordinates"}
    radius = SAMPLE_RADIUS_M if place.get("source") == "sample" else OSM_RADIUS_M
    eligible, signatures = {}, {}
    named = typed = compatible = coordinates = within_radius = False
    conflict = False
    for record in records:
        if not isinstance(record, dict):
            continue
        method = _name_method(place, record.get("title"))
        if not method:
            continue
        named = True
        categories = _categories(record, provider)
        typed = typed or bool(categories)
        if not categories or place.get("category") not in categories:
            continue
        compatible = True
        rlat = _number(record.get("mapy" if provider == "tourapi" else "latitude"), -90, 90)
        rlng = _number(record.get("mapx" if provider == "tourapi" else "longitude"), -180, 180)
        if rlat is None or rlng is None:
            continue
        coordinates = True
        distance = _distance(lat, lng, rlat, rlng)
        if distance > radius:
            continue
        within_radius = True
        try:
            identity = _provider_id(record, provider)
        except ValueError:
            continue
        signature = (_name_key(record["title"]), tuple(sorted(categories)), rlat, rlng)
        if identity in signatures and signatures[identity] != signature:
            conflict = True
        signatures[identity] = signature
        if identity not in eligible:
            eligible[identity] = {"record": record, "match": {"method": method, "distance_m": distance}}
    candidate_ids = sorted(eligible)
    if len(eligible) > 1 or conflict:
        return None, {**empty, "reason": "ambiguous", "candidate_ids": candidate_ids}
    if eligible:
        selected = next(iter(eligible.values()))
        return selected, {"reason": "unique_compatible_candidate", "candidate_ids": candidate_ids, **selected["match"]}
    if not named:
        reason = "no_exact_name"
    elif not typed:
        reason = "unsupported_category"
    elif not compatible:
        reason = "category_mismatch"
    elif not coordinates:
        reason = "invalid_coordinates"
    else:
        reason = "invalid_provider_id" if within_radius else "outside_radius"
    return None, {**empty, "reason": reason}


def match_place(place: dict, records: list[dict], provider: str) -> dict | None:
    """Match one canonical place to one provider entry; never pick among branches."""
    return _decide(place, records, provider)[0]


def explain_match(place: dict, records: list[dict], provider: str) -> dict:
    """Same pure decision with explicit failure/ambiguity reason; no probability."""
    return _decide(place, records, provider)[1]
