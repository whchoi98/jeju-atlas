import type { FieldEvidence, FieldEvidenceMap } from '../shared/api-types';
import { html, sourceName } from './api.ts';
import { t } from './i18n.ts';

const states: FieldEvidence['state'][] = ['unknown', 'unverified', 'source_reported', 'parsed', 'reviewed'];
const labels: Record<FieldEvidence['state'], string> = {
  unknown: '미확인', unverified: '미검증', source_reported: '출처 기록', parsed: '문구에서 추출', reviewed: '검토됨',
};
function evidenceURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 3000) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function cleanFieldEvidence(value: unknown): FieldEvidenceMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => /^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/.test(key)
    && !['constructor', 'prototype', '__proto__'].includes(key) && entry && typeof entry === 'object').slice(0, 128).map(([key, entry]) => {
    const field = entry as Partial<FieldEvidence>;
    return [key, {
      state: states.includes(field.state as FieldEvidence['state']) ? field.state as FieldEvidence['state'] : 'unknown',
      source: typeof field.source === 'string' ? field.source.slice(0, 140) : null,
      observed_at: typeof field.observed_at === 'string' ? field.observed_at.slice(0, 60) : null,
      evidence_url: evidenceURL(field.evidence_url),
    }];
  }));
}
export function evidenceHTML(fields: FieldEvidenceMap | undefined, path: string): string {
  const evidence = fields?.[path];
  const state = evidence && states.includes(evidence.state) ? evidence.state : 'unknown';
  const source = evidence?.source ? sourceName(evidence.source) : t('출처 미확인');
  const url = evidenceURL(evidence?.evidence_url);
  const sourceText = url ? `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(source)} ↗</a>` : html(source);
  // Never substitute record/build timestamps for a missing field timestamp.
  return `<small class="field-evidence" data-evidence-field="${html(path)}" data-evidence-state="${state}">${html(t(labels[state]))} · ${sourceText}${evidence?.observed_at ? `<span>${t('관측')}: ${html(evidence.observed_at)}</span>` : ''}</small>`;
}
