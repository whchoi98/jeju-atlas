"""Pure provider parsing/matching regressions; no authenticated provider calls."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts" / "place_detail_sources.py"
sources = None
if MODULE.is_file():
    spec = importlib.util.spec_from_file_location("place_detail_sources", MODULE)
    sources = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sources)

FETCHED = "2026-09-10T10:00:00+00:00"


def envelope(*items):
    return {"response": {"header": {"resultCode": "0000"}, "body": {"items": {"item": list(items)}}}}


def place(**changes):
    result = {"id": "poi_test", "name": "비자림", "name_en": "Bijarim Forest",
              "category": "관광지", "source": "sample", "lat": 33.45, "lng": 126.5,
              "address": "기존 원자료 주소"}
    result.update(changes)
    return result


def listing(**changes):
    result = {"contentid": "123", "contenttypeid": "12", "title": "비자림",
              "mapx": "126.5", "mapy": "33.454", "addr1": "제주특별자치도", "addr2": "공식 주소"}
    result.update(changes)
    return result


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(sources, "Pure provider helpers must be implemented")

    def test_tourapi_combines_related_details_without_losing_source_notes(self):
        original = listing()
        common = envelope({"contentid": "123", "contenttypeid": "12", "title": "비자림",
                           "overview": "<p>숲길 <b>안내</b></p><script>bad()</script>",
                           "homepage": '<a href="https://venue.example/visit">홈페이지</a>',
                           "tel": "064-123-4567", "addr1": "공식 도로명", "addr2": "10"})
        intro = envelope({"contentid": "123", "contenttypeid": "12",
                          "usetime": "09:00~18:00<br>입장 마감 17:00",
                          "restdate": "매주 월요일", "parking": "가능", "chkbabycarriage": "0"})
        info = envelope({"contentid": "123", "serialnum": "0", "infoname": "이용 요금", "infotext": "<b>성인</b> 3,000원"})
        saved = copy.deepcopy((original, common, intro, info))
        result = sources.parse_tourapi(original, common, intro, info, [], fetched_at=FETCHED)
        self.assertEqual(result["provider"], "tourapi")
        self.assertEqual(result["provider_id"], "123")
        self.assertEqual(result["locale"], "ko")
        self.assertEqual(result["fetched_at"], FETCHED)
        self.assertEqual(result["title"], "비자림")
        self.assertEqual(result["address"], "공식 도로명 10")
        self.assertEqual(result["phone"], "064-123-4567")
        self.assertEqual(result["website"], "https://venue.example/visit")
        self.assertEqual(result["source_url"], "https://api.visitkorea.or.kr/")
        self.assertEqual((result["latitude"], result["longitude"]), (33.454, 126.5))
        self.assertEqual(result["overview"], "숲길 안내")
        facts = {f["key"]: f for f in result["facts"]}
        self.assertEqual(facts["usetime"]["value"], "09:00~18:00\n입장 마감 17:00")
        self.assertEqual(facts["restdate"]["value"], "매주 월요일")
        self.assertEqual(facts["chkbabycarriage"]["value"], "자료상 불가")
        self.assertTrue(any(f["label_ko"] == "이용 요금" and f["value"] == "성인 3,000원" for f in result["facts"]))
        self.assertTrue(all(f["label_ko"] and f["label_en"] for f in result["facts"]))
        self.assertNotIn("hours_week", result)
        self.assertNotIn("open_now", result)
        self.assertNotIn("match", result, "The caller attaches the independent match decision")
        self.assertEqual((original, common, intro, info), saved)

    def test_tourapi_source_is_publisher_and_homepage_stays_separate(self):
        for source_url in [
            None, "https://www.visitjeju.net/kr", "https://venue.example/visit",
            "https://visitkorea.or.kr.evil.example/",
            "https://api.visitkorea.or.kr/?serviceKey=not-a-real-secret",
            "https://api.visitkorea.or.kr/?authKey=not-a-real-secret",
        ]:
            with self.subTest(source_url=source_url):
                result = sources.parse_tourapi(
                    listing(), {"source_url": source_url, "homepage": '<a href="https://www.visitjeju.net/kr">공식 안내</a>'},
                    None, [], [], fetched_at=FETCHED,
                )
                self.assertEqual(result["source_url"], "https://api.visitkorea.or.kr/")
                self.assertEqual(result["website"], "https://www.visitjeju.net/kr")
                self.assertNotIn("not-a-real-secret", json.dumps(result))
        for publisher in ["https://korean.visitkorea.or.kr/detail/info", "https://knto.or.kr/", "https://www.data.go.kr/data/123"]:
            with self.subTest(publisher=publisher):
                result = sources.parse_tourapi(listing(source_url=publisher), None, None, [], [], fetched_at=FETCHED)
                self.assertEqual(result["source_url"], publisher)

    def test_node_contract_limits_skip_oversized_fields_with_diagnostics(self):
        result = sources.parse_tourapi(
            listing(title="가" * 256, addr1="가" * 600, addr2="나" * 401, tel="1" * 121),
            {"overview": "설명" * 4001},
            {"usetime": "가" * 1001, "restdate": "월요일"},
            [{"infoname": "가" * 121, "infotext": "생략할 항목"},
             {"infoname": "입 장 료", "infotext": "무료"},
             {"infoname": "긴 값", "infotext": "🙂" * 501}],
            [{"originimgurl": f"https://images.example/{index}.jpg", "cpyrhtDivCd": "Type3"} for index in range(10)],
            fetched_at=FETCHED,
        )
        self.assertEqual(result["title"], "가" * 256)
        for field in ["phone", "address", "overview"]:
            self.assertIsNone(result[field])
        self.assertEqual({f["key"]: f["value"] for f in result["facts"]}, {"restdate": "월요일", "info.1": "무료"})
        self.assertEqual(len(result["photos"]), 8)
        self.assertTrue(all(p["thumb_url"] is None and p["url"] == p["origin_url"] for p in result["photos"]))
        diagnostics = {d["field"]: d for d in result["diagnostics"]}
        for field, limit in {
            "phone": 120, "address": 1000, "overview": 8000, "facts.usetime.value": 1000,
            "facts.info.0.label_ko": 120, "facts.info.2.value": 1000, "photos": 8,
        }.items():
            self.assertEqual(diagnostics[field], {"field": field, "code": "over_limit", "limit": limit})
        self.assertTrue(all(set(d) == {"field", "code", "limit"} for d in result["diagnostics"]))
        self.assert_node_accepts([result])

    def test_visitjeju_limits_and_valid_boundary_values_match_node(self):
        result = sources.parse_visitjeju({
            "contentsid": "CNTS_BOUNDS", "title": "가" * 256, "phoneno": "1" * 121,
            "roadaddress": "가" * 1001, "introduction": "가" * 8001,
            "alltag": "가" * 1001, "tag": "가" * 1000,
        }, fetched_at=FETCHED)
        for field in ["phone", "address", "overview"]:
            self.assertIsNone(result[field])
        self.assertEqual([f["key"] for f in result["facts"]], ["tag"])
        self.assertTrue(result["diagnostics"])
        valid = sources.parse_tourapi(
            listing(title="🙂" * 128, addr1="가" * 1000, addr2="", tel="1" * 120),
            {"overview": "가" * 8000}, {"usetime": "가" * 1000},
            [{"infoname": "가" * 120, "infotext": "🙂" * 500}], [], fetched_at=FETCHED,
        )
        self.assertEqual(len(valid["phone"]), 120)
        self.assertEqual(len(valid["address"]), 1000)
        self.assertEqual(len(valid["overview"]), 8000)
        self.assertEqual(len(valid["facts"]), 2)
        self.assertNotIn("diagnostics", valid)
        self.assert_node_accepts([result, valid])
        for title in ["가" * 257, "🙂" * 129]:
            with self.subTest(title_length=len(title)):
                with self.assertRaisesRegex(ValueError, "title"):
                    sources.parse_tourapi(listing(title=title), None, None, [], [], fetched_at=FETCHED)
                with self.assertRaisesRegex(ValueError, "title"):
                    sources.parse_visitjeju({"contentsid": "CNTS_LONG", "title": title}, fetched_at=FETCHED)

    def assert_node_accepts(self, records):
        node = Path("/tmp/jeju-node24/bin/node")
        if not node.is_file():
            return  # Python bounds still run where the optional Node runtime is absent.
        rows = [dict(record, match={"method": "normalized_exact", "distance_m": 0}) for record in records]
        script = """
            import { readFileSync } from 'node:fs';
            import { normalizeOfficialDetails } from './server/official-details.mjs';
            const rows = JSON.parse(readFileSync(0, 'utf8'));
            const result = normalizeOfficialDetails(rows, { now: Date.parse('2026-09-10T12:00:00Z') });
            if (result.length !== rows.length) throw new Error('Provider rows were lost');
        """
        completed = subprocess.run([str(node), "--input-type=module", "-e", script],
                                   input=json.dumps(rows), text=True, cwd=ROOT,
                                   capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_type_specific_intro_fields_are_preserved_for_all_requested_types(self):
        cases = {
            "12": {"usetime": "09:00~17:00", "restdate": "월요일", "expagerange": "만 7세 이상"},
            "14": {"usetimeculture": "10:00~18:00", "restdateculture": "월요일", "usefee": "무료", "parkingculture": "있음", "chkbabycarriageculture": "없음"},
            "25": {"distance": "12km", "taketime": "4시간", "theme": "해안 여행"},
            "28": {"usetimeleports": "09:00~18:00", "usefeeleports": "15,000원", "parkingleports": "가능", "reservation": "예약 필수"},
            "38": {"opentime": "10:00~20:00", "restdateshopping": "매주 화요일", "saleitem": "공예품", "restroom": "있음"},
            "39": {"opentimefood": "11:00~21:00", "restdatefood": "수요일", "firstmenu": "고기국수", "treatmenu": "고기국수 / 멸치국수", "kidsfacility": "0"},
        }
        for content_type, fields in cases.items():
            with self.subTest(content_type=content_type):
                result = sources.parse_tourapi(listing(contenttypeid=content_type), None, fields, [], [], fetched_at=FETCHED)
                parsed = {fact["key"]: fact["value"] for fact in result["facts"]}
                for key, value in fields.items():
                    self.assertEqual(parsed[key], "자료상 없음" if key == "kidsfacility" and value == "0" else value)

    def test_machine_heritage_flags_are_not_visitor_facts(self):
        result = sources.parse_tourapi(
            listing(), None,
            {"heritage1": "0", "heritage2": "1", "heritage3": False, "usetime": "09:00~18:00", "parking": "가능"},
            [], [], fetched_at=FETCHED,
        )
        facts = {f["key"]: f["value"] for f in result["facts"]}
        self.assertFalse(any(key.startswith("heritage") for key in facts))
        self.assertEqual(facts["usetime"], "09:00~18:00")
        self.assertEqual(facts["parking"], "가능")

    def test_admission_label_spacing_is_cleaned_without_rewriting_fees(self):
        result = sources.parse_tourapi(
            listing(), None, None,
            [{"infoname": "입 장 료", "infotext": "어린이 0원"},
             {"infoname": "이용 요금", "infotext": "성인 3,000원"}],
            [], fetched_at=FETCHED,
        )
        self.assertEqual(result["facts"][0], {
            "key": "info.0", "label_ko": "입장료", "label_en": "Admission fees", "value": "어린이 0원",
        })
        self.assertEqual(result["facts"][1]["label_ko"], "이용 요금")

    def test_operational_flags_are_readable_and_negative_reservation_is_not_a_policy_claim(self):
        for negative in [False, 0, "0", "false"]:
            with self.subTest(negative=negative):
                result = sources.parse_tourapi(
                    listing(contenttypeid="39"), None,
                    {"reservationfood": negative, "kidsfacility": "0", "chkcreditcardfood": "1"},
                    [], [], fetched_at=FETCHED,
                )
                facts = {f["key"]: f for f in result["facts"]}
                self.assertEqual(facts["reservationfood"]["value"], "제공처 표기: 아니요 · 예약 조건 확인 필요")
                self.assertNotIn("예약 불필요", facts["reservationfood"]["value"])
                self.assertNotIn("예약 불가", facts["reservationfood"]["value"])
                self.assertEqual(facts["kidsfacility"]["value"], "자료상 없음")
                self.assertEqual(facts["chkcreditcardfood"]["value"], "자료상 가능")
                self.assertEqual(facts["kidsfacility"]["label_ko"], "어린이 놀이시설")
        result = sources.parse_tourapi(
            listing(contenttypeid="39"), None, {"reservationfood": "전화 예약 필수", "kidsfacility": None},
            [], [], fetched_at=FETCHED,
        )
        self.assertEqual({f["key"]: f["value"] for f in result["facts"]}, {"reservationfood": "전화 예약 필수"})
        english = sources.parse_tourapi(
            listing(contenttypeid="39"), None, {"reservationfood": False, "kidsfacility": "0"},
            [], [], locale="en", fetched_at=FETCHED,
        )
        self.assertEqual({f["key"]: f["value"] for f in english["facts"]}, {
            "kidsfacility": "Reported absent",
            "reservationfood": "Provider reports no; check reservation conditions",
        })

    def test_missing_values_do_not_become_phone_hours_or_weekday_claims(self):
        result = sources.parse_tourapi(
            listing(mapx="", mapy=""), {"contentid": "123", "overview": "문의 064-111-2222"},
            {"restdate": "연중무휴", "parking": "", "kidsfacility": None},
            [], [], fetched_at=FETCHED,
        )
        self.assertIsNone(result["phone"])
        self.assertIsNone(result["website"])
        self.assertIsNone(result["latitude"])
        self.assertIsNone(result["longitude"])
        self.assertEqual(result["source_url"], "https://api.visitkorea.or.kr/")
        self.assertEqual([f["key"] for f in result["facts"] if f["key"] == "parking"], [])
        self.assertNotIn("hours_week", result)

    def test_mismatched_provider_ids_and_provider_errors_are_rejected(self):
        for component in ["common", "intro", "info", "images"]:
            with self.subTest(component=component):
                args = {"common": None, "intro": None, "info": [], "images": []}
                args[component] = envelope({"contentid": "999", "contenttypeid": "12", "title": "다른 장소"})
                with self.assertRaises(ValueError):
                    sources.parse_tourapi(listing(), args["common"], args["intro"], args["info"], args["images"], fetched_at=FETCHED)
        with self.assertRaises(ValueError):
            sources.tourapi_items({"response": {"header": {"resultCode": "30", "resultMsg": "Denied"}}})
        with self.assertRaises(ValueError):
            sources.visitjeju_items({"result": "403", "items": []})

    def test_photos_use_each_images_license_and_keep_kogl3_original(self):
        images = [
            {"contentid": "123", "originimgurl": "https://images.example/one.jpg", "smallimageurl": "https://images.example/one-thumb.jpg", "cpyrhtDivCd": "Type1"},
            {"contentid": "123", "originimgurl": "http://images.example/three.jpg", "smallimageurl": "https://images.example/three-thumb.webp", "cpyrhtDivCd": "Type3"},
            {"contentid": "123", "originimgurl": "https://images.example/two.jpg", "cpyrhtDivCd": "Type2"},
            {"contentid": "123", "originimgurl": "https://images.example/four.jpg", "cpyrhtDivCd": "Type4"},
            {"contentid": "123", "originimgurl": "https://images.example/unknown.jpg"},
            {"contentid": "123", "originimgurl": "javascript:alert(1)", "cpyrhtDivCd": "Type1"},
        ]
        result = sources.parse_tourapi(listing(cpyrhtDivCd="Type1"), None, None, [], images, fetched_at=FETCHED)
        self.assertEqual([p["license"] for p in result["photos"]], ["KOGL-1", "KOGL-3"])
        one, three = result["photos"]
        self.assertEqual(one["thumb_url"], "https://images.example/one-thumb.jpg")
        self.assertEqual(three["url"], "http://images.example/three.jpg")
        self.assertEqual(three["origin_url"], three["url"])
        self.assertIsNone(three["thumb_url"])
        self.assertTrue(all(p["credit"] == "한국관광공사" and p["source"] == "tourapi" for p in result["photos"]))

    def test_representative_photo_license_is_not_transferred_to_another_image(self):
        result = sources.parse_tourapi(
            listing(firstimage="https://images.example/listing.jpg", cpyrhtDivCd="Type1"),
            {"contentid": "123", "firstimage": "https://images.example/common-without-license.jpg"},
            None, [], [{"contentid": "123", "originimgurl": "https://images.example/detail-without-license.jpg"}],
            fetched_at=FETCHED,
        )
        self.assertEqual([p["url"] for p in result["photos"]], ["https://images.example/listing.jpg"])
        conflicting = sources.parse_tourapi(
            listing(firstimage="https://images.example/same.jpg", cpyrhtDivCd="Type1"),
            None, None, [], [{"originimgurl": "https://images.example/same.jpg", "cpyrhtDivCd": "Type4"}],
            fetched_at=FETCHED,
        )
        self.assertEqual(conflicting["photos"], [])

    def test_visitjeju_preserves_addresses_and_does_not_serve_unlicensed_rep_photo(self):
        item = {
            "contentsid": "CNTS_123", "contentscd": {"value": "c1", "label": "관광지"},
            "title": "비자림", "introduction": "<p>제주 <strong>숲길</strong></p>",
            "address": "지번 주소 1", "roadaddress": "도로명 주소 2",
            "phoneno": "064-000-0000", "latitude": 33.48, "longitude": 126.8,
            "alltag": "유모차,장애인,주차", "repPhoto": {"photoid": {"imgpath": "https://images.example/vsj.webp"}},
        }
        before = copy.deepcopy(item)
        result = sources.parse_visitjeju(item, locale="ko", fetched_at=FETCHED)
        self.assertEqual(result["provider_id"], "CNTS_123")
        self.assertEqual(result["source_url"], "https://www.visitjeju.net/kr/detail/view?contentsid=CNTS_123")
        self.assertEqual(result["address"], "도로명 주소 2")
        self.assertEqual(result["overview"], "제주 숲길")
        self.assertEqual(result["phone"], "064-000-0000")
        self.assertIsNone(result["website"])
        self.assertEqual(result["photos"], [])
        facts = {f["key"]: f["value"] for f in result["facts"]}
        self.assertEqual(facts["address"], "지번 주소 1")
        self.assertEqual(facts["roadaddress"], "도로명 주소 2")
        self.assertEqual(facts["alltag"], "유모차,장애인,주차")
        self.assertNotIn("kid_friendly", facts)
        self.assertNotIn("wheelchair", facts)
        self.assertEqual(item, before)

    def test_html_and_unsafe_or_credential_urls_cannot_leak_into_output_links(self):
        result = sources.parse_tourapi(
            listing(),
            {"contentid": "123", "overview": "&lt;script&gt;bad()&lt;/script&gt;<p>안내<img src=x onerror=bad()></p>",
             "homepage": '<a href="javascript:bad()">bad</a><a href="https://venue.example/?serviceKey=not-a-real-secret">private</a>'},
            {"usetime": "<b>09:00~18:00</b><br>휴무 월요일<script>bad()</script>"},
            [], [], fetched_at=FETCHED,
        )
        self.assertEqual(result["overview"], "안내")
        self.assertIsNone(result["website"])
        self.assertNotIn("not-a-real-secret", json.dumps(result))
        self.assertNotIn("bad()", json.dumps(result))
        self.assertEqual(next(f["value"] for f in result["facts"] if f["key"] == "usetime"), "09:00~18:00\n휴무 월요일")

    def test_sample_radius_is_two_km_but_osm_radius_remains_strict_150m(self):
        candidate = listing()
        matched = sources.match_place(place(), [candidate], "tourapi")
        self.assertIs(matched["record"], candidate)
        self.assertGreater(matched["match"]["distance_m"], 400)
        self.assertLess(matched["match"]["distance_m"], 500)
        self.assertIsNone(sources.match_place(place(source="OpenStreetMap"), [candidate], "tourapi"))
        self.assertIsNotNone(sources.match_place(place(source="OpenStreetMap"), [listing(mapy="33.4505")], "tourapi"))
        self.assertIsNone(sources.match_place(place(source="OpenStreetMap"), [listing(mapy="33.45135")], "tourapi"))
        self.assertIsNone(sources.match_place(place(), [listing(mapy="33.468")], "tourapi"))
        self.assertNotIn("confidence", matched["match"])
        self.assertNotIn("reviewed", matched["match"])

    def test_known_aliases_and_whitelisted_unesco_suffixes_match_without_rewriting_names(self):
        for title in ["성산일출봉 [유네스코 세계자연유산]", "Seongsan Ilchulbong Peak", "성산 일출봉"]:
            with self.subTest(title=title):
                canonical = place(name="성산일출봉", name_en="Seongsan Ilchulbong Peak")
                candidate = listing(title=title)
                before = copy.deepcopy((canonical, candidate))
                result = sources.match_place(canonical, [candidate], "tourapi")
                self.assertIsNotNone(result)
                self.assertEqual(result["record"]["title"], title)
                self.assertEqual((canonical, candidate), before)
        self.assertIsNotNone(sources.match_place(place(), [listing(title="Bija Forest")], "tourapi"))

    def test_duplicate_matching_providers_are_ambiguous_even_when_one_is_closer(self):
        first, second = listing(contentid="123"), listing(contentid="456", mapy="33.4505")
        self.assertIsNone(sources.match_place(place(), [first, second], "tourapi"))
        decision = sources.explain_match(place(), [first, second], "tourapi")
        self.assertEqual(decision["reason"], "ambiguous")
        self.assertEqual(decision["candidate_ids"], ["123", "456"])
        self.assertIsNone(decision["distance_m"])
        self.assertIsNotNone(sources.match_place(place(), [first, copy.deepcopy(first)], "tourapi"))

    def test_branch_names_unknowns_and_category_conflicts_never_match_by_substring(self):
        target = place(name="스타벅스 성산일출봉점", name_en=None, category="카페")
        wrong = listing(title="스타벅스 제주공항점", contenttypeid="39")
        self.assertIsNone(sources.match_place(target, [wrong], "tourapi"))
        self.assertIsNone(sources.match_place(place(), [listing(title="비자림 (서울점)")], "tourapi"))
        self.assertIsNone(sources.match_place(place(), [listing(title="비자림 주차장")], "tourapi"))
        self.assertIsNone(sources.match_place(place(), [listing(contenttypeid="39")], "tourapi"))
        self.assertEqual(sources.explain_match(place(), [listing(contenttypeid="39")], "tourapi")["reason"], "category_mismatch")
        self.assertIsNone(sources.match_place(place(), [listing(mapx="NaN")], "tourapi"))
        self.assertIsNone(sources.match_place(place(), [listing(mapy="37.5")], "tourapi"))
        self.assertIsNone(sources.match_place(place(), [], "tourapi"))

    def test_match_diagnostics_do_not_call_missing_identity_or_category_a_distance_failure(self):
        invalid_id = listing()
        del invalid_id["contentid"]
        self.assertIsNone(sources.match_place(place(), [invalid_id], "tourapi"))
        self.assertEqual(sources.explain_match(place(), [invalid_id], "tourapi")["reason"], "invalid_provider_id")
        self.assertEqual(sources.explain_match(place(), [listing(contenttypeid="999")], "tourapi")["reason"], "unsupported_category")

    def test_visitjeju_category_labels_control_compatibility_without_guessing_code_meanings(self):
        item = {"contentsid": "CNTS_123", "title": "비자림", "latitude": 33.454, "longitude": 126.5,
                "contentscd": {"value": "c1", "label": "관광지"}}
        self.assertIsNotNone(sources.match_place(place(), [item], "visitjeju"))
        food = dict(item, contentscd={"value": "c4", "label": "음식점"})
        self.assertIsNone(sources.match_place(place(), [food], "visitjeju"))
        shopping = dict(item, title="동문시장", contentscd={"value": "c3", "label": "쇼핑"})
        self.assertIsNotNone(sources.match_place(place(name="동문시장", name_en=None, category="시장"), [shopping], "visitjeju"))

    def test_real_seongsan_details_preserve_seasons_holidays_contact_and_original_photos(self):
        paths = {part: ROOT / f".local/provider-probes/seongsan-detail{part}2.json"
                 for part in ("Common", "Intro", "Info", "Image")}
        snapshot = ROOT / ".local/reference-catalog.sqlite"
        if not all(p.is_file() for p in [*paths.values(), snapshot]):
            self.skipTest("Optional sanitized Seongsan detail fixtures are not installed")
        before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [*paths.values(), snapshot]}
        raw = {part: json.loads(path.read_text()) for part, path in paths.items()}
        record = sources.tourapi_items(raw["Common"])[0]
        with sqlite3.connect(snapshot.resolve().as_uri() + "?mode=ro&immutable=1", uri=True) as db:
            db.row_factory = sqlite3.Row
            canonical = dict(db.execute("SELECT id,name,name_en,category,source,lat,lng,address FROM places WHERE id = ?", ("poi_0008",)).fetchone())
        original_place = copy.deepcopy(canonical)
        matched = sources.match_place(canonical, [record], "tourapi")
        self.assertIsNotNone(matched)
        self.assertEqual(matched["match"]["method"], "unesco_suffix")
        self.assertGreater(matched["match"]["distance_m"], 150)
        self.assertLess(matched["match"]["distance_m"], 2000)
        parsed = sources.parse_tourapi(record, raw["Common"], raw["Intro"], raw["Info"], raw["Image"], fetched_at=FETCHED)
        self.assertEqual(parsed["provider_id"], "126435")
        self.assertEqual(parsed["title"], "성산일출봉 [유네스코 세계자연유산]")
        self.assertEqual(parsed["phone"], "064-783-0959")
        self.assertEqual(parsed["website"], "https://www.visitjeju.net/kr")
        self.assertEqual(parsed["source_url"], "https://api.visitkorea.or.kr/")
        self.assertEqual((parsed["latitude"], parsed["longitude"]), (33.4580801942, 126.9415003865))
        facts = {f["key"]: f for f in parsed["facts"]}
        self.assertIn("11월~2월", facts["usetime"]["value"])
        self.assertIn("5월~8월", facts["usetime"]["value"])
        self.assertIn("매표 마감", facts["usetime"]["value"])
        self.assertIn("공휴일", facts["restdate"]["value"])
        self.assertNotIn("chkbabycarriage", facts, "Blank is unknown, never 'no'")
        self.assertTrue({"입장료", "주차요금", "화장실", "한국어안내서비스", "외국어안내서비스"}
                        .issubset({f["label_ko"] for f in parsed["facts"]}))
        # Common has a DIFFERENT Type1 representative image. Its license must
        # neither be copied onto nor replace the seven Type3 detail images.
        self.assertEqual(len(parsed["photos"]), 8)
        originals = {r["originimgurl"] for r in sources.tourapi_items(raw["Image"])}
        restricted = [p for p in parsed["photos"] if p["license"] == "KOGL-3"]
        self.assertEqual({p["url"] for p in restricted}, originals)
        self.assertTrue(all(p["thumb_url"] is None and p["origin_url"] == p["url"] for p in restricted))
        representative = [p for p in parsed["photos"] if p["license"] == "KOGL-1"]
        self.assertEqual([p["url"] for p in representative], [record["firstimage"]])
        self.assertEqual(canonical, original_place)
        self.assert_node_accepts([parsed])
        self.assertEqual({str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [*paths.values(), snapshot]}, before)

    def test_sanitized_private_probe_fixtures_and_local_catalog_can_be_read_without_changes(self):
        paths = [ROOT / ".local/provider-probes/tourapi.json", ROOT / ".local/provider-probes/visitjeju.json"]
        snapshot = ROOT / ".local/reference-catalog.sqlite"
        if not all(p.is_file() for p in [*paths, snapshot]):
            self.skipTest("Optional sanitized provider probes and catalog snapshot are not installed")
        before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [*paths, snapshot]}
        tour_rows = sources.tourapi_items(json.loads(paths[0].read_text()))
        visit_rows = sources.visitjeju_items(json.loads(paths[1].read_text()))
        self.assertEqual(tour_rows[0]["contentid"], "1884191")
        parsed = sources.parse_tourapi(tour_rows[0], None, None, [], [], fetched_at=FETCHED)
        self.assertEqual(parsed["title"], "가마오름")
        self.assertEqual(parsed["photos"][0]["license"], "KOGL-3")
        self.assertIsNone(parsed["photos"][0]["thumb_url"])
        self.assertEqual(sources.parse_visitjeju(visit_rows[0], fetched_at=FETCHED)["photos"], [])
        with sqlite3.connect(snapshot.resolve().as_uri() + "?mode=ro&immutable=1", uri=True) as db:
            db.row_factory = sqlite3.Row
            canonical = dict(db.execute("SELECT id,name,name_en,category,source,lat,lng,address FROM places WHERE id = ?", ("osm:node/3752031213",)).fetchone())
        matched = sources.match_place(canonical, tour_rows, "tourapi")
        self.assertIsNotNone(matched)
        self.assertEqual(matched["record"]["contentid"], "1884191")
        self.assertLess(matched["match"]["distance_m"], 150)
        self.assertEqual({str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [*paths, snapshot]}, before)


if __name__ == "__main__":
    unittest.main()
