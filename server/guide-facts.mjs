import { isIP } from 'node:net';
import { hasCredentialQuery, normalizeOfficialDetails } from './official-details.mjs';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const controls = /[\x00-\x1f\x7f]/;
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const evidenceStates = new Set(['unknown', 'unverified', 'source_reported', 'parsed', 'reviewed']);

function boundedText(value, limit) {
  if (typeof value !== 'string') return null;
  return value.slice(0, limit).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().toWellFormed() || null;
}

function exactText(value, limit) {
  return typeof value === 'string' && value.length <= limit && value.trim()
    && !controls.test(value) && value.isWellFormed() ? value : null;
}

function timestamp(value) {
  const text = exactText(value, 40);
  if (!text) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/.exec(text);
  if (!parts) return null;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = parts.slice(1).map((part) => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
  // LOCALDATA stores source update times without a zone. Preserve the supplied
  // text; appending Z or converting through Date would invent that information.
  return text;
}

function sourceURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value)
    || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // These are display links, never fetch targets. Exclude credentials, IP
    // literals and local hostnames without performing DNS or network requests.
    if (url.username || url.password || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, ''))
      || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|test|invalid)$/.test(host)
      || host.endsWith('.home.arpa') || url.href.length > 2048 || hasCredentialQuery(url)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function facilities(value) {
  const entries = [];
  if (record(value)) {
    for (const key in value) {
      if (!Object.hasOwn(value, key) || !key.trim() || key.length > 60 || controls.test(key)
        || !key.isWellFormed() || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const description = boundedText(value[key], 400);
      if (description === null) continue;
      entries.push([key, description]);
      if (entries.length === 8) break;
    }
  }
  return Object.fromEntries(entries);
}

function hours(value) {
  const rows = [];
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!record(row) || !Number.isInteger(row.day) || row.day < 0 || row.day > 6
        || typeof row.open !== 'string' || !time.test(row.open)
        || typeof row.close !== 'string' || !(time.test(row.close) || row.close === '24:00')) continue;
      rows.push({ day: row.day, open: row.open, close: row.close });
      if (rows.length === 14) break;
    }
  }
  return rows;
}

function sources(value) {
  const rows = [];
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!record(row)) continue;
      const source = boundedText(row.source, 120);
      if (!source) continue;
      rows.push({
        source, url: sourceURL(row.url), observed_at: timestamp(row.observed_at),
        license: exactText(row.license, 120),
        ...(Object.hasOwn(row, 'note') ? { note: boundedText(row.note, 400) } : {}),
      });
      if (rows.length === 8) break;
    }
  }
  return rows;
}

function fieldEvidence(value) {
  const entries = [];
  if (record(value)) {
    for (const [path, entry] of Object.entries(value)) {
      if (path.length > 160 || !/^[a-z][a-z0-9_]*(?:\.(?:[a-z][a-z0-9_]*|\d+))*$/i.test(path)
        || path.split('.').some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
        || !record(entry) || !evidenceStates.has(entry.state)) continue;
      const source = exactText(entry.source, 160);
      const state = !source && ['source_reported', 'parsed', 'reviewed'].includes(entry.state)
        ? 'unknown' : entry.state;
      entries.push([path, {
        state, source, observed_at: timestamp(entry.observed_at), evidence_url: sourceURL(entry.evidence_url),
      }]);
      if (entries.length === 64) break;
    }
  }
  return Object.fromEntries(entries);
}

function officialDetails(value) {
  let details;
  try { details = normalizeOfficialDetails(value); } catch { return []; }
  const result = [];
  const priority = fact => /hours|time|fee|price|ticket|cost|closed|restdate|holiday|phone|contact|infocenter|parking|access|시간|요금|휴무|전화|문의|주차/i
    .test(`${fact.key} ${fact.label_ko} ${fact.label_en}`) ? 0 : 1;
  for (const detail of details) {
    const compact = {
      ...detail, title: boundedText(detail.title, 160), address: boundedText(detail.address, 320),
      website: detail.website && detail.website.length <= 512 ? detail.website : null,
      overview: boundedText(detail.overview, 512), photos: [],
      facts: [...detail.facts].sort((a, b) => priority(a) - priority(b)).slice(0, 6).map(fact => ({
        key: fact.key, label_ko: boundedText(fact.label_ko, 60), label_en: boundedText(fact.label_en, 60),
        value: boundedText(fact.value, 240),
      })),
    };
    while (JSON.stringify(compact).length > 8192 && compact.facts.length > 2) compact.facts.pop();
    // Bound the complete additive payload, not only individual field lengths.
    if (JSON.stringify([...result, compact]).length <= 8192) result.push(compact);
  }
  return result;
}

/**
 * Only call with the exact Catalog.detail result for an accepted marker.
 * Sources describe the enrichment row, not the provenance of each facility.
 * @returns {import('../shared/api-types.ts').GuidePlaceInfo | null}
 */
export function catalogPlaceInfo(place) {
  if (!record(place) || typeof place.id !== 'string' || !place.id || place.id.length > 256) return null;
  const name = boundedText(place.name, 160);
  if (!name) return null;
  return {
    id: place.id, name, facilities: facilities(place.facilities), hours_week: hours(place.hours_week),
    // Do not truncate or infer identifiers from a provider in the sources list.
    hours_source: exactText(place.hours_source, 160), enriched_at: timestamp(place.enriched_at),
    sources: sources(place.sources), base_note: boundedText(place.base_note, 1000),
    // Registration status is preserved without any calculation of "open now".
    business_status: boundedText(place.business_status, 80),
    ...(record(place.field_evidence) ? { field_evidence: fieldEvidence(place.field_evidence) } : {}),
    ...(Object.hasOwn(place, 'registration_note') ? { registration_note: boundedText(place.registration_note, 1000) } : {}),
    ...(Array.isArray(place.official_details) ? { official_details: officialDetails(place.official_details) } : {}),
  };
}
