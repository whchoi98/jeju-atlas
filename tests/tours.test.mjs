import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as tours from '../src/tours.ts';

const first = [[126.2, 33.3], [126.201, 33.3], [126.202, 33.3002]];
const second = [[126.8, 33.5], [126.801, 33.5]];
const fixture = () => ({
  type: 'Feature',
  properties: {
    id: 'olle-123', course: '1', name_ko: '올레 1코스', name_en: 'Jeju Olle 1',
    relation_id: 123, source_url: 'https://www.openstreetmap.org/relation/123',
    license: 'ODbL-1.0', license_url: 'https://opendatacommons.org/licenses/odbl/1-0/', fetched_at: '2026-09-10T00:00:00Z',
    source_updated_at: '2026-09-01T00:00:00Z', incomplete: true,
    simplification_m: 8,
  },
  geometry: { type: 'MultiLineString', coordinates: structuredClone([first, second]) },
});

test('existing Jeju loop remains the default with Korean and English labels', () => {
  assert.equal(tours?.DEFAULT_TOUR, 'jeju-loop');
  assert.equal(tours.tourLabel(null, 'ko'), '제주 한 바퀴');
  assert.equal(tours.tourLabel(null, 'en'), 'Around Jeju');
});

test('route validation preserves disjoint actual segments and trustworthy provenance', () => {
  const route = tours.validateOlleRoute(fixture());
  assert.equal(route.geometry.coordinates.length, 2);
  assert.deepEqual(route.geometry.coordinates, [first, second]);
  assert.equal(route.properties.relation_id, 123);
  assert.equal(route.properties.incomplete, true);
  assert.ok(tours.routeDistance(route.geometry.coordinates) < 400,
    'The large gap between parts must not count as a trail segment');
});

test('invalid coordinates, geometry, source links and excessive input are rejected', () => {
  for (const mutate of [
    value => { value.geometry.coordinates[0][0] = [0, 0]; },
    value => { value.geometry.coordinates[0][0] = [126.5, NaN]; },
    value => { value.geometry.coordinates[0] = [[126.5, 33.4]]; },
    value => { value.geometry.type = 'LineString'; },
    value => { value.properties.source_url = 'javascript:alert(1)'; },
    value => { value.properties.source_url = 'https://www.openstreetmap.org/relation/999'; },
    value => { value.properties.license = 'unknown'; },
    value => { value.properties.license_url = 'https://not-the-license.example'; },
    value => { value.geometry.coordinates = Array.from({ length: 513 }, () => first); },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => tours.validateOlleRoute(value));
  }
});

test('camera frames stay on actual segments and jump across gaps', () => {
  const route = tours.validateOlleRoute(fixture());
  const frames = tours.tourFrames(route.geometry.coordinates, 20);
  assert.ok(frames.length <= 20);
  assert.deepEqual(frames[0].center, first[0]);
  assert.deepEqual(frames.at(-1).center, second.at(-1));
  const gap = frames.find(frame => frame.gapBefore);
  assert.ok(gap);
  assert.deepEqual(gap.center, second[0]);
  assert.equal(frames.filter(frame => frame.gapBefore).length, 1);
  for (const frame of frames) {
    assert.ok(frame.center[0] < 126.21 || frame.center[0] > 126.79,
      'No invented intermediate point may cross the missing section');
  }
});

test('continuous playback follows a bend and skips unmapped space', () => {
  const bent = [[126.2, 33.3], [126.2, 33.31], [126.21, 33.31]];
  const track = tours.createTourTrack([bent, second]);
  const bendDistance = tours.pointDistance(bent[0], bent[1]);
  assert.deepEqual(track.at(bendDistance).center, bent[1]);
  for (let distance = 0; distance <= track.length; distance += 7) {
    const sample = track.at(distance);
    if (sample.part === 0) {
      assert.ok(sample.center[0] === 126.2 || sample.center[1] === 33.31,
        'The camera must follow the right-angle trail, not a diagonal shortcut');
    } else assert.ok(sample.center[0] >= 126.8);
  }
  assert.deepEqual(track.at(track.length).center, second.at(-1));
  assert.throws(() => track.at(NaN));
});

