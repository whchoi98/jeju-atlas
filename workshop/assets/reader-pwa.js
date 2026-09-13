(function () {
  'use strict';
  // A downloaded handbook must remain a plain file reader. Do not even access
  // ServiceWorkerContainer (or fetch a manifest) on file:// or insecure HTTP.
  if (!/^https?:$/.test(window.location.protocol) || !window.isSecureContext
    || !('serviceWorker' in navigator)) return;

  const $ = (selector) => document.querySelector(selector);
  const manifest = $('link[data-workshop-manifest]');
  const panel = $('[data-workshop-pwa]');
  const status = $('[data-pwa-status]');
  const install = $('[data-pwa-install]');
  const update = $('[data-pwa-update]');
  if (!manifest || !panel || !status || !install || !update) return;

  let workers;
  let base;
  try {
    workers = navigator.serviceWorker;
    const manifestURL = new URL(manifest.dataset.workshopManifest, window.location.href);
    base = new URL('./', manifestURL);
    if (base.origin !== window.location.origin || !window.location.pathname.startsWith(base.pathname)) return;
    manifest.href = manifestURL.href;
  } catch (_) { return; }
  let handout;
  if ($('[data-public-handbook]')) {
    handout = document.createElement('a');
    handout.className = 'pwa-button';
    handout.dataset.handbookDownload = '';
    handout.href = new URL('downloads/jeju-atlas-workshop-handbook.zip', base).href;
    handout.download = 'jeju-atlas-workshop-handbook.zip';
    handout.textContent = '교재 ZIP';
    $('.pwa-actions').append(handout);
  }
  const workerURL = new URL('sw.js', base).href;
  const isWorkshopWorker = (worker) => worker?.scriptURL === workerURL;
  const standalone = window.matchMedia('(display-mode: standalone)');
  let installed = standalone.matches || navigator.standalone === true;
  let registration;
  let prompt;
  let ready = false;
  let failed = false;
  let updating = false;
  let reloadRequested = false;
  let refreshAvailable = false;
  let hadWorkshopController = isWorkshopWorker(workers.controller);
  let updateTimer;
  let note = '';
  let lastUpdateCheck = Date.now();
  const watched = new WeakSet();

  function waitingWorker() {
    return registration?.active && registration.waiting?.state === 'installed' ? registration.waiting : null;
  }

  function render() {
    panel.hidden = false;
    if (handout) handout.hidden = !navigator.onLine;
    install.hidden = installed || failed || (!ready && !prompt);
    update.hidden = !waitingWorker() && !refreshAvailable && !updating;
    update.disabled = updating;
    update.textContent = refreshAvailable ? '새 버전 열기' : '업데이트 적용';
    status.textContent = updating ? '새 교재를 적용하고 있습니다…'
      : note || (refreshAvailable ? '새 교재가 적용되었습니다. 준비되면 새 버전을 열어 주세요.'
        : waitingWorker() ? '새 교재가 준비되었습니다. 원할 때 업데이트를 적용하세요.'
          : failed ? '오프라인 저장을 사용할 수 없습니다. 교재는 계속 읽을 수 있습니다.'
            : ready ? navigator.onLine
              ? '전체 교재를 오프라인으로 읽을 수 있습니다.'
              : '오프라인, 저장된 교재를 읽고 있습니다.'
              : '오프라인으로 읽을 교재를 저장하고 있습니다…');
  }

  const installHelp = '브라우저 메뉴(또는 공유 메뉴)에서 “앱 설치”, “홈 화면에 추가”를 선택하세요.';
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event;
    render();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    prompt = null;
    note = '워크숍 앱을 설치했습니다.';
    render();
  });
  standalone.addEventListener('change', (event) => {
    installed = event.matches || navigator.standalone === true;
    render();
  });
  install.addEventListener('click', async () => {
    if (!prompt) {
      note = installHelp;
      render();
      return;
    }
    const pending = prompt;
    prompt = null;
    install.disabled = true;
    try {
      const result = await pending.prompt();
      const choice = result || await pending.userChoice;
      if (choice?.outcome === 'accepted') installed = true;
      note = choice?.outcome === 'accepted' ? '워크숍 앱 설치를 요청했습니다.' : installHelp;
    } catch (_) {
      note = installHelp;
    } finally {
      install.disabled = false;
      render();
    }
  });

  function watch(worker) {
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    worker.addEventListener('statechange', () => {
      ready = Boolean(registration.active?.state === 'activated');
      if (worker.state === 'redundant' && !registration.active) failed = true;
      note = '';
      render();
    });
  }

  workers.addEventListener('controllerchange', () => {
    if (!isWorkshopWorker(workers.controller)) return;
    ready = true;
    if (reloadRequested) {
      reloadRequested = false;
      clearTimeout(updateTimer);
      // Only this tab's explicit update click permits a reload.
      window.location.reload();
      return;
    }
    if (hadWorkshopController) refreshAvailable = true;
    hadWorkshopController = true;
    note = '';
    render();
  });
  update.addEventListener('click', () => {
    if (refreshAvailable) {
      window.location.reload();
      return;
    }
    const waiting = waitingWorker();
    if (!waiting || updating) return;
    updating = true;
    reloadRequested = true;
    note = '';
    render();
    const retry = () => {
      updating = false;
      reloadRequested = false;
      note = '업데이트를 완료하지 못했습니다. 준비되면 다시 적용해 주세요.';
      render();
    };
    updateTimer = setTimeout(retry, 15000);
    try {
      waiting.postMessage({ type: 'WORKSHOP_SKIP_WAITING' });
    } catch (_) {
      clearTimeout(updateTimer);
      retry();
    }
  });

  function checkForUpdate() {
    if (!registration || !navigator.onLine || waitingWorker()
      || Date.now() - lastUpdateCheck < 60000) return;
    lastUpdateCheck = Date.now();
    registration.update().catch(() => { /* Reading still works while offline or during a deployment. */ });
  }
  window.addEventListener('online', () => { note = ''; render(); checkForUpdate(); });
  window.addEventListener('offline', () => { note = ''; render(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });

  async function register() {
    render();
    try {
      // Resolve from the manifest, not from a chapter's directory. In particular,
      // navigator.serviceWorker.ready could refer to the parent's root worker.
      registration = await workers.register(workerURL, { scope: base.href, updateViaCache: 'none' });
      if (registration.scope !== base.href) throw new Error('Unexpected workshop worker scope');
      ready = registration.active?.state === 'activated';
      watch(registration.installing);
      watch(registration.active);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      render();
    } catch (_) {
      failed = true;
      render();
    }
  }
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', register, { once: true });
})();
