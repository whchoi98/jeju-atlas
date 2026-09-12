import { getConfig } from './api';
import { icon } from './icons';
import { initializePresence } from './presence';
import { hasSessionCoordination } from './session-config';
import './presence.css';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function initializePWA(root: HTMLElement, notify: (message: string) => void, options: { isBusy?: () => boolean } = {}): void {
  root.innerHTML = `<div id="connection-status" role="status">코스와 즐겨찾기는 이 브라우저에 저장해요.</div><span id="visitor-presence" hidden data-i18n-ignore></span><button id="pwa-install" hidden>${icon('plus')}앱으로 설치</button><button id="pwa-retry" hidden>앱 저장 재시도</button><span id="pwa-status" class="sr-only"></span>`;
  initializePresence(root.querySelector<HTMLElement>('#visitor-presence')!, {
    getConfig: async (refresh = false) => {
      const presence = (await getConfig(refresh)).presence;
      // Keep other app features usable on legacy/private transports, but do
      // not register a count when cold-window session coordination is missing.
      if (presence?.enabled && !hasSessionCoordination()) throw new Error('presence_coordination_unavailable');
      return presence;
    },
  });
  const banner = document.createElement('section');
  banner.id = 'pwa-update';
  banner.className = 'pwa-update';
  banner.hidden = true;
  banner.setAttribute('aria-label', '앱 업데이트');
  banner.innerHTML = '<p id="pwa-update-status" role="status">새 버전이 준비됐어요. 저장된 코스는 유지됩니다.</p><button id="pwa-update-apply" class="button button--primary">새 버전 적용</button>';
  document.body.append(banner);
  const updateStatus = (message: string) => { banner.querySelector('#pwa-update-status')!.textContent = message; };
  let workers: ServiceWorkerContainer | undefined;
  try { if (window.isSecureContext && 'serviceWorker' in navigator) workers = navigator.serviceWorker; }
  catch { /* Some embedded/private browsers deny storage-backed APIs. */ }
  let registration: ServiceWorkerRegistration | undefined;
  let registering = false;
  let pendingReload = false;
  let hadController = Boolean(workers?.controller);
  let reloading = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let lockedReview: string | undefined;
  const busy = () => Boolean(options.isBusy?.());
  const release = () => {
    clearTimeout(releaseTimer);
    lockedReview = undefined;
    delete document.documentElement.dataset.shellUpdating;
  };
  const reload = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };
  const offer = () => {
    if (!registration?.waiting || !workers?.controller) return;
    banner.hidden = false;
    updateStatus('새 버전이 준비됐어요. 적용 전에 모든 탭의 작성·저장 상태를 확인합니다.');
  };
  banner.querySelector('#pwa-update-apply')!.addEventListener('click', () => {
    if (busy()) {
      updateStatus('작성 중인 질문을 보내거나 비우고, 편집 중인 자료를 저장·내보낸 뒤 적용해 주세요.');
      return;
    }
    if (pendingReload) { reload(); return; }
    if (!registration?.waiting) { void register(true); return; }
    updateStatus('다른 탭의 질문과 편집 상태를 확인하고 있어요.');
    registration.waiting.postMessage({ type: 'ATLAS_APPLY_UPDATE' });
  });
  const offline = document.createElement('div');
  offline.id = 'offline-notice';
  offline.className = 'offline-notice';
  offline.setAttribute('role', 'status');
  offline.textContent = '오프라인 · 저장한 코스를 볼 수 있어요. 지도·사진·날씨·AI는 연결이 필요해요.';
  document.querySelector('.map-shell')!.append(offline);
  const update = () => {
    offline.hidden = navigator.onLine;
    const status = root.querySelector<HTMLElement>('#connection-status')!;
    status.textContent = navigator.onLine
      ? '코스와 즐겨찾기는 이 브라우저에 저장해요.'
      : '오프라인 · 저장한 코스와 장소를 확인하세요.';
    status.title = status.textContent;
  };
  window.addEventListener('online', () => { update(); void register(true); });
  window.addEventListener('offline', update);
  update();
  let prompt: InstallPrompt | undefined;
  const install = root.querySelector<HTMLButtonElement>('#pwa-install')!;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event as InstallPrompt;
    install.hidden = false;
  });
  install.addEventListener('click', async () => {
    if (!prompt) return;
    const current = prompt;
    prompt = undefined;
    install.hidden = true;
    try {
      await current.prompt();
      if ((await current.userChoice).outcome === 'accepted') notify('제주 아틀라스를 앱으로 설치했어요.');
    } catch { notify('브라우저 메뉴에서 홈 화면에 추가할 수 있어요.'); }
  });
  window.addEventListener('appinstalled', () => { install.hidden = true; prompt = undefined; });
  async function register(refresh = false): Promise<void> {
    if (!workers || registering || !navigator.onLine) return;
    registering = true;
    const retry = root.querySelector<HTMLButtonElement>('#pwa-retry')!;
    retry.disabled = true;
    try {
      const config = await getConfig(refresh);
      if (!config.features.pwa) return;
      if (!registration) {
        registration = await workers.register('/sw.js', { scope: '/', updateViaCache: 'none' });
        const watch = () => {
          const installing = registration?.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') offer();
          });
        };
        registration.addEventListener('updatefound', watch);
        watch();
      } else if (refresh) await registration.update();
      root.querySelector('#pwa-status')!.textContent = '앱 셸 저장 기능을 사용할 수 있습니다.';
      retry.hidden = true;
      offer();
    } catch {
      root.querySelector('#pwa-status')!.textContent = '앱 셸 저장 기능을 현재 사용할 수 없습니다.';
      retry.hidden = false;
    } finally { registering = false; retry.disabled = false; }
  }
  root.querySelector('#pwa-retry')!.addEventListener('click', () => { void register(true); });
  if (workers) {
    workers.addEventListener('message', event => {
      const data = event.data;
      if (data?.type === 'ATLAS_UPDATE_CHECK' && typeof data.id === 'string' && data.id.length < 100) {
        const isBusy = busy();
        if (!isBusy) {
          lockedReview = data.id;
          document.documentElement.dataset.shellUpdating = 'true';
          clearTimeout(releaseTimer);
          releaseTimer = setTimeout(release, 12000);
        }
        event.source?.postMessage({ type: 'ATLAS_UPDATE_STATE', id: data.id, busy: isBusy });
      } else if (data?.type === 'ATLAS_UPDATE_RELEASE' && data.id === lockedReview) release();
      else if (data?.type === 'ATLAS_UPDATE_COMMIT' && data.id === lockedReview) {
        updateStatus('새 버전을 적용하고 있어요.');
      } else if (data?.type === 'ATLAS_UPDATE_BLOCKED') {
        release();
        banner.hidden = false;
        updateStatus('다른 탭에 작성 중인 자료가 있거나 상태를 확인하지 못했어요. 해당 탭에서 작업을 마치거나 탭을 닫고 다시 적용해 주세요.');
      }
    });
    workers.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; offer(); return; }
      if (busy()) {
        release();
        pendingReload = true;
        banner.hidden = false;
        updateStatus('새 버전이 연결됐어요. 작성 중인 자료를 보관한 뒤 적용해 주세요.');
      } else reload();
    });
    void register();
  }
}
