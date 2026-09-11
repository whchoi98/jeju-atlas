import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const emit = (target, type, values = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, values);
  target.dispatchEvent(event);
  return event;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function reader({
  href = 'https://atlas.example/nested/workshop/chapters/01-finish.html',
  secure = true, registrationFailure = false, controlled = true, standalone = false,
} = {}) {
  let source;
  try {
    source = await readFile(new URL('../assets/reader-pwa.js', import.meta.url), 'utf8');
  } catch {
    assert.fail('The reader needs an isolated, fail-safe PWA enhancement');
  }
  const base = new URL('../', href);
  const location = new URL(href);
  let reloads = 0;
  location.reload = () => { reloads++; };
  const worker = (state = 'activated') => Object.assign(new EventTarget(), {
    state, scriptURL: new URL('sw.js', base).href, messages: [],
    postMessage(data) { this.messages.push(data); },
  });
  const registration = Object.assign(new EventTarget(), {
    scope: base.href, active: worker(), installing: null, waiting: null,
    async update() {},
  });
  const calls = [];
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: controlled ? registration.active : { scriptURL: 'https://atlas.example/sw.js' },
    async register(url, options) {
      calls.push({ url, options });
      if (registrationFailure) throw new DOMException('Registration blocked', 'SecurityError');
      return registration;
    },
  });
  let containerReads = 0;
  const navigator = { onLine: true, standalone: false };
  Object.defineProperty(navigator, 'serviceWorker', {
    get() { containerReads++; return serviceWorker; },
  });
  const window = Object.assign(new EventTarget(), {
    location, isSecureContext: secure,
    matchMedia: () => Object.assign(new EventTarget(), { matches: standalone }),
  });
  const selectors = [
    'link[data-workshop-manifest]', '[data-workshop-pwa]', '[data-pwa-status]',
    '[data-pwa-install]', '[data-pwa-update]',
  ];
  const nodes = new Map(selectors.map((selector) => [selector, Object.assign(new EventTarget(), {
    hidden: true, disabled: false, textContent: '', dataset: {},
  })]));
  nodes.get('link[data-workshop-manifest]').dataset.workshopManifest = '../manifest.webmanifest';
  const document = Object.assign(new EventTarget(), {
    readyState: 'complete', visibilityState: 'visible',
    querySelector: (selector) => nodes.get(selector),
  });
  const timers = new Map();
  vm.runInNewContext(source, {
    window, navigator, document, URL, location, console,
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await settle();
  return {
    nodes, calls, registration, serviceWorker, window, navigator, worker, timers,
    get reloads() { return reloads; },
    get containerReads() { return containerReads; },
    get panel() { return nodes.get('[data-workshop-pwa]'); },
    get install() { return nodes.get('[data-pwa-install]'); },
    get update() { return nodes.get('[data-pwa-update]'); },
    get status() { return nodes.get('[data-pwa-status]').textContent; },
  };
}

test('file and insecure readers never touch the service worker container or activate the manifest', async () => {
  for (const options of [
    { href: 'file:///tmp/handbook/chapters/01-finish.html' },
    { href: 'http://insecure.example/workshop/chapters/01-finish.html', secure: false },
  ]) {
    const page = await reader(options);
    assert.equal(page.containerReads, 0);
    assert.equal(page.calls.length, 0);
    assert.equal(page.nodes.get('link[data-workshop-manifest]').href, undefined);
    assert.equal(page.panel.hidden, true);
  }
});

test('a deep chapter registers only its own root worker and relative manifest on HTTPS/localhost', async () => {
  for (const href of [
    'https://atlas.example/nested/workshop/chapters/01-finish.html',
    'http://localhost:8000/workshop/chapters/01-finish.html',
  ]) {
    const page = await reader({ href });
    const base = new URL('../', href);
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].url, new URL('sw.js', base).href);
    assert.equal(new URL(page.calls[0].options.scope, href).href, base.href);
    assert.equal(page.calls[0].options.updateViaCache, 'none');
    assert.equal(page.nodes.get('link[data-workshop-manifest]').href, new URL('manifest.webmanifest', base).href);
    assert.equal(page.panel.hidden, false);
    assert.match(page.status, /오프라인/);
  }
});

