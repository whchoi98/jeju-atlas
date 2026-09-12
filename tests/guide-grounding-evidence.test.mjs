import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGuideGrounding, catalogReference } from '../server/guide-grounding.mjs';

const question = '아이와 함께 방문할 장소를 추천하고 편의 정보를 알려 주세요.';
const place = (id, name, extra = {}) => ({
  id, name, category: '관광지', tags: ['가족'], lat: 33.4, lng: 126.5, source: 'sample',
  facilities: {}, hours_week: [], sources: [], ...extra,
});
const catalog = (places) => ({
  search: ({ category }) => ({ items: places.filter((p) => p.category === category) }),
  detail: (id) => places.find((p) => p.id === id),
});

test('a recorded no or limited facility does not receive a positive recommendation score', () => {
  const result = prepareGuideGrounding(question, catalog([
    place('no', '가족 가 공원', { facilities: { parking: 'no' } }),
    place('yes', '가족 나 공원', { facilities: { parking: 'yes' } }),
  ]));
  assert.equal(result.candidates[0].id, 'yes');
});

test('individual permit closure does not exclude a venue and evidence stays qualified', () => {
  const candidate = place('poi_0011', '가족 박물관', {
    business_status: 'closed_permanently', registration_note: '개별 인허가 상태이며 장소 전체 폐업을 뜻하지 않습니다.',
    facilities: { parking: 'yes' }, hours_source: 'tourapi_usetime',
    field_evidence: {
      tags: { state: 'unverified', source: 'sample', observed_at: null, evidence_url: null },
      'facilities.parking': { state: 'source_reported', source: 'tourapi', observed_at: '2026-09-09', evidence_url: 'https://example.org/place' },
      hours_week: { state: 'parsed', source: 'tourapi_usetime', observed_at: '2026-09-09', evidence_url: null },
    },
  });
  const result = prepareGuideGrounding(question, catalog([candidate]));
  assert.equal(result.candidates.length, 1);
  assert.ok(result.prompt.startsWith(question));
  assert.ok(result.prompt.length <= 2000);
  assert.match(result.prompt, /unverified/);
  assert.match(result.prompt, /source_reported/);
  assert.match(result.prompt, /parsed/);
  assert.match(result.prompt, /개별 인허가|장소 전체/);
  assert.match(result.prompt, /검증.*아니|검증.*않|검증.*마/);
  assert.match(catalogReference('결과 없음', result).appendix, /공식 대조 검증/);
});

test('a provider parking fact remains available even when the generic parking flag is unknown', () => {
  const candidate = place('poi_0122', '가족 항공우주박물관', {
    facilities: { parking: 'unknown' },
    official_details: [{
      provider: 'tourapi', provider_id: '12345', locale: 'ko',
      source_url: 'https://korean.visitkorea.or.kr/detail/ms_detail.do?cotid=fixture',
      fetched_at: '2026-09-12T01:00:00.000Z', title: '가족 항공우주박물관',
      address: null, phone: null, website: null, latitude: null, longitude: null, overview: null,
      photos: [], facts: [{ key: 'parking', label_ko: '주차', label_en: 'Parking', value: '가능 (약 458대)' }],
      match: { method: 'exact_name', distance_m: 0 },
    }],
  });
  const result = prepareGuideGrounding('아이와 함께 가기 좋은 제주 관광지 한 곳과 확인된 편의 정보를 간단히 알려 주세요.', catalog([candidate]));
  assert.match(result.prompt, /458/);
  assert.match(result.prompt, /official_facts/);
  assert.match(result.prompt, /tourapi/);
  assert.match(result.prompt, /2026-09-12/);
  assert.match(result.prompt, /미확인/);
  assert.ok(result.prompt.length <= 2000);
});
