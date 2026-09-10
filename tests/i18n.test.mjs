import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGuide } from '../src/guide-request.ts';

let i18n;
try { i18n = await import('../src/i18n.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('Korean is the default; a valid language choice persists and invalid or denied storage is safe', () => {
  assert.equal(typeof i18n?.readLocale, 'function');
  const storage = memory();
  assert.equal(i18n.readLocale(storage), 'ko');
  assert.equal(i18n.setLocale('en', storage), true);
  assert.equal(i18n.readLocale(storage), 'en');
  assert.throws(() => i18n.setLocale('fr', storage));
  assert.equal(i18n.readLocale({ getItem() { throw new Error('denied'); } }), 'ko');
  assert.equal(i18n.setLocale('ko', { setItem() { throw new Error('denied'); } }), false);
  assert.equal(i18n.getLocale(), 'ko');
});

test('primary UI translations are reversible and do not invent translations of place names', () => {
  assert.equal(typeof i18n?.t, 'function');
  i18n.setLocale('en', memory());
  assert.equal(i18n.t('내 여행'), 'My trip');
  assert.equal(i18n.t('지도에 표시'), 'Show on map');
  assert.equal(i18n.t('생각 중'), 'Thinking');
  assert.equal(i18n.placeName({ name: '한라산', name_en: 'Hallasan' }), 'Hallasan');
  assert.equal(i18n.placeName({ name: '원문 장소 이름' }), '원문 장소 이름');
  assert.equal(i18n.t('3곳'), '3 places');
  i18n.setLocale('ko', memory());
  assert.equal(i18n.t('My trip'), '내 여행');
  assert.equal(i18n.t('3 places'), '3곳');
  assert.equal(i18n.placeName({ name: '한라산', name_en: 'Hallasan' }), '한라산');
});

test('captured request locale and UUID are unchanged by a language switch during the sole auth recovery', async () => {
  const options = {
    message: 'Restaurants near Hallasan?', locale: 'en',
    requestId: '1d5e7700-2d1a-47d7-9f93-780c4a09ce04', signal: new AbortController().signal,
  };
  const calls = [];
  await requestGuide(options, {
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      options.locale = 'ko';
      options.requestId = '5ad9e6b0-758b-4d8b-9d54-525f3e1cc454';
      return calls.length === 1
        ? new Response(JSON.stringify({ error: { code: 'invalid_conversation' } }), { status: 403 })
        : new Response('event: done\ndata: {}\n\n');
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.locale), ['en', 'en']);
  assert.equal(calls[0].request_id, calls[1].request_id);
});

test('unsupported request locales are rejected before any model request', async () => {
  let requests = 0;
  await assert.rejects(requestGuide({ message: 'hello', locale: 'en-US', signal: new AbortController().signal }, {
    fetchImpl: async () => { requests++; return new Response(''); },
  }));
  assert.equal(requests, 0);
});
