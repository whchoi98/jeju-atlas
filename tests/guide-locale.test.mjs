import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';
import { createAgentInvoker, normalizeGuideMap } from '../server/guide.mjs';
import { createAdmission, createMemoryAdmissionStore } from '../server/admission.mjs';
import { prepareGuideGrounding, catalogReference } from '../server/guide-grounding.mjs';

const origin = 'https://locale.example.test';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-locale-'));
  await writeFile(join(root, 'index.html'), '<title>Locale fixture</title>');
  const payloads = [];
  const invokeEvents = createAgentInvoker({
    runtimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/LocaleTest-1234567890',
    client: {
      async send(command) {
        payloads.push(JSON.parse(Buffer.from(command.input.payload).toString()));
        return { contentType: 'application/json', response: Readable.from([Buffer.from(JSON.stringify({
          answer: 'An actual fixture answer.', markers: [], route: [], warnings: [],
        }))]) };
      },
    },
  });
  const api = createApiHandler({
    env: { NODE_ENV: 'production' }, secret: 'locale-test-signing-secret-more-than-32-bytes',
    publicOrigin: origin, admission: createAdmission({ store: createMemoryAdmissionStore() }), invokeEvents,
  });
  const server = createAppServer({ root, api });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await fetch(`${base}/api/config`);
  const cookie = config.headers.get('set-cookie').split(';')[0];
  const post = body => fetch(`${base}/api/guide`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { post, payloads };
}

test('HTTP locale defaults to Korean, forwards English to the SDK, and participates in request identity', async t => {
  const f = await fixture(t);
  const first = { message: '안녕하세요', request_id: randomUUID() };
  const ko = await f.post(first);
  assert.equal(ko.status, 200);
  await ko.text();
  assert.equal(f.payloads[0].locale, 'ko');
  const equivalent = await f.post({ ...first, locale: 'ko' });
  assert.equal(equivalent.status, 409);
  assert.equal((await equivalent.json()).error.code, 'request_completed');
  const conflict = await f.post({ ...first, locale: 'en' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'request_conflict');
  const en = await f.post({ message: 'Hello', request_id: randomUUID(), locale: 'en' });
  assert.equal(en.status, 200);
  const output = await en.text();
  assert.equal(f.payloads[1].locale, 'en');
  assert.equal(f.payloads[1].prompt, 'Hello');
  assert.match(output, /AI is thinking/);
  assert.equal(f.payloads.length, 2);
});

test('unsupported locales are rejected before any SDK invocation', async t => {
  const f = await fixture(t);
  for (const locale of ['en-US', 'EN', '', null, {}, 1]) {
    const response = await f.post({ message: 'Hello', request_id: randomUUID(), locale });
    assert.equal(response.status, 400);
  }
  assert.equal(f.payloads.length, 0);
});

test('English grounding and supplements retain canonical data and source evidence with English caveats', () => {
  const place = {
    id: 'family', name: '가족 공원', category: '관광지', tags: ['가족'], source: 'sample',
    lat: 33.4, lng: 126.5, facilities: { parking: 'yes', restroom: 'unknown' }, hours_week: [],
    base_note: '미검증 시드', business_status: 'closed_permanently',
    field_evidence: { tags: { state: 'unverified', source: 'sample', observed_at: null, evidence_url: null } },
  };
  const catalog = { search: () => ({ items: [place] }), detail: () => place };
  const question = 'Recommend places to visit with children.';
  const grounding = prepareGuideGrounding(question, catalog, 'en');
  assert.ok(grounding.prompt.startsWith(question));
  assert.ok(grounding.prompt.length <= 2000);
  assert.equal(grounding.candidates[0].name, '가족 공원');
  assert.match(grounding.prompt, /unverified/);
  assert.match(grounding.prompt, /individual permit/);
  assert.match(grounding.prompt, /source/);
  const reference = catalogReference('No places identified.', grounding, 'en');
  assert.match(reference.appendix, /Catalog reference/);
  assert.match(reference.appendix, /reported present/);
  assert.match(reference.appendix, /unknown/);
  assert.match(reference.appendix, /unverified/);
  assert.equal(reference.markers[0], place);
  const map = normalizeGuideMap({ answer: 'An answer.', markers: [place] }, { catalog, locale: 'en' });
  assert.ok(map.warnings.some(warning => /verified/.test(warning)));
  assert.equal(map.place_info[0].field_evidence.tags.state, 'unverified');
});
