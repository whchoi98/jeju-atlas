import test from 'node:test';
import assert from 'node:assert/strict';
import { currentJejuLocation, selectedMapPoint } from '../src/map-location.ts';

test('current location uses an explicit request and preserves valid provider accuracy', async () => {
  let calls = 0;
  const geo = { getCurrentPosition(ok, _fail, options) {
    calls++;
    assert.equal(options.timeout, 10_000);
    ok({ coords: { longitude: 126.5, latitude: 33.4, accuracy: 23 } });
  } };
  assert.equal(calls, 0);
  assert.deepEqual(await currentJejuLocation(geo), { lng: 126.5, lat: 33.4, accuracy_m: 23 });
  assert.equal(calls, 1);
});

test('permission failure and positions outside Jeju never become a fabricated Jeju location', async () => {
  await assert.rejects(currentJejuLocation({ getCurrentPosition(_ok, fail) { fail({ code: 1 }); } }), /location_denied/);
  await assert.rejects(currentJejuLocation({ getCurrentPosition(ok) { ok({ coords: { longitude: 127, latitude: 37.5, accuracy: 5 } }); } }), /location_outside_jeju/);
});

test('a map-picked route point stays a user point without venue claims or a made-up data timestamp', () => {
  const point = selectedMapPoint({ lng: 126.5, lat: 33.4 });
  assert.equal(point.source, 'user_point');
  assert.equal(point.updated_at, null);
  assert.equal(point.address, null);
  assert.deepEqual(point.geometry.coordinates, [126.5, 33.4]);
  assert.match(point.id, /^point:/);
  assert.throws(() => selectedMapPoint({ lng: 127, lat: 37.5 }), /outside_jeju/);
});
