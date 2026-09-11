import test from 'node:test';
import assert from 'node:assert/strict';

const factory = async () => {
  const module = await import('../server/kakao-quota.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  assert.equal(typeof module.createKakaoQuota, 'function', 'Kakao needs an independent bounded provider budget');
  return module.createKakaoQuota;
};

test('Kakao provider requests use a separate atomic KST-day counter and bounded retention', async () => {
  const create = await factory();
  const commands = [];
  let now = Date.parse('2026-09-11T14:59:59Z');
  const consume = create({ table: 'owned-quota', clock: () => now, client: {
    async send(command) { commands.push(command.input); return {}; },
  } });
  await consume();
  now += 2000;
  await consume();
  assert.deepEqual(commands.map(input => input.Key.id.S), ['kakao#day#2026-09-11', 'kakao#day#2026-09-12']);
  for (const input of commands) {
    assert.equal(input.TableName, 'owned-quota');
    assert.equal(input.ExpressionAttributeValues[':limit'].N, '1000');
    assert.match(input.ConditionExpression, /attribute_not_exists.*OR.*< :limit/);
    assert.equal(input.ExpressionAttributeValues[':one'].N, '1');
    assert.ok(Number(input.ExpressionAttributeValues[':expires'].N) > now / 1000);
    assert.ok(Number(input.ExpressionAttributeValues[':expires'].N) <= now / 1000 + 3 * 86400);
  }
  consume.close();
});

test('conditional denial and unknown AWS failures never approve another provider request', async () => {
  const create = await factory();
  for (const [name, status, code] of [
    ['ConditionalCheckFailedException', 429, 'kakao_daily_limit'],
    ['AccessDeniedException', 503, 'kakao_quota_unavailable'],
  ]) {
    const consume = create({ table: 'owned-quota', client: {
      async send() { throw Object.assign(new Error('must not echo backend details'), { name }); },
    } });
    await assert.rejects(consume(), error => error.status === status && error.code === code
      && !error.message.includes('backend details'));
    consume.close();
  }
});

test('quota limits, cancellation, timeout and closure fail closed', async () => {
  const create = await factory();
  for (const dailyLimit of [0, 1001, NaN, 1.1]) assert.throws(() => create({ dailyLimit }), /limit/i);
  const missing = create();
  await assert.rejects(missing(), error => error.code === 'kakao_quota_unavailable');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const consume = create({ table: 'owned-quota', timeoutMs: 20, client: {
    async send() { calls++; return new Promise(() => {}); },
  } });
  await assert.rejects(consume({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0);
  await assert.rejects(consume(), error => error.code === 'kakao_quota_unavailable');
  assert.equal(calls, 1);
  consume.close();
  await assert.rejects(consume(), error => error.code === 'kakao_quota_unavailable');
  assert.equal(calls, 1);
});