test('registration rejection is handled locally and never reloads the reading page', async () => {
  const page = await reader({ registrationFailure: true });
  assert.equal(page.calls.length, 1);
  assert.equal(page.reloads, 0);
  assert.equal(page.update.hidden, true);
  assert.match(page.status, /저장.*없|저장.*실패/);
});

test('install is a reader action and handles a dismissed native prompt without replaying it', async () => {
  const page = await reader();
  let prompts = 0;
  const event = emit(page.window, 'beforeinstallprompt', {
    async prompt() { prompts++; },
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  });
  assert.equal(event.defaultPrevented, true);
  assert.equal(prompts, 0);
  assert.equal(page.install.hidden, false);
  emit(page.install, 'click');
  await settle();
  assert.equal(prompts, 1);
  assert.equal(page.install.disabled, false);
  emit(page.install, 'click');
  await settle();
  assert.equal(prompts, 1);
  assert.match(page.status, /메뉴|홈 화면/);
  emit(page.window, 'appinstalled');
  assert.equal(page.install.hidden, true);
});

test('standalone readers hide the install action and prompt errors remain recoverable', async () => {
  const installed = await reader({ standalone: true });
  assert.equal(installed.install.hidden, true);
  const page = await reader();
  emit(page.window, 'beforeinstallprompt', {
    async prompt() { throw new DOMException('Prompt unavailable'); },
  });
  emit(page.install, 'click');
  await settle();
  assert.equal(page.install.disabled, false);
  assert.equal(page.reloads, 0);
  assert.match(page.status, /메뉴|설치/);
});

test('a waiting update does nothing until clicked, then reloads only after its worker takes control', async () => {
  const page = await reader();
  const waiting = page.worker('installing');
  page.registration.installing = waiting;
  emit(page.registration, 'updatefound');
  waiting.state = 'installed';
  page.registration.waiting = waiting;
  emit(waiting, 'statechange');
  assert.equal(page.update.hidden, false);
  assert.equal(waiting.messages.length, 0);
  assert.equal(page.reloads, 0);
  emit(page.update, 'click');
  assert.equal(waiting.messages.length, 1);
  assert.equal(waiting.messages[0].type, 'WORKSHOP_SKIP_WAITING');
  assert.equal(page.reloads, 0);
  assert.equal(page.update.disabled, true);
  page.serviceWorker.controller = waiting;
  page.registration.waiting = null;
  emit(page.serviceWorker, 'controllerchange');
  assert.equal(page.reloads, 1);
});

test('another tab updating never reloads this tab; its reader can open the new version explicitly', async () => {
  const page = await reader();
  page.serviceWorker.controller = page.worker();
  emit(page.serviceWorker, 'controllerchange');
  assert.equal(page.reloads, 0);
  assert.equal(page.update.hidden, false);
  emit(page.update, 'click');
  assert.equal(page.reloads, 1);
});

test('initial workshop control and unrelated root-worker control never request a reader reload', async () => {
  const page = await reader({ controlled: false });
  page.serviceWorker.controller = page.registration.active;
  emit(page.serviceWorker, 'controllerchange');
  assert.equal(page.update.hidden, true);
  assert.equal(page.reloads, 0);
  page.serviceWorker.controller = { scriptURL: 'https://atlas.example/sw.js' };
  emit(page.serviceWorker, 'controllerchange');
  assert.equal(page.update.hidden, true);
  assert.equal(page.reloads, 0);
});

test('a lost update handshake can be retried without an unexpected delayed reload', async () => {
  const page = await reader();
  page.registration.waiting = page.worker('installed');
  emit(page.update, 'click');
  assert.equal(page.update.disabled, true);
  for (const callback of [...page.timers.values()]) callback();
  assert.equal(page.update.disabled, false);
  assert.equal(page.reloads, 0);
  page.serviceWorker.controller = page.worker();
  emit(page.serviceWorker, 'controllerchange');
  assert.equal(page.reloads, 0);
});
