import test from 'node:test';
import assert from 'node:assert/strict';

const profile = await import('../src/elevation-profile.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const measurement = await import('../src/measurement.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const scenes = await import('../src/scenes.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('profile samples follow a real bend, preserve endpoints and bound the elevation request', () => {
  assert.equal(typeof profile.sampleProfile, 'function');
  const line = [[126.4, 33.3], [126.4, 33.31], [126.41, 33.31]];
  const result = profile.sampleProfile(line, 128);
  assert.equal(result.coordinates.length, 128);
  assert.deepEqual(result.coordinates[0], [126.4, 33.3]);
  assert.deepEqual(result.coordinates.at(-1), [126.41, 33.31]);
  assert.equal(result.distances_m[0], 0);
  assert.ok(result.length_m > 2000 && result.length_m < 2100);
  for (const [lng, lat] of result.coordinates) {
    assert.ok(Math.abs(lng - 126.4) < 1e-10 || Math.abs(lat - 33.31) < 1e-10,
      'Sampling must follow the road bend, not a shortcut between endpoints');
  }
  assert.throws(() => profile.sampleProfile(line, 257));
  assert.throws(() => profile.sampleProfile([[126.4, 33.3], [126.4, 33.3]]));
  assert.throws(() => profile.sampleProfile([[0, 0], [126.4, 33.3]]));
});

test('missing DEM values never become sea level or a fabricated climb across a gap', () => {
  assert.equal(typeof profile.summarizeElevation, 'function');
  assert.deepEqual(profile.summarizeElevation([0, 100, 70, 120]), {
    total: 4, known: 4, min_m: 0, max_m: 120, ascent_m: 150, descent_m: 30,
  });
  assert.deepEqual(profile.summarizeElevation([0, 100, null, 800, 700]), {
    total: 5, known: 4, min_m: 0, max_m: 800, ascent_m: null, descent_m: null,
  });
  assert.deepEqual(profile.summarizeElevation([null, null]), {
    total: 2, known: 0, min_m: null, max_m: null, ascent_m: null, descent_m: null,
  });
});

test('the profile chart breaks at unknown heights and keeps zero-height samples', () => {
  assert.equal(typeof profile.profileChart, 'function');
  const chart = profile.profileChart([0, 20, null, 60, 30], [0, 100, 200, 300, 400]);
  assert.equal(chart.paths.length, 2);
  assert.equal(chart.points[2].y, null);
  assert.equal(typeof chart.points[0].y, 'number');
  assert.ok(chart.paths.every(path => /^M/.test(path) && !/NaN|Infinity/.test(path)));
  assert.equal(profile.profileChart([null, null], [0, 100]).paths.length, 0);
});

test('distance measurement accumulates only requested segments and supports undo/clear without sharing mutable state', () => {
  assert.equal(typeof measurement.MeasurementModel, 'function');
  const model = new measurement.MeasurementModel();
  model.add([126.4, 33.3]);
  model.add([126.4, 33.301]);
  model.add([126.4, 33.302]);
  assert.equal(model.result.segments_m.length, 2);
  assert.ok(Math.abs(model.result.distance_m - 222.39) < 0.1);
  const copy = model.coordinates;
  copy[0][0] = 0;
  assert.deepEqual(model.coordinates[0], [126.4, 33.3]);
  model.undo();
  assert.ok(Math.abs(model.result.distance_m - 111.195) < 0.1);
  model.clear();
  assert.deepEqual(model.result, { segments_m: [], distance_m: 0 });
  assert.deepEqual(model.coordinates, []);
});

test('measurement rejects out-of-map input, duplicate clicks and unbounded point counts', () => {
  assert.equal(typeof measurement.MeasurementModel, 'function');
  const model = new measurement.MeasurementModel();
  assert.equal(model.add([NaN, 33.4]), false);
  assert.equal(model.add([126.5, 90]), false);
  assert.equal(model.add([126.4, 33.3]), true);
  assert.equal(model.add([126.4, 33.3]), false);
  for (let i = 1; i < 32; i++) assert.equal(model.add([126.4, 33.3 + i / 10000]), true);
  assert.equal(model.add([126.5, 33.4]), false);
  assert.equal(model.coordinates.length, 32);
});

function animationClock() {
  let time = 0, id = 0;
  const callbacks = new Map();
  return {
    now: () => time,
    requestFrame: callback => { callbacks.set(++id, callback); return id; },
    cancelFrame: handle => { callbacks.delete(handle); },
    advance(ms) {
      time += ms;
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(time);
    },
    pending: () => [...callbacks.values()],
  };
}

test('stopping camera playback cancels movement, including callbacks already queued before a replacement', () => {
  assert.equal(typeof scenes.CameraPlayback, 'function');
  const clock = animationClock();
  const player = new scenes.CameraPlayback(clock);
  const first = [], second = [];
  player.start(1000, progress => first.push(progress));
  clock.advance(250);
  assert.equal(first.at(-1), 0.25);
  const stale = clock.pending();
  player.start(1000, progress => second.push(progress));
  const before = first.length;
  stale.forEach(callback => callback(500));
  assert.equal(first.length, before);
  clock.advance(250);
  assert.equal(second.at(-1), 0.25);
  player.stop();
  const stopped = second.length;
  clock.advance(1000);
  assert.equal(second.length, stopped);
  assert.equal(player.running, false);
});

test('camera playback finishes once and leaves no scheduled animation', () => {
  assert.equal(typeof scenes.CameraPlayback, 'function');
  const clock = animationClock(), values = [];
  let finished = 0;
  const player = new scenes.CameraPlayback(clock);
  player.start(500, value => values.push(value), () => { finished++; });
  clock.advance(500);
  clock.advance(500);
  assert.equal(values.at(-1), 1);
  assert.equal(finished, 1);
  assert.equal(player.running, false);
  assert.equal(clock.pending().length, 0);
});
