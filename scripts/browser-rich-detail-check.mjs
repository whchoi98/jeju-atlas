import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';

// Real CatalogUI, controlled provider records. No credentials or live APIs.
const output = resolve(process.argv[2] || '.local/rich-detail-ui');
await mkdir(output, { recursive: true });
let fixturePath = null;
let pilotRecords = {};
for (const candidate of process.env.PILOT_FIXTURE ? [process.env.PILOT_FIXTURE]
  : ['.local/official-details-expanded.json', '.local/official-details-curated.json', '.local/official-details-pilot.json']) {
  try {
    const data = JSON.parse(await readFile(resolve(candidate), 'utf8'));
    assert.ok(data.records && typeof data.records === 'object' && !Array.isArray(data.records));
    pilotRecords = data.records; fixturePath = candidate; break;
  } catch (error) { if (error.code !== 'ENOENT' || process.env.PILOT_FIXTURE) throw error; }
}
const pilotPhotoURLs = new Set(Object.values(pilotRecords).flatMap(records =>
  records.flatMap(record => record.photos || []).map(photo => new URL(photo.url).href)));
const result = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import './src/style.css'; import './src/explore.css';
    import { CatalogUI } from './src/catalog-ui';
    import { initializeI18n } from './src/i18n';
    document.body.classList.add('has-catalog');
    window.selectedRecords = []; window.savedRecords = [];
    const planner = { isSaved: true, isFavorite: () => false, hasStop: () => false,
      add: async p => window.savedRecords.push([p.id,p.lat,p.lng]), toggleFavorite: async () => {} };
    window.catalogUI = new CatalogUI(document.querySelector('#catalog-explorer'), document.querySelector('#catalog-detail'), {
      center: () => ({lng:126.56,lat:33.4}), bounds: () => [126.15,33.1,126.98,33.6],
      onPoints() {}, onVisibility() {}, onSelect: p => window.selectedRecords.push([p.id,p.lat,p.lng]),
      planner, notify() {}, openDrawer() {} });
    initializeI18n(document.querySelector('#language-toggle'), () => {});
  ` },
  bundle: true, write: false, outdir: '/tmp/rich-detail-bundle', format: 'esm', target: 'es2022', external: ['/fonts/*'],
});
const javascript = result.outputFiles.find(file => file.path.endsWith('.js')).contents;
const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).contents;
let base;
const calls = [], errors = [], external = [], checks = [];
function record(provider, locale) {
  return { provider, provider_id: provider + '-record', locale, source_url: provider === 'tourapi'
    ? 'https://api.visitkorea.or.kr/' : `https://www.visitjeju.net/${locale === 'ko' ? 'kr' : 'en'}/detail/view?contentsid=${provider}-record`,
    fetched_at: '2026-09-10T12:00:00Z', title: locale === 'en' ? 'Provider place' : provider + ' 제공처 표기',
    address: locale === 'en' ? '123 Provider Road, Jeju' : '제주 제공처 도로 123', phone: '064-710-7911~2',
    website: 'https://example.org/visitor-information', latitude: 33.402, longitude: 126.561,
    overview: locale === 'en' ? '<p>Woodland trails and an indoor exhibition.</p>'
      : '<p>숲길과 실내 전시공간을 둘러보세요.</p><img src="https://tracker.invalid/pixel" onerror="window.unsafeRich=1"><script>window.unsafeRich=2</script>',
    facts: [
      {key:'heritage1',label_ko:'세계문화유산(제공처 값)',label_en:'World heritage (provider value)',value:'0'},
      {key:'heritage2',label_ko:'세계자연유산(제공처 값)',label_en:'Natural heritage (provider value)',value:'1'},
      {key:'unknown_yn',label_ko:'구분 코드',label_en:'Unknown flag',value:'1'},
      {key:'infocenter',label_ko:'문의 안내',label_en:'Contact information',value:'064-710-7911~2'},
      {key:'tag',label_ko:'제공처 태그',label_en:'Provider tags',value:'nature, walking, visitjeju'},
      {key:'hours',label_ko:'이용시간',label_en:'Visiting hours',value:'09:00–18:00 / Last admission 17:30'},
      {key:'fee',label_ko:'입장료',label_en:'Admission',value:locale === 'en' ? 'Adults: KRW 5,000' : '성인 5,000원'},
      {key:'restday',label_ko:'쉬는 날',label_en:'Closed days',value:locale === 'en' ? 'Every Tuesday' : '매주 화요일'},
      {key:'parking',label_ko:'주차',label_en:'Parking',value:'40 spaces'},
      {key:'access',label_ko:'접근 안내',label_en:'Access',value:'Entrance ramp'},
      {key:'minimum_fee',label_ko:'최소 입장료',label_en:'Minimum admission fee',value:'0'},
    ], photos: [], match: { method: 'name_distance', distance_m: 230 } };
}
function detail(id) {
  const value = { id, name:'카탈로그 장소',name_en:'Catalog place',category:'박물관',lat:33.4,lng:126.56,
    address:'카탈로그 주소',summary:'카탈로그 소개',tags:[],source:'sample',source_label:'큐레이션 시드',
    base_note:'카탈로그 기본 정보',updated_at:'2026-09-08',region:null,avg_stay_min:null,url:null,phone:null,hours:null,distance_m:null,
    photos:[1,2,3,4].map(i => ({url:base+'/photo-'+i+'.svg',thumb_url:base+'/cropped-'+i+'.svg',origin_url:base+'/source/photo-'+i,
      credit:'Fixture photographer '+i,source:'tourapi',license:i===1?'KOGL-3':'KOGL-1'})),
    hours_week:[],hours_source:null,facilities:{},overview:null,menu:[],business_status:null,tips:null,sources:[],enriched_at:null,
    official_details:id==='fixture:plain'?[]:[record('tourapi','ko'),record('visitjeju','ko'),record('tourapi','en')] };
  if (id === 'fixture:three-records') value.official_details = [
    record('tourapi', 'ko'), record('visitjeju', 'ko'),
    { ...record('visitjeju', 'en'), facts: [], phone: null },
  ];
  if (id === 'fixture:visit-only') {
    value.official_details = [record('visitjeju', 'ko'), record('visitjeju', 'en')];
    value.photos = [];
  }
  if (id === 'fixture:no-photo') {
    value.official_details = [record('tourapi', 'ko')];
    value.photos = [];
  }
  if (pilotRecords[id]) {
    value.official_details = pilotRecords[id];
    value.photos = pilotRecords[id].flatMap(record => record.photos || []);
  }
  return value;
}
const markup = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="app"><header class="app-header"><strong>JEJU ATLAS</strong><button id="language-toggle" class="button">English</button></header><main class="atlas-layout"><aside class="sidebar"><div class="sidebar-content"><div id="catalog-explorer"></div></div></aside><section class="map-shell"><section id="catalog-detail" class="catalog-detail" hidden></section></section></main></div><script type="module" src="/bundle.js"></script></body></html>';
const server = createServer(async (req, res) => {
  const path = new URL(req.url, base || 'http://localhost').pathname;
  calls.push(path);
  const send = (type, body) => { res.writeHead(200, {'Content-Type':type}); res.end(body); };
  const json = data => send('application/json', JSON.stringify(data));
  if (path === '/') return send('text/html', markup);
  if (path === '/bundle.js') return send('text/javascript', javascript);
  if (path === '/bundle.css') return send('text/css', stylesheet);
  if (path.startsWith('/fonts/')) {
    try { return send('font/woff', await readFile(resolve('public', path.slice(1)))); } catch { res.writeHead(404); return res.end(); }
  }
  if (/^\/photo-[1234]\.svg$/.test(path)) return send('image/svg+xml', `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="720" height="480" fill="#d8ebe8"/><path d="M0 400L180 150L420 400L550 260L720 420V480H0Z" fill="#187c87"/><text x="35" y="65" font-size="28">${path}</text></svg>`);
  if (path === '/api/catalog/status') return json({status:'ready',total:2,by_source:{sample:2},categories:[{id:'박물관',count:2}],stale:false,built_at:null,refreshed_at:null,attribution:'',photos_count:2,hours_week_count:0});
  if (path === '/api/catalog/search') return json({items:[detail('fixture:rich'),detail('fixture:plain')],total:2,has_more:false});
  if (path.startsWith('/api/catalog/places/')) return json(detail(decodeURIComponent(path.slice('/api/catalog/places/'.length))));
  if (path === '/api/weather') return json({available:false});
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = 'http://127.0.0.1:' + server.address().port;
let browser, page;
const pass = label => { checks.push(label); console.log(label); };
try {
  browser = await chromium.launch({executablePath:'/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',headless:true,args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR',reducedMotion:'reduce'});
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    if (pilotPhotoURLs.has(route.request().url())) return route.fulfill({
      contentType:'image/svg+xml',
      body:'<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="720" height="480" fill="#d8ebe8"/><path d="M0 480L280 100L720 480" fill="#187c87"/><text x="25" y="45" font-size="24">Controlled image response</text></svg>',
    });
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('[data-catalog-id="fixture:rich"]').click();
  await page.locator('#detail-add-trip').waitFor();
  assert.equal(await page.locator('#official-place-details').count(), 1);
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'ko');
  assert.match(await page.locator('#official-provider-panel').innerText(), /성인 5,000원/);
  assert.match(await page.locator('#official-provider-panel').innerText(), /매주 화요일/);
  assert.equal(await page.locator('#official-provider-panel a[href="tel:0647107911"]').count(), 1);
  assert.equal(await page.locator('#official-provider-panel a[href="tel:06471079112"]').count(), 0);
  assert.equal(await page.locator('[data-official-fact^="heritage"], [data-official-fact="unknown_yn"]').count(), 0);
  assert.equal(await page.locator('[data-official-fact="infocenter"]').count(), 0);
  assert.equal(await page.locator('[data-official-fact="minimum_fee"] dd').innerText(), '0');
  assert.equal(await page.locator('.official-more-facts').getAttribute('open'), null);
  assert.deepEqual(await page.locator('.official-primary-facts > div').evaluateAll(rows => rows.slice(0, 2).map(row => row.dataset.officialFact)), ['hours', 'restday']);
  assert.equal(await page.locator('#catalog-reference-details').getAttribute('open'), null);
  assert.match(await page.locator('.official-source > a').innerText(), /정보 제공처/);
  assert.doesNotMatch(await page.locator('.official-source > a').innerText(), /제공처 원문/);
  pass('Provider introduction, contacts and useful visiting facts precede collapsed catalog evidence');
  await page.locator('#detail-photo-image').evaluate(image => image.decode());
  assert.equal(await page.locator('#detail-photo-image').evaluate(image => getComputedStyle(image).objectFit), 'contain');
  assert.match(await page.locator('#detail-photo-image').getAttribute('src'), /photo-1.svg$/);
  await page.locator('#detail-photo-next').click();
  assert.match(await page.locator('#detail-photo-image').getAttribute('src'), /photo-2.svg$/);
  assert.match(await page.locator('#detail-photo-caption').innerText(), /Fixture photographer 2/);
  await page.locator('#detail-photo-next').focus();
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('#detail-photo-image').getAttribute('src'), /photo-3.svg$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'detail-photo-next');
  await page.locator('#detail-photo-caption a').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'detail-photo-origin');
  await page.locator('#detail-photo-image').dispatchEvent('error');
  await page.locator('[data-detail-action="photo-retry"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'detail-photo-gallery');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'detail-photo-gallery');
  assert.ok(!calls.some(path => path.includes('cropped-')));
  assert.equal(await page.evaluate(() => window.unsafeRich), undefined);
  assert.deepEqual(external, []);
  pass('Gallery changes real images and credits with keyboard controls; original images stay uncropped and HTML stays inert');
  await page.locator('#detail-add-trip').click();
  assert.deepEqual(await page.evaluate(() => window.savedRecords.at(-1)), ['fixture:rich',33.4,126.56]);
  assert.deepEqual(await page.evaluate(() => window.selectedRecords.at(-1)), ['fixture:rich',33.4,126.56]);
  pass('Official records never replace the saved or selected catalog ID and coordinates');
  await page.locator('#catalog-detail').screenshot({path:resolve(output,'rich-detail-ko.png')});
  await page.locator('#language-toggle').click();
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'en');
  assert.match(await page.locator('#official-provider-panel').innerText(), /Woodland trails|Adults: KRW 5,000/);
  await page.locator('[data-official-provider="visitjeju"]').click();
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'ko');
  assert.match(await page.locator('#official-provider-panel').innerText(), /Korean source/);
  assert.match(await page.locator('#official-provider-panel').innerText(), /2026/);
  assert.match(await page.locator('.official-source > a').innerText(), /Provider page/);
  pass('English is selected per provider, with explicit Korean fallback and fetched time');
  await page.evaluate(() => window.catalogUI.openPlace('fixture:three-records'));
  await page.locator('#official-provider-panel').waitFor();
  assert.equal(await page.locator('[data-official-provider]').count(), 2);
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'ko');
  assert.match(await page.locator('#official-provider-panel').innerText(), /Korean source/);
  assert.match(await page.locator('[data-official-fact="fee"]').innerText(), /성인 5,000원/);
  assert.match(await page.locator('[data-official-fact="hours"]').innerText(), /09:00–18:00/);
  const unifiedPhoto = await page.locator('#detail-photo-image').getAttribute('src');
  await page.locator('[data-official-provider="visitjeju"]').click();
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'en');
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-provider-id'), 'visitjeju-record');
  const englishPanel = await page.locator('#official-provider-panel').innerText();
  for (const value of ['Provider place', '123 Provider Road', 'Woodland trails']) assert.ok(englishPanel.includes(value));
  assert.equal(await page.locator('#detail-photo-image').getAttribute('src'), unifiedPhoto);
  await page.locator('[data-official-provider="tourapi"]').click();
  assert.match(await page.locator('#official-provider-panel').innerText(), /Korean source/);
  assert.match(await page.locator('[data-official-fact="fee"]').innerText(), /성인 5,000원/);
  pass('TourAPI KO plus VisitJeju KO/EN with the same provider ID selects English per provider without losing Korean fees or changing unified photos');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#catalog-detail').screenshot({path:resolve(output,'rich-detail-mobile.png')});
  await page.locator('[data-detail-action="close"]').click();
  await page.evaluate(() => window.catalogUI.openPlace('fixture:plain'));
  await page.locator('#detail-add-trip').waitFor();
  assert.equal(await page.locator('#official-place-details').count(), 0);
  assert.match(await page.locator('#catalog-detail').innerText(), /카탈로그 소개/);
  pass('Mobile layout and places without official enrichment retain usable details');
  const entries = Object.entries(pilotRecords);
  const hasProvider = (records, provider) => records.some(record => record.provider === provider);
  const noPhotos = records => records.every(record => !record.photos?.length);
  const both = entries.find(([id, records]) => id === 'poi_0008' && hasProvider(records,'tourapi') && hasProvider(records,'visitjeju'))
    ?? entries.find(([, records]) => hasProvider(records,'tourapi') && hasProvider(records,'visitjeju'));
  const visitOnly = entries.find(([id, records]) => id === 'poi_0005' && !hasProvider(records,'tourapi'))
    ?? entries.find(([, records]) => hasProvider(records,'visitjeju') && !hasProvider(records,'tourapi'));
  const photoFree = entries.find(([, records]) => noPhotos(records) && hasProvider(records,'tourapi'))
    ?? entries.find(([id, records]) => id !== visitOnly?.[0] && noPhotos(records));
  const representatives = [
    {kind:'TourAPI + VisitJeju', id:both?.[0] ?? 'fixture:three-records', real:Boolean(both)},
    {kind:'VisitJeju only', id:visitOnly?.[0] ?? 'fixture:visit-only', real:Boolean(visitOnly)},
    {kind:'No photos', id:photoFree?.[0] ?? 'fixture:no-photo', real:Boolean(photoFree)},
  ];
  if (entries.length) assert.ok(representatives.every(item => item.real), 'Requested data must cover all three representative shapes');
  await page.setViewportSize({width:1440,height:1000});
  for (const sample of representatives) {
    const dto = detail(sample.id);
    const photos = [...new Map(dto.photos.map(photo => [new URL(photo.url).href, photo])).values()].slice(0,12);
    const providers = [...new Set(dto.official_details.map(record => record.provider))];
    for (const locale of ['ko','en']) {
      if (await page.locator('html').getAttribute('lang') !== locale) await page.locator('#language-toggle').click();
      await page.evaluate(id => window.catalogUI.openPlace(id), sample.id);
      await page.locator('#official-provider-panel').waitFor();
      assert.equal(await page.locator('[data-official-provider]').count(), providers.length);
      assert.equal(await page.locator('.detail-gallery').count(), photos.length ? 1 : 0);
      if (photos.length) {
        const active = await page.locator('#detail-photo-image').getAttribute('src');
        assert.ok(photos.some(photo => photo.url === active));
        assert.equal(await page.locator('#detail-photo-image').evaluate(image => getComputedStyle(image).objectFit), 'contain');
        assert.equal(await page.locator('#detail-photo-image').evaluate(image => getComputedStyle(image).filter), 'none');
        if (photos.length > 1) assert.match(await page.locator('#detail-photo-count').innerText(), new RegExp('/ '+photos.length+'$'));
      }
      for (const provider of providers) {
        await page.locator(`[data-official-provider="${provider}"]`).click();
        const options = dto.official_details.filter(record => record.provider === provider);
        const selected = options.find(record => record.locale === locale) ?? options.find(record => record.locale === 'ko') ?? options[0];
        assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), selected.locale);
        assert.equal(await page.locator('#official-provider-panel').getAttribute('data-provider-id'), selected.provider_id);
        assert.equal(await page.locator('#official-provider-panel h3').innerText(), selected.title);
        if (locale === 'en' && selected.locale === 'ko') assert.match(await page.locator('.official-language').innerText(), /Korean source/);
        if (provider === 'tourapi') assert.match(await page.locator('.official-source > a').innerText(), locale === 'ko' ? /정보 제공처/ : /Information provider/);
        else assert.match(await page.locator('.official-source > a').innerText(), locale === 'ko' ? /제공처 원문/ : /Provider page/);
        assert.equal(await page.locator('[data-official-fact^="heritage"]').count(), 0);
        const essentials = selected.facts.filter(fact => /usetime|opentime|restdate|restday|usefee|parkingfee|fee|hours/.test(fact.key)
          || /입\s*장\s*료|화장실|이용시간/.test(fact.label_ko));
        for (const fact of essentials) {
          const displayed = await page.locator(`[data-official-fact="${fact.key}"] dd`).innerText();
          assert.equal(displayed.replace(/\s+/g,''), fact.value.replace(/\s+/g,''));
        }
        assert.deepEqual(await page.evaluate(() => window.selectedRecords.at(-1)), [sample.id,33.4,126.56]);
      }
      await page.locator('#catalog-detail').screenshot({path:resolve(output,`${sample.id.replace(/[^a-z0-9_-]/gi,'-')}-${locale}.png`)});
    }
    pass(`${sample.kind}: data-derived provider, locale, photo-count and visitor-fact checks (${sample.id})`);
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output,'report.json'), JSON.stringify({passed:true,controlledProviders:true,controlledImageResponses:true,fixturePath,availablePlaces:entries.length,representatives,locales:['ko','en'],noModelCalls:true,checks,errors},null,2));
} catch (error) {
  if (page) await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(() => {});
  await writeFile(resolve(output,'report.json'), JSON.stringify({passed:false,checks,errors,failure:error.stack},null,2));
  throw error;
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