test('simplification retains endpoints and never joins separate route parts', () => {
  const line = [[126.2, 33.3], [126.2005, 33.30001], [126.201, 33.3], [126.202, 33.302]];
  const simplified = tours.simplifySegments([line, second], 8);
  assert.equal(simplified.length, 2);
  assert.deepEqual(simplified[0][0], line[0]);
  assert.deepEqual(simplified[0].at(-1), line.at(-1));
  assert.deepEqual(simplified[1], second);
  assert.ok(simplified[0].length < line.length);
  assert.ok(simplified[0].every(point => line.some(original => original[0] === point[0] && original[1] === point[1])));
});

test('manifest accepts only local geometry files and exposes missing geometry honestly', () => {
  const manifest = {
    version: 1, fetched_at: '2026-09-10T00:00:00Z', relations_examined: 2,
    routes: [
      { id: 'olle-123', course: '1', name_ko: '올레 1코스', name_en: 'Jeju Olle 1',
        available: true, file: '/data/olle-123.geojson' },
      { id: 'olle-missing-18-1', course: '18-1', name_ko: '추자 올레', name_en: 'Chuja Olle',
        available: false, reason: 'missing_geometry' },
    ],
  };
  assert.equal(tours.validateTourManifest(manifest).routes[1].available, false);
  const bad = structuredClone(manifest);
  bad.routes[0].file = 'https://external.example/tracker';
  assert.throws(() => tours.validateTourManifest(bad));
});

test('published trail assets are bounded, licensed, internally consistent and explicit about missing coverage', async () => {
  const text = await readFile(new URL('../public/data/olle-routes.json', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(text) < 100_000);
  const manifest = tours.validateTourManifest(JSON.parse(text));
  const available = manifest.routes.filter(route => route.available);
  assert.ok(available.length > 1);
  assert.ok(manifest.routes.some(route => !route.available), 'Do not conceal missing course geometry');
  assert.equal(manifest.routes.find(route => route.course === '18-1')?.available, false);
  let bytes = 0, separateParts = 0;
  for (const choice of available) {
    const data = await readFile(new URL(`../public${choice.file}`, import.meta.url), 'utf8');
    bytes += Buffer.byteLength(data);
    const route = tours.validateOlleRoute(JSON.parse(data));
    assert.equal(route.properties.id, choice.id);
    assert.equal(route.properties.course, choice.course);
    assert.equal(route.properties.incomplete, true, 'OSM geometry is not independently verified as the current full official course');
    assert.equal(route.properties.simplification_m, 8);
    assert.ok(route.geometry.coordinates.every(part => part.length >= 2));
    assert.ok(tours.routeDistance(route.geometry.coordinates) > 1000);
    const track = tours.createTourTrack(route.geometry.coordinates);
    assert.deepEqual(track.at(0).center, route.geometry.coordinates[0][0]);
    assert.deepEqual(track.at(track.length).center, route.geometry.coordinates.at(-1).at(-1));
    separateParts += route.geometry.coordinates.length - 1;
  }
  assert.ok(separateParts > 0, 'Disconnected original sections must survive publication');
  assert.ok(bytes < 250_000, 'No unnecessarily large geometry bundle');
});

for (const [course, relation, minLength, maxLength] of [
  ['14', 6107767, 4500, 4900],
  ['21', 5539069, 1250, 1500],
]) {
  test(`course ${course} exposes only the actual partial OSM record, not an invented complete course`, async () => {
    const manifest = tours.validateTourManifest(JSON.parse(await readFile(
      new URL('../public/data/olle-routes.json', import.meta.url), 'utf8',
    )));
    const choice = manifest.routes.find(route => route.course === course);
    assert.equal(choice?.available, true);
    assert.equal(choice.id, `olle-${relation}`);
    assert.match(choice.name_ko, /일부/);
    assert.match(choice.name_en, /partial/i);
    const route = tours.validateOlleRoute(JSON.parse(await readFile(
      new URL(`../public${choice.file}`, import.meta.url), 'utf8',
    )));
    assert.equal(route.properties.relation_id, relation);
    assert.equal(route.properties.incomplete, true);
    assert.equal(route.properties.name_ko, choice.name_ko);
    const length = tours.routeDistance(route.geometry.coordinates);
    assert.ok(length >= minLength && length <= maxLength,
      'Mapped distance must reflect the retrieved short section, not the official full-course length');
  });
}
