import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { guideSelectionToken } from '../src/guide-request.ts';
import { snapshot } from '../src/saved-data.ts';

const source = await readFile(new URL('../src/explore.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function experience() {
  const exports = {};
  const elements = new Map();
  let mapClick;
  const node = () => {
    const children = new Map(), handlers = new Map();
    return {
      hidden: false, setAttribute() {},
      addEventListener(type, callback) { handlers.set(type, callback); },
      click() { handlers.get('click')?.(); },
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, node());
        return children.get(selector);
      },
    };
  };
  const document = {
    body: { dataset: {} },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
  };
  const modules = {
    './trip': { snapshot },
    './icons': { icon: () => '', categorySymbol: () => ({ icon: 'pin' }) },
    './api': { html: String, categoryName: String },
    './i18n': { placeName: place => place.name },
    './catalog-map': { CatalogMap: class {
      constructor(_map, click) { mapClick = click; }
      setTrip() {}
      setSelection() {}
    } },
  };
  vm.runInNewContext(code, {
    exports, require: name => modules[name] ?? {}, document,
    window: { dispatchEvent() {} }, CustomEvent: class {},
  });
  // Exercise the real selection/tab methods; map rendering is independent of
  // proof lifetime and is omitted from this small DOM harness.
  const app = Object.create(exports.AtlasExperience.prototype);
  let detail = null;
  app.options = { stopTour() {}, closeDrawer() {}, atlas: () => undefined };
  app.mobileViewport = { matches: true };
  app.activeTab = 'explore';
  app.renderSelection = () => {};
  app.planner = { hasStop: () => false };
  app.tripStops = [];
  const opened = [];
  app.catalog = {
    get selection() { return detail; },
    closeDetail() { detail = null; },
    openPlace(id, hint) { opened.push({ id, hint }); },
    pointData: { features: [] }, onMapReady() {},
  };
  return {
    app, opened, document,
    setDetail(value) { detail = value; },
    render(place) { exports.AtlasExperience.prototype.renderSelection.call(app, place); },
    clickMap(id) { mapClick(id); },
  };
}

const place = { id: 'kakao:12345', name: '현재 카페', lat: 33.45, lng: 126.55, category: '카페',
  source: 'Kakao Local', source_label: '카카오 조회 정보', summary: '', updated_at: '2026-09-12T10:00:00.000Z' };

test('manual detail close and switching to Guide retain one matching native proof', () => {
  for (const manuallyClose of [false, true]) {
    const f = experience();
    f.setDetail({ ...place, selection_token: 'current-proof', phone: 'do-not-retain-extra-fields' });
    f.app.selectCatalog(place);
    if (manuallyClose) f.app.catalog.closeDetail();
    f.app.showTab('guide');
    assert.equal(f.app.catalog.selection, null);
    assert.equal(typeof f.app.currentNativeSelection, 'function', 'Guide needs the retained selected proof');
    const selection = f.app.currentNativeSelection();
    assert.equal(guideSelectionToken('여기 이용시간 알려줘', selection), 'current-proof');
    assert.deepEqual(Object.keys(selection).sort(), ['id', 'name', 'selection_token']);
  }
});

test('changed/legacy selections clear the proof and a same-place refresh replaces it', () => {
  const f = experience();
  f.setDetail({ ...place, selection_token: 'old-proof' });
  f.app.selectCatalog(place);
  f.setDetail({ ...place, selection_token: 'new-proof' });
  f.app.selectCatalog(place);
  assert.equal(f.app.currentNativeSelection().selection_token, 'new-proof');
  f.app.catalog.closeDetail();
  f.app.selectCatalog({ ...place, id: 'kakao:54321' });
  assert.equal(f.app.currentNativeSelection(), null);
  f.setDetail({ ...place, selection_token: 'another-proof' });
  f.app.selectCatalog(place);
  f.app.legacySelected();
  assert.equal(f.app.currentNativeSelection(), null);
  f.app.selectCatalog({ ...place, id: 'legacy-place' });
  assert.equal(f.app.currentNativeSelection(), null);
});

test('the selected-place detail button can reopen an evicted native result with a clean snapshot', () => {
  const f = experience();
  const selected = { ...place, selection_token: 'must-not-enter-the-reopen-hint' };
  f.app.selectCatalog(selected);
  f.app.catalog.closeDetail();
  f.render(selected);
  f.document.getElementById('selected-place').querySelector('#selected-catalog-detail').click();
  assert.equal(f.opened[0].id, place.id);
  assert.equal(f.opened[0].hint?.name, place.name);
  assert.equal(f.opened[0].hint?.updated_at, place.updated_at);
  assert.equal(f.opened[0].hint.selection_token, undefined);
});

test('a current-selection map marker can reopen after native page eviction without a token', () => {
  const f = experience();
  f.app.selectCatalog({ ...place, selection_token: 'must-not-enter-the-reopen-hint' });
  f.app.catalog.closeDetail();
  f.app.onMapReady({ map: { on() {} }, setRepresentativeSelectHandler() {} });
  f.clickMap(place.id);
  assert.equal(f.opened[0].id, place.id);
  assert.equal(f.opened[0].hint?.name, place.name);
  assert.equal(f.opened[0].hint?.lat, place.lat);
  assert.equal(f.opened[0].hint.selection_token, undefined);
});
