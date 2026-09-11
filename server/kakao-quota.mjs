/** Fleet-wide provider budget; independent of the AI invocation counters. */
export class KakaoQuotaError extends Error {
  constructor(status, code) {
    super(status === 429 ? '오늘의 카카오 정보 조회 한도에 도달했습니다.'
      : '카카오 정보 조회를 잠시 사용할 수 없습니다.');
    this.name = 'KakaoQuotaError';
    this.status = status;
    this.code = code;
  }
}
const unavailable = () => new KakaoQuotaError(503, 'kakao_quota_unavailable');

export function createKakaoQuota({
  table, dailyLimit = 1000, region = 'ap-northeast-2', clock = Date.now, client, timeoutMs = 4000,
} = {}) {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) throw new Error('Invalid Kakao daily limit');
  let sdk;
  let ownedClient;
  let closed = false;
  const lifetime = new AbortController();
  async function consume({ signal } = {}) {
    signal?.throwIfAborted();
    if (closed || !table) throw unavailable();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(unavailable()), timeoutMs);
    const combined = AbortSignal.any([controller.signal, lifetime.signal, ...(signal ? [signal] : [])]);
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    try {
      await Promise.race([(async () => {
        sdk ??= import('@aws-sdk/client-dynamodb');
        const { DynamoDBClient, UpdateItemCommand } = await sdk;
        combined.throwIfAborted();
        const transport = client || (ownedClient ??= new DynamoDBClient({ region, maxAttempts: 1 }));
        const now = clock();
        const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
        await transport.send(new UpdateItemCommand({
          TableName: table, Key: { id: { S: `kakao#day#${day}` } },
          UpdateExpression: 'SET #expires = :expires ADD #requests :one',
          ConditionExpression: 'attribute_not_exists(#requests) OR #requests < :limit',
          ExpressionAttributeNames: { '#requests': 'requests', '#expires': 'expiresAt' },
          ExpressionAttributeValues: {
            ':one': { N: '1' }, ':limit': { N: String(dailyLimit) },
            ':expires': { N: String(Math.floor(now / 1000) + 3 * 86400) },
          },
        }), { abortSignal: combined });
      })(), interrupted]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error?.name === 'ConditionalCheckFailedException') throw new KakaoQuotaError(429, 'kakao_daily_limit');
      throw unavailable();
    } finally {
      clearTimeout(timeout);
      combined.removeEventListener('abort', abort);
    }
  }
  consume.close = () => { closed = true; lifetime.abort(unavailable()); ownedClient?.destroy(); };
  return consume;
}
