import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'atlas_sid';
const SESSION_AGE_MS = 30 * 24 * 60 * 60_000;
const CONVERSATION_AGE_MS = 14 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Session and conversation signatures use separate HMAC domains. Only the
 * derived actor ID reaches AgentCore; neither the cookie nor its sid does.
 */
export function createSessions({ secret, clock = Date.now }) {
  if ((typeof secret !== 'string' && !Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32) {
    throw new Error('ATLAS_SESSION_SECRET must contain at least 32 bytes');
  }
  const digest = (purpose, value) => createHmac('sha256', secret).update(`${purpose}\0${value}`).digest();
  const actorFor = (sid) => `atlas_${digest('actor', sid).toString('hex')}`;
  const sign = (purpose, data) => {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${digest(purpose, payload).toString('base64url')}`;
  };
  function verify(purpose, token, maxAge) {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || parts.some((part) => !BASE64URL.test(part))) return null;
    const [payload, signature] = parts;
    const supplied = Buffer.from(signature, 'base64url');
    const expected = digest(purpose, payload);
    // Reject noncanonical encodings as well as invalid signatures.
    if (supplied.toString('base64url') !== signature || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)) return null;
    try {
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) return null;
      const data = JSON.parse(bytes.toString('utf8'));
      const age = clock() - data.iat;
      if (data.v !== 1 || !Number.isSafeInteger(data.iat) || age < 0 || age >= maxAge) return null;
      return data;
    } catch {
      return null;
    }
  }
  return {
    readCookie(header) {
      if (typeof header !== 'string' || header.length > 8192) return null;
      const matching = header.split(';').map((part) => part.trim())
        .filter((part) => part.slice(0, part.indexOf('=')) === COOKIE_NAME);
      if (matching.length !== 1) return null;
      const token = matching[0].slice(COOKIE_NAME.length + 1);
      const data = verify('session', token, SESSION_AGE_MS);
      if (!data || typeof data.sid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.sid)) return null;
      return { actorId: actorFor(data.sid) };
    },
    issueCookie(res) {
      const sid = randomBytes(32).toString('base64url');
      const token = sign('session', { v: 1, sid, iat: clock() });
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_AGE_MS / 1000}; HttpOnly; Secure; SameSite=Lax`);
      return { actorId: actorFor(sid) };
    },
    createConversation(actorId) {
      const id = randomUUID();
      return { id, token: sign('conversation', { v: 1, id, actor: actorId, iat: clock() }) };
    },
    verifyConversation(token, actorId) {
      const data = verify('conversation', token, CONVERSATION_AGE_MS);
      return data && data.actor === actorId && typeof data.id === 'string' && UUID.test(data.id)
        ? { id: data.id, token } : null;
    },
  };
}
