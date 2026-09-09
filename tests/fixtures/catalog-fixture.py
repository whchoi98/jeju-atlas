"""Build disposable catalog databases; never read or change the service snapshot."""

import json
import sqlite3
import sys
import unicodedata
from pathlib import Path


def build(path, options):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE places(
          rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          name_en TEXT, category TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
          address TEXT, summary TEXT, tags TEXT NOT NULL, source TEXT NOT NULL,
          url TEXT, phone TEXT, hours TEXT, updated_at TEXT NOT NULL, region TEXT,
          avg_stay_min INTEGER, name_norm TEXT NOT NULL, tags_text TEXT NOT NULL
        );
        CREATE TABLE place_extra(
          id TEXT PRIMARY KEY, photos TEXT, hours_week TEXT, hours_source TEXT,
          facilities TEXT, overview TEXT, menu TEXT, business_status TEXT,
          tips TEXT, sources TEXT, fetched_at TEXT
        );
    """)
    rows = [
        dict(id="seed:peak", name="성산일출봉", category="관광지", lat=33.458, lng=126.942,
             source="sample", address="시드 주소", summary="시드 소개", tags=["일출", "풍경"]),
        dict(id="osm:cafe", name="바다 카페", category="카페", lat=33.45, lng=126.5,
             source="OpenStreetMap", tags=["커피", "바다"], name_en="Ocean Cafe",
             phone="064-000-0000", hours="Mo-Su 09:00-18:00",
             url="https://www.openstreetmap.org/node/1"),
        dict(id="osm:literal", name='100%_ "카페"', category="카페", lat=33.451, lng=126.5,
             source="OpenStreetMap", tags=["특별"]),
        dict(id="osm:near", name="가까운 식당", category="맛집", lat=33.454, lng=126.5,
             source="OpenStreetMap", tags=["한식"]),
        dict(id="osm:corner", name="경계 밖 식당", category="맛집", lat=33.458, lng=126.509,
             source="OpenStreetMap", tags=["한식"]),
        dict(id="osm:edge", name="원 밖 식당", category="맛집", lat=33.458994, lng=126.5,
             source="OpenStreetMap", tags=["한식"]),
        dict(id="osm:north", name="북쪽 해변", category="해변", lat=33.6, lng=126.98,
             source="OpenStreetMap", tags=["해변"]),
        dict(id="osm:south", name="남쪽 오름", category="오름", lat=33.1, lng=126.15,
             source="OpenStreetMap", tags=["오름"]),
        dict(id="osm:slash", name="역슬래시\\장소", category="관광지", lat=33.4, lng=126.4,
             source="OpenStreetMap", tags=[]),
    ]
    rows.extend(options.get("append", []))
    if options.get("empty"):
        rows = []
    columns = [r[1] for r in db.execute("PRAGMA table_info(places)") if r[1] != "rid"]
    for item in rows:
        row = dict.fromkeys(columns)
        row.update(tags=[], source="OpenStreetMap", updated_at="2026-09-08")
        row.update(item)
        row["name_norm"] = "".join(unicodedata.normalize("NFC", row["name"]).split()).casefold()
        row["tags_text"] = " ".join(row["tags"]).casefold()
        row["tags"] = json.dumps(row["tags"], ensure_ascii=False)
        db.execute(
            f"INSERT INTO places({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
            [row[c] for c in columns],
        )
    if not options.get("no_fts"):
        db.executescript("""
            CREATE VIRTUAL TABLE places_fts USING fts5(
              name, name_en, tags_text, summary, address,
              content='places', content_rowid='rid', tokenize='trigram'
            );
            INSERT INTO places_fts(places_fts) VALUES('rebuild');
        """)
    extras = {
        "seed:peak": {
            "overview": "공식 보강 소개",
            "hours_week": [{"day": 0, "open": "09:00", "close": "24:00"}],
            "hours_source": "tourapi_usetime",
            "facilities": {"parking": "yes", "wheelchair": "unknown"},
            "menu": [{"name": "입장권", "price_krw": None, "source": "tourapi"}],
            "business_status": "open",
            "sources": [
                {"source": "curated", "url": None, "observed_at": None, "license": "curated"},
                {"source": "tourapi", "url": "https://example.org/place",
                 "observed_at": "2026-09-08T21:46:33+00:00", "license": "KOGL-1",
                 "note": "전화 064-999-9999 · 09:00~18:00"},
            ],
            "fetched_at": "2026-09-08T21:48:08+00:00",
        }
    }
    extras.update(options.get("extras", {}))
    json_columns = {"photos", "hours_week", "facilities", "menu", "tips", "sources"}
    if options.get("no_extra_table"):
        db.execute("DROP TABLE place_extra")
    else:
        for place_id, extra in extras.items():
            fields = ["id", *extra]
            values = [place_id, *[
                json.dumps(value, ensure_ascii=False) if key in json_columns and value is not None else value
                for key, value in extra.items()
            ]]
            db.execute(
                f"INSERT INTO place_extra({','.join(fields)}) VALUES({','.join('?' for _ in fields)})",
                values,
            )
    meta = {
        "schema_version": "2", "count": str(len(rows)),
        "built_at": "2026-09-08T21:48:10+00:00",
        "by_source": json.dumps({
            source: sum(r.get("source", "OpenStreetMap") == source for r in rows)
            for source in ("sample", "OpenStreetMap")
        }),
        "photos_count": str(sum(bool(e.get("photos")) for e in extras.values())),
        "hours_week_count": str(sum(bool(e.get("hours_week")) for e in extras.values())),
        "attribution": "장소 데이터 © OpenStreetMap contributors (ODbL) · 큐레이션 데이터 오마이제주",
    }
    meta.update(options.get("meta", {}))
    db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
    if options.get("drop_column"):
        db.execute(f"ALTER TABLE places DROP COLUMN {options['drop_column']}")
    db.commit()
    db.close()


if __name__ == "__main__":
    build(Path(sys.argv[1]), json.loads(sys.stdin.read() or "{}"))
