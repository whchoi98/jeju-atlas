const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_MESSAGE = '날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
const numberOrNull = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const codeOrNull = (value) => Number.isInteger(value) && value >= 0 ? value : null;

export function inJeju(lat, lng) {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= 33.1 && lat <= 33.6
    && typeof lng === 'number' && Number.isFinite(lng) && lng >= 126.15 && lng <= 126.98;
}

function weatherSummary(code) {
  if (code === 0) return '맑음';
  if (code === 1) return '대체로 맑음';
  if (code === 2) return '구름 조금';
  if (code === 3) return '흐림';
  if ([45, 48].includes(code)) return '안개';
  if ([51, 53, 55].includes(code)) return '이슬비';
  if ([56, 57, 66, 67].includes(code)) return '어는 비';
  if ([61, 63, 65].includes(code)) return '비';
  if ([71, 73, 75, 77].includes(code)) return '눈';
  if ([80, 81, 82].includes(code)) return '소나기';
  if ([85, 86].includes(code)) return '눈 소나기';
  if ([95, 96, 99].includes(code)) return '뇌우';
  return '날씨 정보 없음';
}

function normalizeWeather(raw, lat, lng, now) {
  const current = raw?.current;
  const daily = raw?.daily;
  if (!current || typeof current.time !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(current.time)
    || !Array.isArray(daily?.time) || daily.time.length < 3
    || !daily.time.slice(0, 3).every((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error('Invalid forecast');
  }
  const values = [current.temperature_2m, current.wind_speed_10m, current.precipitation, current.weather_code];
  if (values.every((value) => numberOrNull(value) === null)) throw new Error('Empty forecast');
  const code = codeOrNull(current.weather_code);
  return {
    available: true, lat, lng, source: 'Open-Meteo', fetched_at: new Date(now).toISOString(),
    current: {
      time: current.time, temperature_c: numberOrNull(current.temperature_2m),
      wind_kmh: numberOrNull(current.wind_speed_10m), precipitation_mm: numberOrNull(current.precipitation),
      weather_code: code, summary: weatherSummary(code),
    },
    daily: daily.time.slice(0, 3).map((date, index) => ({
      date, min_c: numberOrNull(daily.temperature_2m_min?.[index]),
      max_c: numberOrNull(daily.temperature_2m_max?.[index]),
      precipitation_probability: numberOrNull(daily.precipitation_probability_max?.[index]),
      weather_code: codeOrNull(daily.weather_code?.[index]),
    })),
  };
}

// Bound an upstream body even when it has no Content-Length.
async function readForecast(response) {
  if (!response.ok) throw new Error('Forecast unavailable');
  if (Number(response.headers?.get('content-length')) > 256 * 1024) throw new Error('Forecast too large');
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw new Error('Forecast too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Five-minute internal cache; neither API responses nor failures are publicly cached. */
export function createWeatherService({
  fetch: fetchImpl = globalThis.fetch, clock = Date.now,
  timeoutMs = 5000, ttlMs = 5 * 60_000, maxEntries = 256, maxPending = 32,
} = {}) {
  const cache = new Map();
  let pending = 0;
  let closed = false;
  const unavailable = (lat, lng) => ({
    available: false, lat, lng, source: 'Open-Meteo', fetched_at: new Date(clock()).toISOString(),
    current: null, daily: [], message: WEATHER_MESSAGE,
  });

  function get({ lat, lng }) {
    if (!inJeju(lat, lng)) throw new RangeError('Coordinates must be inside Jeju');
    if (closed) return Promise.resolve(unavailable(lat, lng));
    const key = `${lat},${lng}`;
    const now = clock();
    for (const [cachedKey, entry] of cache) {
      if (!entry.pending && entry.expiresAt <= now) cache.delete(cachedKey);
    }
    const existing = cache.get(key);
    if (existing) {
      cache.delete(key);
      cache.set(key, existing);
      return existing.promise;
    }
    if (pending >= maxPending) return Promise.resolve(unavailable(lat, lng));
    if (cache.size >= maxEntries) {
      const oldest = [...cache].find(([, entry]) => !entry.pending);
      if (!oldest) return Promise.resolve(unavailable(lat, lng));
      cache.delete(oldest[0]);
    }
    const controller = new AbortController();
    const entry = { pending: true, controller, expiresAt: 0, promise: null };
    cache.set(key, entry);
    pending++;
    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
      latitude: String(lat), longitude: String(lng), timezone: 'Asia/Seoul', forecast_days: '3',
      current: 'temperature_2m,wind_speed_10m,precipitation,weather_code',
      daily: 'temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code',
      temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm',
    }).toString();
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Forecast aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    entry.promise = (async () => {
      try {
        const work = (async () => {
          const response = await fetchImpl(url, {
            signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' },
          });
          return normalizeWeather(await readForecast(response), lat, lng, clock());
        })();
        const result = await Promise.race([work, aborted]);
        entry.expiresAt = clock() + ttlMs;
        return result;
      } catch {
        cache.delete(key);
        return unavailable(lat, lng);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        entry.pending = false;
        pending--;
      }
    })();
    return entry.promise;
  }
  return {
    get,
    close() {
      closed = true;
      for (const entry of cache.values()) if (entry.pending) entry.controller.abort();
      cache.clear();
    },
  };
}
