import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createGuideHandler, createAgentInvoker, normalizeGuideMap } from '../server/guide.mjs';
import { DiscoveryError } from '../server/discovery.mjs';

const place = {
  id: 'kakao:12345', name: '현재 카페', category: '카페', lat: 33.45, lng: 126.55,
  address: '제주 테스트로', phone: '064-000-0000', url: 'https://place.map.kakao.com/12345',
  source: 'Kakao Local', updated_at: '2026-09-12T10:00:00.000Z',
  facilities: { parking: 'yes' }, hours_week: [], hours_source: null,
  sources: [{ source: 'Kakao Local', observed_at: '2026-09-12T10:00:00.000Z', url: 'https://place.map.kakao.com/12345', license: null }],
  field_evidence: { 'facilities.parking': { state: 'source_reported', source: 'VisitJeju', observed_at: '2026-09-10' } },
};
const grounding = () => ({
  payload: {
    version: 1, kind: 'selection', status: 'ready', source: 'Kakao Local', category: '', query: place.name,
    items: [{ id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng,
      source: place.source, observed_at: place.updated_at, address: place.address, phone: place.phone, url: place.url }],
    anchor: null, queried_at: place.updated_at, message: '현재 조회 자료입니다.',
  },
  places: [structuredClone(place)],
});

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  headers = {};
  output = '';
  setHeader(key, value) { this.headers[key] = value; }
  writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); }
  flushHeaders() {}
  write(value) { this.output += value; return true; }
  end(value = '') { this.output += value; this.writableEnded = true; }
}
function fixture({ invalid, resolve, acquire, invoke } = {}) {
  const trace = [], hashes = [], inputs = [];
  const guide = createGuideHandler({
    sessions: {
      createConversation: () => ({ id: 'conversation', token: 'conversation-proof' }),
      verifyConversation: () => ({ id: 'conversation', token: 'conversation-proof' }),
    },
    guideDiscovery: {
      validateSelection(token, actorId) {
        trace.push('validate');
        assert.equal(actorId, 'reader');
        if (invalid) throw new DiscoveryError(invalid);
        return { ...place, id: token === 'second-proof' ? 'kakao:54321' : place.id };
      },
      async resolve(input) {
        trace.push('resolve');
        assert.equal(input.actorId, 'reader');
        assert.ok(input.signal instanceof AbortSignal);
        return resolve ? resolve(input) : grounding();
      },
    },
    admission: {
      async acquire(input) { trace.push('acquire'); hashes.push(input.requestHash); return acquire ? acquire(input) : {}; },
      async start() { trace.push('start'); },
      async finish() { trace.push('finish'); },
    },
    requestHashKey: 'guide-grounding-hash-fixture',
    invokeEvents(input) {
      trace.push('invoke');
      inputs.push(input);
      return invoke ? invoke(input) : (async function* () {
        yield { type: 'grounding', version: 1 };
        yield { type: 'map', answer: `${place.name}를 소개합니다.`, markers: [place] };
        yield { type: 'done' };
      })();
    },
  });
  return {
    guide, trace, hashes, inputs,
    async send(extra = {}) {
      const response = new Response();
      await guide.handle({}, response, { message: '선택한 장소 알려줘', selection_token: 'first-proof', ...extra }, 'reader');
      return response;
    },
  };
}

test('selection validation precedes AI admission and resolution precedes model invocation', async () => {
  const f = fixture();
  const response = await f.send();
  assert.deepEqual(f.trace, ['validate', 'acquire', 'resolve', 'start', 'invoke', 'finish']);
  assert.equal(f.inputs[0].message, '선택한 장소 알려줘');
  assert.deepEqual(f.inputs[0].grounding, grounding().payload);
  assert.ok(!JSON.stringify(f.inputs).includes('first-proof'));
  assert.match(response.output, /Kakao Local/);
  assert.ok(!response.output.includes('first-proof'));
});

test('invalid and expired native proofs fail before any AI admission or model work', async () => {
  for (const invalid of ['kakao_selection_invalid', 'kakao_selection_expired']) {
    const f = fixture({ invalid });
    await assert.rejects(f.send(), error => error.code === invalid);
    assert.deepEqual(f.trace, ['validate']);
  }
});

test('changed selected identities change the idempotency hash without storing a proof', async () => {
  const f = fixture();
  await f.send({ conversation_id: 'same-conversation' });
  await f.send({ conversation_id: 'same-conversation', selection_token: 'second-proof' });
  assert.equal(f.hashes.length, 2);
  assert.notEqual(f.hashes[0], f.hashes[1]);
  assert.ok(f.hashes.every(value => /^[a-f0-9]{64}$/.test(value)));
});

