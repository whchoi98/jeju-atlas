import { getConfig } from './api';
import { icon } from './icons';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function initializePWA(root: HTMLElement, notify: (message: string) => void): void {
  root.innerHTML = `<div id="connection-status" role="status">코스와 즐겨찾기는 이 브라우저에 저장해요.</div><button id="pwa-install" hidden>${icon('plus')}앱으로 설치</button><span id="pwa-status" class="sr-only"></span>`;
  const offline = document.createElement('div');
  offline.id = 'offline-notice';
  offline.className = 'offline-notice';
  offline.setAttribute('role', 'status');
  offline.textContent = '오프라인 · 저장한 코스를 볼 수 있어요. 지도·사진·날씨·AI는 연결이 필요해요.';
  document.querySelector('.map-shell')!.append(offline);
  const update = () => {
    offline.hidden = navigator.onLine;
    root.querySelector('#connection-status')!.textContent = navigator.onLine
      ? '코스와 즐겨찾기는 이 브라우저에 저장해요.'
      : '오프라인 · 저장한 코스와 장소를 확인하세요.';
  };
  window.addEventListener('online', update);
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
  if ('serviceWorker' in navigator && window.isSecureContext) {
    void getConfig().then(async (config) => {
      if (!config.features.pwa) return;
      // The parent build creates sw.js. It caches the application shell only;
      // this frontend never requests bulk/offline map tile or API caching.
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      root.querySelector('#pwa-status')!.textContent = '앱 셸 저장 기능을 사용할 수 있습니다.';
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', () => {
          if (registration.waiting && navigator.serviceWorker.controller) notify('새 버전이 준비됐어요. 다음에 앱을 열면 적용됩니다.');
        });
      });
    }).catch(() => {
      root.querySelector('#pwa-status')!.textContent = '앱 셸 저장 기능을 현재 사용할 수 없습니다.';
    });
  }
}
