/** Two application handlers, real browser sessions, shared stores; no AWS model calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';
import { createAdmission, createMemoryAdmissionStore } from '../server/admission.mjs';
import { createPresenceService, createMemoryPresenceStore } from '../server/presence.mjs';

const output = resolve(process.argv[2] || '.local/ai-presence-20260912/browser');
await mkdir(output, { recursive: true });
const report = { passed: false, checks: [], errors: [], controlledGuideResponse: true, modelCalls: 0, maximumActive: 0 };
const presenceStore = createMemoryPresenceStore();
const admissionStore = createMemoryAdmissionStore();
const places = Array.from({ length: 55 }, (_, index) => ({
  id: `fixture-beach-${index}`, name: `시험 해변 ${index + 1}`, name_en: null, category: '해변',
  lat: 33.4, lng: 126.5, address: '브라우저 표시 검사 주소', summary: '실제 방문 안내 자료가 아닙니다.',
  tags: [], source: 'sample', source_label: '시험 자료', base_note: '시험 자료',
  updated_at: null, region: null, avg_stay_min: null, url: null, phone: null, hours: null, distance_m: null,
}));
const catalog = {
  status: () => ({ status: 'ready', total: places.length, by_source: { sample: places.length },
    categories: [{ id: '해변', count: places.length }], built_at: new Date().toISOString(),
    refreshed_at: null, stale: false, photos_count: 0, hours_week_count: 0 }),
  async refreshIfNeeded() {},
  search: ({ offset = 0, limit = 40 } = {}) => ({
    items: places.slice(offset, offset + limit), total: places.length, has_more: offset + limit < places.length,
  }),
  points: () => ({ type: 'FeatureCollection', features: [] }),
  detail: () => null,
};
let release, active = 0, started;
const gate = new Promise(resolve => { release = resolve; });
const allStarted = new Promise(resolve => { started = resolve; });
const invokeEvents = async function* () {
  report.modelCalls++;
  active++;
  report.maximumActive = Math.max(report.maximumActive, active);
  if (active === 4) started();
  try {
    yield { type: 'status', stage: 'thinking' };
    await gate;
    yield { type: 'text', text: '동시 응답 검증 완료. 이 답변은 브라우저 시험 자료입니다.' };
    yield { type: 'map', answer: '동시 응답 검증 완료. 이 답변은 브라우저 시험 자료입니다.', markers: [], route: [], warnings: [] };
    yield { type: 'done' };
  } finally { active--; }
};
const presences = [0, 1].map(() => createPresenceService({ store: presenceStore }));
const admissions = [0, 1].map(() => createAdmission({ store: admissionStore, limitsEnabled: false }));
const handlers = [0, 1].map(index => createApiHandler({
  env: { NODE_ENV: 'test', GUIDE_LIMITS_ENABLED: 'false' },
  secret: 'presence-browser-shared-session-secret-32bytes',
  publicOrigin: 'https://atlas.example.test', catalog, invokeEvents,
  admission: admissions[index], presence: presences[index],
}));
let dispatched = 0;
const server = createAppServer({ root: resolve('dist'), api: (...args) => handlers[dispatched++ % 2](...args) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({
    viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce', serviceWorkers: 'block', locale: 'ko-KR',
  })));
  const open = async context => {
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#visitor-presence').waitFor();
    return page;
  };
  const pages = await Promise.all(contexts.map(open));
  await pages[0].waitForFunction(async () => {
    const result = await fetch('/api/presence').then(response => response.json());
    return result.active_visitors === 3 && result.total_visitors === 3;
  }, null, { timeout: 45_000, polling: 500 });
  const extraTab = await open(contexts[0]);
  await pages[0].reload({ waitUntil: 'domcontentloaded' });
  await pages[0].locator('#visitor-presence').waitFor();
  const sameSession = await pages[0].evaluate(() => fetch('/api/presence').then(response => response.json()));
  assert.equal(sameSession.active_visitors, 3);
  assert.equal(sameSession.total_visitors, 3);
  report.checks.push('Three independent browser sessions are counted once across two handlers; another tab and reload do not increment totals');
  const conversationPages = [...pages, extraTab];
  await Promise.all(conversationPages.map(async (page, index) => {
    await page.locator('#tab-guide').click();
    await page.waitForFunction(() => document.querySelector('#guide-limit')?.textContent.includes('해제'));
    assert.doesNotMatch(await page.locator('#guide-limit').innerText(), /30회|null/);
    await page.locator('#guide-input').fill(`제주를 한 문장으로 안내해 주세요. 시험 ${index + 1}`);
    await page.locator('#guide-send').click();
  }));
  await Promise.race([allStarted, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Four independent guide requests did not start together')), 15_000);
    timer.unref?.();
  })]);
  assert.equal(active, 4);
  release();
  await Promise.all(conversationPages.map(page => page.waitForFunction(() =>
    document.querySelector('#guide-messages')?.textContent.includes('동시 응답 검증 완료')
    && document.querySelector('#guide-send')?.disabled === false)));
  assert.equal(report.modelCalls, 4);
  report.checks.push('Four guide responses, including two independent conversations in one browser, run together without global or actor caps');
  await pages[0].locator('#language-toggle').click();
  await pages[0].waitForFunction(() => document.documentElement.lang === 'en');
  assert.doesNotMatch(await pages[0].locator('#guide-limit').innerText(), /30|null|하루/);
  await pages[0].waitForFunction(() => /Online|Connected|Active/i.test(document.querySelector('#visitor-presence')?.textContent || ''));
  await pages[0].screenshot({ path: resolve(output, 'guide-unlimited-en.png') });
  report.checks.push('AI limits-off and visitor status copy follow the English language toggle');
  await contexts[0].setOffline(true);
  await pages[0].waitForFunction(() => {
    const badge = document.querySelector('#visitor-presence');
    return badge?.hidden || ['stale', 'unavailable'].includes(badge?.dataset.presenceState)
      || /offline|unavailable|last confirmed|오프라인|마지막 확인/i.test(`${badge?.textContent} ${badge?.getAttribute('title')}`);
  });
  assert.doesNotMatch(await pages[0].locator('#visitor-presence').textContent(), /(?:Online|접속)\s*0/);
  report.checks.push('Offline counters do not become a fabricated zero');
  await contexts[0].setOffline(false);
  await pages[1].locator('#tab-explore').click();
  await pages[1].setViewportSize({ width: 375, height: 667 });
  await pages[1].locator('#drawer-toggle').click();
  await pages[1].locator('[data-map-category="해변"]').click();
  await pages[1].waitForFunction(() => document.querySelector('#catalog-list')?.getAttribute('aria-busy') !== 'true');
  const layout = await pages[1].evaluate(() => {
    const root = document.querySelector('#catalog-explorer').getBoundingClientRect();
    const cards = [...document.querySelectorAll('#catalog-list .catalog-card')];
    const footer = document.querySelector('.experience-footer');
    return { visibleCards: cards.filter(card => {
      const rect = card.getBoundingClientRect();
      return rect.top >= root.top - 1 && rect.bottom <= root.bottom + 1;
    }).length, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
    footerOverflow: footer.scrollWidth > footer.clientWidth + 1 };
  });
  assert.ok(layout.visibleCards >= 2, JSON.stringify(layout));
  assert.ok(layout.pageWidth <= layout.viewport + 1 && !layout.footerOverflow, JSON.stringify(layout));
  await pages[1].screenshot({ path: resolve(output, 'presence-mobile.png') });
  report.checks.push('The presence indicator fits the PWA footer while keeping two complete mobile place cards visible');
  report.mobile = layout;
  const replacement = createPresenceService({ store: presenceStore });
  assert.equal((await replacement.snapshot()).total_visitors, 3);
  replacement.close();
  report.checks.push('Cumulative totals survive a service instance replacement');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  release();
  await browser?.close();
  for (const handler of handlers) handler.close();
  for (const service of [...presences, ...admissions]) service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.checkedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
