import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGuideMap } from '../server/guide.mjs';

let splitGuideFrames;
try { ({ splitGuideFrames } = await import('../src/guide-stream.ts')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function largeMapFrame() {
  const places = Array.from({ length: 12 }, (_, index) => ({
    id: `large-facts-${index}`, name: `제주 장소 ${index}`, category: '관광지',
    lat: 33.4, lng: 126.5, source: 'OpenStreetMap',
    facilities: Object.fromEntries(Array.from({ length: 8 }, (_, key) => [`facility${key}`, '자료'.repeat(200)])),
    sources: Array.from({ length: 8 }, (_, source) => ({
      source: `source${source}`, url: `https://example.com/source/${'x'.repeat(1900)}`,
      observed_at: '2026-09-09', license: 'CC-BY-4.0', note: '관측 자료 '.repeat(70),
    })),
    base_note: '보강 자료의 출처는 기본 정보의 검증과 구별합니다.',
  }));
  const map = normalizeGuideMap({
    answer: '추천한 장소들의 편의 자료를 확인해 주세요.', markers: places,
    center: { lat: 33.4, lng: 126.5 }, zoom: 11, route: [], warnings: [],
  }, { catalog: { detail: (id) => places.find((place) => place.id === id) } });
  return `event: map\ndata: ${JSON.stringify(map)}\n\n`;
}

test('a large valid server-projected fact response survives fragmented UTF-8 delivery', () => {
  assert.equal(typeof splitGuideFrames, 'function');
  const frame = largeMapFrame();
  assert.ok(frame.length > 100000, 'Regression must exceed the old client limit');
  assert.ok(frame.length < 512 * 1024);
  const bytes = Buffer.from(frame);
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  for (let offset = 0; offset < bytes.length; offset += 997) {
    buffer += decoder.decode(bytes.subarray(offset, offset + 997), { stream: true });
    const parsed = splitGuideFrames(buffer);
    assert.ok(parsed, 'Valid facts must not be rejected before their terminating blank line');
    frames.push(...parsed.frames);
    buffer = parsed.rest;
  }
  assert.equal(buffer, '');
  assert.equal(frames.length, 1);
  const data = JSON.parse(frames[0].split('\ndata: ')[1]);
  assert.equal(data.place_info.length, 12);
  assert.equal(data.place_info[11].name, '제주 장소 11');
});

test('frame size is checked separately when one transport chunk contains multiple events', () => {
  assert.equal(typeof splitGuideFrames, 'function');
  const frame = largeMapFrame();
  const result = splitGuideFrames(frame.repeat(3) + 'event: done\ndata: {}\n\n');
  assert.ok(result);
  assert.equal(result.frames.length, 4);
  assert.equal(result.rest, '');
});

test('an oversized complete or incomplete frame is rejected at the bounded limit', () => {
  assert.equal(typeof splitGuideFrames, 'function');
  const frame = `data: ${'x'.repeat(512 * 1024)}`;
  assert.equal(splitGuideFrames(frame), null);
  assert.equal(splitGuideFrames(`${frame}\n\n`), null);
});

test('CRLF frames, heartbeats, and an unfinished tail preserve event boundaries', () => {
  assert.equal(typeof splitGuideFrames, 'function');
  assert.deepEqual(splitGuideFrames(': heartbeat\r\n\r\nevent: text\r\ndata: {"delta":"제주"}\r\n\r\nevent: ma'), {
    frames: [': heartbeat', 'event: text\r\ndata: {"delta":"제주"}'], rest: 'event: ma',
  });
});
