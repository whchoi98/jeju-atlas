import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const enabled = process.env.ATLAS_NAVIGATION_BROWSER_TESTS === '1';
test('local navigation supports keyboard selection, history intent, favorites, pins, deletion and locale changes', { skip: !enabled }, async () => {
  let library;
  try { library = await import('../src/place-library.ts'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof library?.PlaceLibrary, 'function');
  const { build } = await import('esbuild');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
    || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {BrowsingHistory} from './src/browsing-history.ts';
      import {SearchSuggestions} from './src/search-suggestions.ts';
      import {PlaceLibrary} from './src/place-library.ts';
      import {snapshot} from './src/saved-data.ts';
      import {setLocale} from './src/i18n.ts';
      window.navigationFixture={BrowsingHistory,SearchSuggestions,PlaceLibrary,snapshot,setLocale};
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
  });
  const css = (await Promise.all(['src/style.css', 'src/navigation-ui.css'].map(path => readFile(path, 'utf8')))).join('\n');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    const unexpectedRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://navigation.test' && url.pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: `<style>${css}
          body {min-width:0;height:auto;overflow:auto;padding:12px} #library{height:630px;margin-top:14px}
          #query{width:100%;height:38px} #outside{margin-top:12px}
          </style><label for="query">장소 검색</label><input id="query" type="search"><div id="suggestions"></div>
          <div id="library"></div><button id="outside">Outside</button>` });
      } else if (url.origin === 'https://navigation.test' && /^\/fonts\/NanumSquare[RB]\.woff$/.test(url.pathname)) {
        await route.fulfill({ contentType: 'font/woff', body: await readFile(`public${url.pathname}`) });
      } else { unexpectedRequests.push(route.request().url()); await route.abort(); }
    });
    await page.goto('https://navigation.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async () => {
      const { BrowsingHistory, SearchSuggestions, PlaceLibrary, snapshot } = window.navigationFixture;
      window.historyStore = new BrowsingHistory();
      window.favorites = Array.from({ length: 6 }, (_, index) => snapshot({
        id: `poi_${index}`, name: index ? `박물관 ${index}` : '협재 카페',
        name_en: index ? `Museum ${index}` : 'Hyeopjae Cafe',
        category: index ? '박물관' : '카페', lat: 33.4, lng: 126.5,
        source: 'sample', source_label: '큐레이션 시드', address: '제주시',
        summary: '', base_note: null, updated_at: '2024-01-02',
      }));
      window.searchCalls = [];
      window.placeCalls = [];
      window.actionCalls = [];
      window.favoriteCalls = [];
      await window.historyStore.rememberQuery('협재 카페');
      await window.historyStore.rememberQuery('성산일출봉');
      await window.historyStore.rememberPlace(window.favorites[0]);
      window.suggestions = new SearchSuggestions(document.querySelector('#query'), document.querySelector('#suggestions'), {
        history: window.historyStore, getFavorites: () => window.favorites,
        onSearch: (query, fromHistory) => window.searchCalls.push({ query, fromHistory }),
        onPlace: place => window.placeCalls.push(place),
      });
      window.library = new PlaceLibrary(document.querySelector('#library'), {
        history: window.historyStore, getFavorites: () => window.favorites,
        onSelect: place => window.placeCalls.push(place),
        onAdd: place => window.actionCalls.push(['add', place.id]),
        onOrigin: place => window.actionCalls.push(['origin', place.id]),
        onDestination: place => window.actionCalls.push(['destination', place.id]),
        onSearch: query => window.searchCalls.push({ query, fromHistory: true }),
        onFavorite: async place => {
          window.favoriteCalls.push(place.id);
          await new Promise(resolve => { window.resolveFavorite = resolve; });
          window.favorites = window.favorites.filter(item => item.id !== place.id);
        },
      });
    });
    const input = page.locator('#query');
    await input.focus();
    assert.equal(await input.getAttribute('role'), 'combobox');
    await input.fill('협재');
    assert.equal(await page.getByRole('listbox').getByRole('option').count(), 2);
    await input.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.searchCalls), [{ query: '협재', fromHistory: false }]);
    assert.deepEqual(await page.evaluate(() => window.historyStore.queries), ['성산일출봉', '협재 카페'], 'partial typing and callbacks do not themselves record history');
    await input.fill('협재');
    await input.press('ArrowDown');
    const selected = await input.getAttribute('aria-activedescendant');
    assert.ok(selected);
    assert.equal(await page.locator(`#${selected}`).getAttribute('aria-selected'), 'true');
    await input.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.searchCalls.at(-1)), { query: '협재 카페', fromHistory: true });
    await input.fill('새 결과');
    await page.evaluate(() => window.suggestions.setResults([{
      ...window.favorites[0], id: 'kakao:123', name: '새 결과 카페', source: 'Kakao Local', source_label: 'Kakao Local',
      geometry: { type: 'Point', coordinates: [126.5, 33.4] }, selection_token: 'transient-proof',
    }]));
    await page.getByRole('listbox').getByRole('option').click();
    const chosen = await page.evaluate(() => window.placeCalls.at(-1));
    assert.equal(chosen.id, 'kakao:123');
    assert.equal(chosen.selection_token, undefined);
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await input.fill('협재');
    await input.press('Escape');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await input.fill('협재');
    await page.locator('#outside').click();
    assert.equal(await input.getAttribute('aria-expanded'), 'false');

    const root = page.locator('#library');
    await root.locator('[data-library-filter]').fill('협재');
    assert.equal(await root.locator('[data-library-id]').count(), 1);
    await page.evaluate(() => window.library.render());
    assert.equal(await root.locator('[data-library-filter]').inputValue(), '협재');
    assert.equal(await root.locator('[data-library-filter]').evaluate(input => document.activeElement === input), true);
    await root.locator('[data-library-filter]').fill('');
    await root.locator('[data-library-category]').selectOption('박물관');
    assert.equal(await root.locator('[data-library-id]').count(), 5);
    await root.locator('[data-library-category]').selectOption('');
    for (let i = 0; i < 5; i++) await root.locator(`[data-library-id="poi_${i}"] [data-library-action="pin"]`).click();
    await page.waitForFunction(() => window.historyStore.pinnedIds.length === 5);
    await root.locator('[data-library-id="poi_5"] [data-library-action="pin"]').click();
    assert.equal(await page.evaluate(() => window.historyStore.pinnedIds.length), 5);
    assert.equal(await root.locator('[data-library-pinned]').count(), 5);
    const first = root.locator('[data-library-id="poi_0"]');
    await first.locator('[data-library-action="origin"]').click();
    await first.locator('[data-library-action="destination"]').click();
    await first.locator('[data-library-action="add"]').click();
    assert.deepEqual(await page.evaluate(() => window.actionCalls), [['origin', 'poi_0'], ['destination', 'poi_0'], ['add', 'poi_0']]);
    await first.locator('[data-library-action="favorite"]').click();
    assert.equal(await first.locator('[data-library-action="favorite"]').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.favoriteCalls), ['poi_0']);
    await page.evaluate(() => window.resolveFavorite());
    await page.waitForFunction(() => window.favorites.length === 5 && !window.historyStore.pinnedIds.includes('poi_0'));
    await root.locator('[data-library-tab="recent"]').click();
    assert.equal(await root.locator('[data-library-id]').count(), 1);
    await root.locator('[data-library-clear="places"]').click();
    await page.waitForFunction(() => window.historyStore.places.length === 0);
    assert.equal(await page.evaluate(() => window.favorites.length), 5);
    assert.equal(await page.evaluate(() => window.historyStore.queries.length), 2);
    await root.locator('[data-library-tab="queries"]').click();
    await root.locator('[data-library-query-open]').first().click();
    assert.equal((await page.evaluate(() => window.searchCalls.at(-1))).fromHistory, true);
    await root.locator('[data-library-clear="queries"]').click();
    await page.waitForFunction(() => window.historyStore.queries.length === 0);
    await page.evaluate(() => window.navigationFixture.setLocale('en', null));
    assert.match(await root.innerText(), /Recent searches|No recent searches/);
    await root.locator('[data-library-tab="favorites"]').click();
    assert.equal(await root.locator('[data-library-tab="favorites"]').getAttribute('aria-selected'), 'true');
    await root.locator('[data-library-tab="favorites"]').press('ArrowRight');
    assert.equal(await root.locator('[data-library-tab="recent"]').getAttribute('aria-selected'), 'true');
    assert.equal(await root.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.deepEqual(unexpectedRequests, []);
    await page.evaluate(() => { window.suggestions.dispose(); window.library.dispose(); window.historyStore.dispose(); });
    assert.equal(await input.getAttribute('role'), null);
  } finally { await browser.close(); }
});
