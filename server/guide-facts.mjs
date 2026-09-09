import { isIP } from 'node:net';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const controls = /[\x00-\x1f\x7f]/;
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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
  return text && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text) && Number.isFinite(Date.parse(text)) ? text : null;
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
      || host.endsWith('.home.arpa') || url.href.length > 2048) return null;
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
  };
}
