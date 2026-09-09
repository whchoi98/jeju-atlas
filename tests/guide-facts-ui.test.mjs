import test from 'node:test';
import assert from 'node:assert/strict';
let facts;
try { facts = await import('../src/guide-facts.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('unknown facility flags are not counted or presented as confirmed facilities', () => {
  assert.equal(typeof facts?.facilityText, 'function');
  for (const value of ['unknown', 'UNKNOWN', '', '미확인']) {
    assert.equal(facts.facilityText(value), '미확인');
    assert.equal(facts.hasFacilityRecord(value), false);
  }
});

test('positive and negative catalog flags stay qualified as source records', () => {
  assert.equal(typeof facts?.facilityText, 'function');
  assert.equal(facts.facilityText('yes'), '자료상 있음');
  assert.equal(facts.facilityText('no'), '자료상 없음');
  assert.equal(facts.facilityText('대형 10대, 소형 50대'), '대형 10대, 소형 50대');
  assert.equal(facts.hasFacilityRecord('no'), true);
});

test('TourAPI time text does not establish seven-day operation or holiday schedules', () => {
  assert.equal(typeof facts?.hoursText, 'function');
  const rows = Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '17:50' }));
  const summary = facts.hoursText(rows, 'tourapi_usetime');
  assert.match(summary, /09:00–17:50/);
  assert.match(summary, /문구에서 추출/);
  assert.match(summary, /휴무일 미확인/);
  assert.doesNotMatch(summary, /7일 영업|연중무휴|매일/);
});

test('missing hours stay unknown and explicitly parsed weekly hours remain distinct', () => {
  assert.equal(typeof facts?.hoursText, 'function');
  assert.equal(facts.hoursText([], null), '요일별 영업시간 미확인');
  assert.match(facts.hoursText([{ day: 1, open: '10:00', close: '18:00' }], 'osm_opening_hours'), /요일별 영업시간 1건/);
});
