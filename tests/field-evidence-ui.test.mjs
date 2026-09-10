import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../src/i18n.ts';
let subject;
try { subject = await import('../src/field-evidence.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('field evidence preserves uncertainty and parsed status independently from the facility value', () => {
  assert.equal(typeof subject?.evidenceHTML, 'function');
  const fields = {
    lat: { state: 'unverified', source: 'sample', observed_at: null, evidence_url: null },
    'facilities.parking': { state: 'unknown', source: null, observed_at: null, evidence_url: null },
    hours_week: { state: 'parsed', source: 'tourapi_usetime', observed_at: null, evidence_url: null },
  };
  setLocale('ko', null);
  assert.match(subject.evidenceHTML(fields, 'lat'), /미검증/);
  assert.match(subject.evidenceHTML(fields, 'facilities.parking'), /출처 미확인/);
  assert.match(subject.evidenceHTML(fields, 'hours_week'), /문구에서 추출/);
  assert.doesNotMatch(subject.evidenceHTML(fields, 'hours_week'), /검토됨|공식 검증/);
  setLocale('en', null);
  assert.match(subject.evidenceHTML(fields, 'facilities.parking'), /Source unconfirmed/);
  assert.match(subject.evidenceHTML(fields, 'hours_week'), /Parsed from text/);
  setLocale('ko', null);
});

test('unknown states cannot become reviewed evidence and unsafe evidence links never render', () => {
  assert.equal(typeof subject?.cleanFieldEvidence, 'function');
  const fields = subject.cleanFieldEvidence({
    lat: { state: 'verified', source: '<img onerror=alert(1)>', observed_at: null, evidence_url: 'javascript:alert(1)' },
    hours_week: { state: 'parsed', source: 'tourapi_usetime', observed_at: null, evidence_url: 'https://user:password@example.com/' },
  });
  assert.equal(fields.lat.state, 'unknown');
  assert.equal(fields.lat.evidence_url, null);
  assert.equal(fields.hours_week.evidence_url, null);
  assert.doesNotMatch(subject.evidenceHTML(fields, 'lat'), /<img|href="javascript:|password/);
  assert.equal(fields.lat.observed_at, null);
});
