import assert from 'node:assert/strict';
import test from 'node:test';
import * as requests from '../src/guide-request.ts';

const selected = { id: 'kakao:12345', name: '현재 카페', selection_token: 'fixture-selection-proof' };

test('native proof accompanies only a referenced current selection, never an unrelated question', () => {
  assert.equal(typeof requests.guideSelectionToken, 'function');
  for (const message of ['여기 이용시간 알려줘', '선택한 장소 설명', '현재 카페 전화번호', 'Tell me about this place.']) {
    assert.equal(requests.guideSelectionToken(message, selected), selected.selection_token, message);
  }
  for (const message of ['제주 카페 추천', '함덕해변 근처 카페', '현재 지도에서 카페 추천', '한라산 날씨']) {
    assert.equal(requests.guideSelectionToken(message, selected), undefined, message);
  }
  assert.equal(requests.guideSelectionToken('여기 알려줘', { ...selected, id: 'legacy-place' }), undefined);
  assert.equal(requests.guideSelectionToken('여기 알려줘', null), undefined);
});

test('the proof stays a separate POST field and is never added to the question or URL', async () => {
  let request;
  await requests.requestGuide({
    message: '선택한 장소 알려줘', selectionToken: selected.selection_token,
    signal: new AbortController().signal,
  }, { fetchImpl: async (url, options) => { request = { url, ...options }; return new Response('', { status: 200 }); } });
  const body = JSON.parse(request.body);
  assert.equal(body.message, '선택한 장소 알려줘');
  assert.equal(body.selection_token, selected.selection_token);
  assert.ok(!request.url.includes(selected.selection_token));
  assert.equal(request.cache, 'no-store');
});

test('actor-changing auth recovery never replays a previous native selection', async () => {
  let posts = 0, refreshes = 0;
  await assert.rejects(requests.requestGuide({
    message: '이곳 이용시간', selectionToken: selected.selection_token,
    signal: new AbortController().signal,
  }, {
    fetchImpl: async () => {
      posts++;
      return new Response(JSON.stringify({ code: 'csrf_invalid' }), { status: 403 });
    },
    refreshSession: async () => { refreshes++; return 'fresh-session-proof'; },
  }), error => error.code === 'kakao_selection_expired');
  assert.equal(posts, 1);
  assert.equal(refreshes, 1);
});

test('oversized native proofs fail before any request', async () => {
  let calls = 0;
  await assert.rejects(requests.requestGuide({
    message: '선택한 장소', selectionToken: 'x'.repeat(16_001), signal: new AbortController().signal,
  }, { fetchImpl: async () => { calls++; return new Response(''); } }), error => error.code === 'kakao_selection_invalid');
  assert.equal(calls, 0);
});

test('AI-discovered native places carry a minimal reopen hint without saving results or tokens', () => {
  assert.equal(typeof requests.guideReopenHint, 'function');
  const marker = { id: 'kakao:12345', name: '현재 카페', category: '카페', lat: 33.45, lng: 126.55,
    source: 'Kakao Local', observed_at: '2026-09-12T10:00:00.000Z', summary: '' };
  const hint = requests.guideReopenHint(marker);
  assert.equal(hint.id, marker.id);
  assert.equal(hint.updated_at, marker.observed_at);
  assert.equal(hint.selection_token, undefined);
  assert.equal(hint.phone, undefined);
  assert.deepEqual(hint.geometry.coordinates, [126.55, 33.45]);
  assert.equal(requests.guideReopenHint({ ...marker, id: 'legacy-id' }), undefined);
});
