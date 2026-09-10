import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogPlaceInfo } from '../server/guide-facts.mjs';

test('guide facts preserve source timestamps verbatim without adding a timezone', () => {
  for (const observed_at of [
    '2025-12-15 16:15:28', '2026-05-11 22:51:24', '2024-02-29',
    '2026-09-08T21:46:33+00:00', '2026-09-09T06:46:33+09:00', '2026-09-08T21:46:33Z',
  ]) {
    const info = catalogPlaceInfo({
      id: 'poi_0011', name: '오설록 티 뮤지엄',
      sources: [{ source: 'localdata', observed_at, url: null, license: 'unrestricted' }],
    });
    assert.equal(info.sources[0].observed_at, observed_at);
  }
});

test('guide facts reject impossible calendar dates and malformed timestamps', () => {
  for (const observed_at of [
    '2026-02-29', '2026-02-31T12:00:00Z', '2026-13-01', '2026-01-00',
    '2026-09-08 24:11:11', '2026-09-08T12:60:00Z', '2026-09-08T12:00:00+99:00',
    'yesterday', '2026-09-08<script>', '2026-09-08\n',
  ]) {
    const info = catalogPlaceInfo({
      id: 'osm:node/1', name: '장소', sources: [{ source: 'localdata', observed_at }],
    });
    assert.equal(info.sources[0].observed_at, null, observed_at);
  }
});

test('guide facts carry field evidence and registration caveats without upgrading unknown amenities', () => {
  const field_evidence = {
    lat: { state: 'unverified', source: 'sample', observed_at: null, evidence_url: null },
    'facilities.parking': { state: 'unknown', source: null, observed_at: null, evidence_url: null },
    hours_week: { state: 'parsed', source: 'tourapi_usetime', observed_at: null, evidence_url: null },
    business_status: { state: 'unknown', source: null, observed_at: null, evidence_url: null },
  };
  const registration_note = '연결된 인허가 자료의 상태이며 장소 전체의 운영 여부를 확정하지 않습니다.';
  const info = catalogPlaceInfo({
    id: 'poi_0011', name: '오설록 티 뮤지엄', field_evidence, registration_note,
    facilities: { parking: 'unknown', wheelchair: 'no' },
    business_status: 'closed_permanently',
    sources: [{ source: 'tourapi', observed_at: '2026-09-08T00:00:00Z', license: 'KOGL-1' }],
  });
  assert.deepEqual(info.field_evidence, field_evidence);
  assert.equal(info.registration_note, registration_note);
  assert.deepEqual(info.facilities, { parking: 'unknown', wheelchair: 'no' });
  assert.equal(info.business_status, 'closed_permanently');
  assert.equal('open_now' in info, false);
});

test('guide field evidence rejects unsafe paths, invalid states and invented source ownership', () => {
  const field_evidence = JSON.parse(`{
    "__proto__.polluted": {"state":"reviewed","source":"tourapi"},
    "lat": {"state":"verified_official","source":"tourapi"},
    "facilities.parking": {"state":"source_reported","source":null,"evidence_url":"javascript:alert(1)"},
    "hours_week": {"state":"parsed","source":"tourapi_usetime","observed_at":"2025-12-15 16:15:28","evidence_url":"https://example.org/hours"}
  }`);
  const info = catalogPlaceInfo({
    id: 'osm:node/1', name: '장소', field_evidence, sources: [{ source: 'tourapi' }],
  });
  assert.deepEqual(Object.keys(info.field_evidence).sort(), ['facilities.parking', 'hours_week']);
  assert.deepEqual(info.field_evidence['facilities.parking'], {
    state: 'unknown', source: null, observed_at: null, evidence_url: null,
  });
  assert.equal(info.field_evidence.hours_week.observed_at, '2025-12-15 16:15:28');
  assert.equal(info.field_evidence.hours_week.evidence_url, 'https://example.org/hours');
  assert.equal({}.polluted, undefined);
});
