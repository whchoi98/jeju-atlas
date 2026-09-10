import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const template = await readFile(new URL('../infra/origin-routing.yaml', import.meta.url), 'utf8');
const source = template.match(/ZipFile: !Sub \|\n([\s\S]*?)\n      Tags:/)?.[1]
  .replace(/^ {10}/gm, '')
  .replaceAll('${AlbDomainName}', 'jeju-3d-alb-123.ap-northeast-2.elb.amazonaws.com')
  .replaceAll('${CanonicalHostName}', 'jeju-atlas.whchoi.net');
assert.ok(source, 'Test the exact inline function deployed by CloudFormation');
const exports = {};
const logging = new Proxy({}, { get: () => () => { throw new Error('Request logging is forbidden'); } });
vm.runInNewContext(source, { exports, console: logging });
const handler = exports.handler;
const event = () => ({ Records: [{ cf: {
  config: { eventType: 'origin-request' },
  request: {
    clientIp: '203.0.113.10', method: 'POST', uri: '/api/guide',
    querystring: 'q=%EC%A0%9C%EC%A3%BC&x=a%2Bb',
    headers: {
      host: [{ key: 'Host', value: 'd111111example.cloudfront.net' }],
      origin: [{ key: 'Origin', value: 'https://d111111example.cloudfront.net' }],
      cookie: [{ key: 'Cookie', value: 'fixture-session' }],
      'x-atlas-csrf': [{ key: 'X-Atlas-CSRF', value: 'fixture-proof' }],
    },
    body: { action: 'read-only', data: 'untouched-fixture' },
    origin: { custom: {
      domainName: 'jeju-3d-alb-123.ap-northeast-2.elb.amazonaws.com',
      protocol: 'https', port: 443,
      customHeaders: { 'x-jeju-origin-verify': [{ key: 'X-Jeju-Origin-Verify', value: 'fixture-origin-secret' }] },
    } },
  },
} }] });

test('only Host changes; request body, query, URI, cookies, proof and origin secret remain byte-identical', async () => {
  for (const host of ['jeju-atlas.whchoi.net', 'd111111example.cloudfront.net']) {
    const input = event();
    input.Records[0].cf.request.headers.host[0].value = host;
    const expected = structuredClone(input.Records[0].cf.request);
    expected.headers.host = [{ key: 'Host', value: 'jeju-atlas.whchoi.net' }];
    const result = await handler(input);
    assert.equal(result, input.Records[0].cf.request);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
  }
});

test('unexpected origin, cleartext transport and malformed stages fail without logging their contents', async () => {
  for (const modify of [
    input => { input.Records[0].cf.request.origin.custom.domainName = 'unrelated.example'; },
    input => { input.Records[0].cf.request.origin.custom.protocol = 'http'; },
    input => { input.Records[0].cf.request.origin.custom.port = 80; },
    input => { input.Records[0].cf.request.origin = { s3: {} }; },
    input => { input.Records[0].cf.config.eventType = 'viewer-request'; },
    input => { delete input.Records[0].cf.request; },
    input => { input.Records.push(input.Records[0]); },
  ]) {
    const input = event();
    modify(input);
    await assert.rejects(handler(input), { message: 'Unexpected origin configuration' });
  }
  await assert.rejects(handler(null), { message: 'Unexpected origin configuration' });
});
