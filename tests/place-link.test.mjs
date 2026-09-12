import test from 'node:test';
import assert from 'node:assert/strict';
import { placeLink, sharedPlace } from '../src/place-link.ts';

test('venue links exclude the current private itinerary and every selection credential', () => {
  const place = { id: 'kakao:123', name: '제주 카페', category: '카페', lat: 33.4, lng: 126.5, selection_token: 'private-proof' };
  const url = placeLink(place, 'https://atlas.example/?private=value#trip=private-itinerary');
  assert.ok(!url.includes('private'));
  const parsed = sharedPlace(url);
  assert.equal(parsed.id, place.id);
  assert.equal(parsed.hint.source, 'shared_hint');
  assert.equal(parsed.hint.updated_at, null);
  assert.equal(parsed.hint.name, place.name);
});

test('canonical links contain only the ID and never trust caller-provided names or coordinates', () => {
  const url = placeLink({ id: 'poi_0008' }, 'https://atlas.example/#trip=private');
  assert.equal(url, 'https://atlas.example/?atlas_place=poi_0008');
  assert.deepEqual(sharedPlace(url + '&atlas_name=spoofed&atlas_lat=1'), { id: 'poi_0008' });
});

test('shared place hints reject malformed IDs, duplicate fields and non-Jeju points', () => {
  for (const query of [
    'atlas_place=javascript:123',
    'atlas_place=poi_0008&atlas_place=poi_0009',
    'atlas_place=kakao:1&atlas_name=A&atlas_category=카페&atlas_lat=37.5&atlas_lng=127',
    'atlas_place=kakao:1&atlas_name=A&atlas_category=카페&atlas_lat=&atlas_lng=126.5',
  ]) assert.throws(() => sharedPlace(`https://atlas.example/?${query}`), /invalid_place_link/);
  assert.equal(sharedPlace('https://atlas.example/#map=1'), null);
});
