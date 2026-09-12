import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as i18n from '../src/i18n.ts';

const source = await readFile(new URL('../src/guide.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports, require: name => name === './i18n' ? i18n : {} });

function panel(guide, locale = 'ko') {
  i18n.setLocale(locale, null);
  const nodes = new Map();
  const app = Object.create(exports.GuidePanel.prototype);
  app.root = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: '' });
      return nodes.get(selector);
    },
  };
  app.applyConfig({ features: { guide: true }, guide });
  return { app, limit: () => nodes.get('#guide-limit').textContent,
    status: () => nodes.get('#guide-status')?.textContent ?? '' };
}

test('limits_enabled false shows translated app-limits-off copy even with null or stale numeric caps', () => {
  for (const daily_limit of [null, 30]) {
    for (const locale of ['ko', 'en']) {
      const f = panel({ daily_limit, limits_enabled: false }, locale);
      assert.match(f.limit(), locale === 'ko' ? /앱.*한도.*해제/ : /app.*limits.*off/i);
      assert.doesNotMatch(f.limit(), /null|undefined|30|하루 최대|Up to/i);
      assert.match(f.limit(), locale === 'ko' ? /출처/ : /sources/i);
      for (const error of ['daily_limit', 'hourly_limit', 'quota_exceeded']) {
        const copy = f.app.errorMessage(error, 429);
        assert.doesNotMatch(copy, /null|undefined|30|하루 최대|Up to/i);
        if (locale === 'en') assert.doesNotMatch(copy, /[가-힣]/);
      }
    }
  }
  i18n.setLocale('ko', null);
});

test('missing limits_enabled retains the limited daily display; absent counts never render null', () => {
  assert.match(panel({ daily_limit: 30 }).limit(), /하루 최대 30회/);
  assert.match(panel({ daily_limit: 30 }, 'en').limit(), /Up to 30 requests per day/);
  for (const daily_limit of [null, undefined, NaN]) {
    const f = panel({ daily_limit, limits_enabled: true });
    assert.doesNotMatch(f.limit(), /null|undefined|NaN|하루 최대/);
    assert.doesNotMatch(f.app.errorMessage('daily_limit', 429), /null|undefined|NaN/);
  }
  i18n.setLocale('ko', null);
});

test('conversation_busy explains this conversation and differs from service-wide busy in both languages', () => {
  for (const locale of ['ko', 'en']) {
    const f = panel({ daily_limit: null, limits_enabled: false }, locale);
    const conversation = f.app.errorMessage('conversation_busy', 409);
    const service = f.app.errorMessage('guide_busy', 503);
    assert.notEqual(conversation, service);
    assert.match(conversation, locale === 'ko' ? /이 대화/ : /this conversation/i);
    if (locale === 'en') assert.doesNotMatch(conversation, /[가-힣]/);
  }
  i18n.setLocale('ko', null);
});

test('cancelling in limits-off mode never claims to consume a daily allowance', () => {
  for (const locale of ['ko', 'en']) {
    const f = panel({ daily_limit: null, limits_enabled: false }, locale);
    f.app.running = true;
    f.app.controller = new AbortController();
    f.app.cancel();
    assert.equal(f.app.controller.signal.aborted, true);
    assert.match(f.status(), locale === 'ko' ? /기다리기.*중지/ : /waiting stopped/i);
    assert.doesNotMatch(f.status(), /일일|횟수|daily limit|daily allowance/i);
  }
  i18n.setLocale('ko', null);
});