test('native marker fields and public extras come only from the current resolved records', () => {
  const nativeGrounding = grounding();
  const forged = { ...place, name: 'Invented name', lat: 33.3, phone: 'invented', source: 'Verified everywhere' };
  const map = normalizeGuideMap({
    answer: '현재 카페입니다.', markers: [forged, { ...forged, id: 'kakao:999' }],
    place_info: [{ id: place.id, facilities: { wheelchair: 'yes' } }],
  }, { nativeGrounding });
  assert.equal(map.markers.length, 1);
  assert.equal(map.markers[0].name, place.name);
  assert.equal(map.markers[0].lat, place.lat);
  assert.equal(map.markers[0].source, 'Kakao Local');
  assert.equal(map.markers[0].observed_at, place.updated_at);
  assert.deepEqual(map.place_info[0].facilities, { parking: 'yes' });
  assert.equal(map.place_info[0].field_evidence['facilities.parking'].source, 'VisitJeju');
});

test('commercial grounding cannot be replaced by legacy businesses, while nature markers remain', () => {
  const cafe = { id: 'old-cafe', name: '시드 카페', category: '카페', lat: 33.4, lng: 126.5, source: 'sample' };
  const beach = { id: 'public-beach', name: '공공 해변', category: '해변', lat: 33.5, lng: 126.6, source: 'VisitJeju' };
  const nativeGrounding = { payload: { ...grounding().payload, kind: 'search', status: 'unavailable', items: [] }, places: [] };
  const map = normalizeGuideMap({ answer: '조회 결과입니다.', markers: [cafe, beach, place] }, {
    nativeGrounding, catalog: { detail: id => [cafe, beach].find(row => row.id === id) },
  });
  assert.deepEqual(map.markers.map(item => item.id), ['public-beach']);
});

test('native markers without turn attestation are dropped even if the model claims a provider source', () => {
  const map = normalizeGuideMap({ answer: '확인되지 않은 후보', markers: [place] });
  assert.deepEqual(map.markers, []);
});

test('text-only answers can map mentioned native records without searching again', async () => {
  const f = fixture({ invoke: async function* () {
    yield { type: 'grounding', version: 1 };
    yield { type: 'token', text: `${place.name}의 이용 정보입니다.` };
    yield { type: 'done' };
  } });
  const response = await f.send();
  const mapFrame = response.output.split('\n\n').find(frame => frame.startsWith('event: map\n'));
  const map = JSON.parse(mapFrame.split('data: ')[1]);
  assert.deepEqual(map.markers.map(marker => marker.id), [place.id]);
  assert.equal(f.trace.filter(event => event === 'resolve').length, 1);
});

test('old runtime sessions cannot silently ignore native grounding and stream legacy recommendations', async () => {
  const f = fixture({ invoke: async function* () {
    yield { type: 'status', stage: 'thinking' };
    yield { type: 'token', text: 'old-runtime-commercial-answer-sentinel' };
    yield { type: 'map', answer: 'old-runtime-commercial-answer-sentinel', markers: [] };
    yield { type: 'done' };
  } });
  const response = await f.send();
  assert.match(response.output, /conversation_refresh_required/);
  assert.ok(!response.output.includes('old-runtime-commercial-answer-sentinel'));
  assert.equal(f.inputs.length, 1, 'A model invocation is never retried automatically');
});

test('a selection proof echoed into the question is rejected before admission', async () => {
  const f = fixture();
  await assert.rejects(f.send({ message: '선택 증명 first-proof' }), error => error.code === 'kakao_selection_invalid');
  assert.ok(!f.trace.includes('acquire'));
});

test('the AgentCore invocation carries structured grounding separately from the question', async () => {
  let payload;
  const invoke = createAgentInvoker({
    runtimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/TestRuntime-1234567890',
    client: { async send(command) {
      payload = JSON.parse(command.input.payload.toString());
      return { contentType: 'application/json', response: new TextEncoder().encode(JSON.stringify({ answer: '알려드립니다.', markers: [] })) };
    } },
  });
  for await (const _ of invoke({ message: '원래 질문', actorId: 'reader', conversationId: 'conversation', grounding: grounding().payload })) { /* consume */ }
  assert.equal(payload.prompt, '원래 질문');
  assert.deepEqual(payload.grounding, grounding().payload);
  assert.equal(payload.selection_token, undefined);
});