test('browser footer survives KO/EN switches and refreshes; busy errors preserve the conversation without retry', {
  skip: process.env.RUN_GUIDE_LIMITS_BROWSER !== '1', timeout: 45_000,
}, async t => {
  const { createServer: createHttpServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { createServer } = await import('vite');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
    || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
  const temp = await mkdtemp(join(tmpdir(), 'jeju-guide-limits-ui-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const vite = await createServer({
    root: new URL('..', import.meta.url).pathname,
    configFile: false, envFile: false, cacheDir: join(temp, 'vite-cache'),
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  let config = { features: { guide: true }, guide: { daily_limit: null, limits_enabled: false } };
  let respond = null;
  let holdConfig = true;
  let errorCode = 'conversation_busy';
  let streamed = false;
  let requests = 0;
  const document = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"></head><body>
    <button id="locale">English</button><main id="guide"></main>
    <script type="module">
      import { GuidePanel } from '/src/guide.ts';
      import { initializeI18n, setLocale } from '/src/i18n.ts';
      setLocale('ko', null);
      initializeI18n(document.getElementById('locale'), () => {});
      window.panel = new GuidePanel(document.getElementById('guide'), { onApply() {}, notify() {}, context: () => '' });
    </script></body></html>`;
  const server = createHttpServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(document);
    } else if (req.url === '/api/config') {
      const send = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(config));
      };
      if (holdConfig) respond = send; else send();
    } else if (req.url === '/api/guide') {
      for await (const _chunk of req) { /* Drain the submitted question. */ }
      requests++;
      if (streamed) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`event: session\ndata: {"conversation_id":"same-conversation-token"}\n\n`
          + `event: error\ndata: ${JSON.stringify({ code: errorCode })}\n\nevent: done\ndata: {}\n\n`);
      } else {
        res.writeHead(errorCode === 'conversation_busy' ? 409 : 429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: errorCode } }));
      }
    } else vite.middlewares(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    respond?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.panel);
  assert.doesNotMatch(await page.locator('#guide-limit').textContent(), /30|하루 최대|null/);
  holdConfig = false;
  assert.equal(typeof respond, 'function');
  respond();
  respond = null;
  await page.waitForFunction(() => document.getElementById('guide-limit').textContent.includes('해제'));
  await page.click('#locale');
  await page.waitForFunction(() => /app.*limits.*off/i.test(document.getElementById('guide-limit').textContent));
  assert.doesNotMatch(await page.locator('#guide-limit').textContent(), /30|null|[가-힣]/);
  await page.click('#locale');
  await page.waitForFunction(() => document.getElementById('guide-limit').textContent.includes('해제'));
  config = { features: { guide: true }, guide: { daily_limit: 30, limits_enabled: false } };
  await page.click('#guide-refresh');
  await page.waitForFunction(() => !document.getElementById('guide-refresh').disabled);
  assert.doesNotMatch(await page.locator('#guide-limit').textContent(), /30|null|하루 최대/);
  await page.evaluate(() => window.panel.send('안녕하세요'));
  assert.match(await page.locator('#guide-status').textContent(), /이 대화/);
  await page.click('#locale');
  await page.evaluate(() => window.panel.send('Hello'));
  assert.match(await page.locator('#guide-status').textContent(), /this conversation/i);
  errorCode = 'daily_limit';
  await page.evaluate(() => window.panel.send('Hello again'));
  assert.doesNotMatch(await page.locator('#guide-status').textContent(), /30|null|undefined|Up to|[가-힣]/);
  streamed = true;
  errorCode = 'conversation_busy';
  await page.evaluate(() => window.panel.send('Check this conversation'));
  assert.match(await page.locator('#guide-status').textContent(), /this conversation/i);
  assert.equal(await page.evaluate(() => window.panel.conversationId), 'same-conversation-token');
  assert.equal(requests, 4, 'one HTTP submission per explicit send, with no automatic busy retry');
  config = { features: { guide: true }, guide: { daily_limit: 30 } };
  await page.click('#guide-refresh');
  await page.waitForFunction(() => document.getElementById('guide-limit').textContent.includes('Up to 30'));
  await page.click('#locale');
  await page.waitForFunction(() => document.getElementById('guide-limit').textContent.includes('하루 최대 30회'));
  assert.deepEqual(errors, []);
});
