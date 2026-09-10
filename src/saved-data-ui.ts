import { html } from './api';
import { icon } from './icons';
import { mergeSavedData, previewImport, savedLimits, savedStatusMessage } from './saved-data';
import type { SavedData, SavedDataStore } from './saved-data';
import './saved-data.css';

export class SavedDataUI {
  private dialog: HTMLDialogElement;
  private store: SavedDataStore;
  private notify: (message: string) => void;
  private applied: () => void;
  private previousFocus: HTMLElement | null = null;
  private incoming: SavedData | null = null;
  private base: SavedData | null = null;
  private revision: string | null = null;
  private mode: 'home' | 'import' | 'delete' | 'discard' = 'home';
  private pending = false;

  constructor(store: SavedDataStore, notify: (message: string) => void, applied: () => void) {
    this.store = store;
    this.notify = notify;
    this.applied = applied;
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'saved-data-dialog';
    this.dialog.className = 'saved-data-dialog';
    this.dialog.setAttribute('aria-labelledby', 'saved-data-title');
    this.dialog.innerHTML = `<div class="dialog-heading"><h2 id="saved-data-title">이 기기의 여행 자료</h2><button id="saved-data-close" class="dialog-close" aria-label="여행 자료 관리 닫기">${icon('close')}</button></div><p id="saved-data-status" role="status" aria-live="polite"></p><div id="saved-data-body"></div>`;
    document.body.append(this.dialog);
    this.dialog.querySelector('#saved-data-close')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      this.incoming = null;
      this.mode = 'home';
      const target = this.previousFocus?.isConnected && this.previousFocus.getClientRects().length ? this.previousFocus : document.getElementById('trip-data');
      target?.focus({ preventScroll: true });
    });
    this.dialog.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || this.pending) return;
      if (button.id === 'saved-export') this.download();
      if (button.id === 'saved-delete') this.reviewDelete();
      if (button.id === 'saved-back') this.home();
      if (button.id === 'saved-confirm') void this.confirm();
      if (button.id === 'saved-retry') void this.retry();
      if (button.id === 'saved-backup') {
        const backup = this.store.backup();
        if (backup) this.reviewImport(backup, '이전 정상 저장본');
      }
      if (button.id === 'saved-review-draft') this.reviewImport(this.store.data, '현재 화면의 편집본');
      if (button.id === 'saved-discard') this.reviewDiscard();
    });
    this.dialog.addEventListener('change', event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.id === 'saved-import-file') void this.readFile(input);
      if (input.name === 'saved-import-mode') this.previewResult();
      if (input.id === 'saved-delete-confirm' || input.id === 'saved-discard-confirm') this.dialog.querySelector<HTMLButtonElement>('#saved-confirm')!.disabled = !input.checked;
    });
    store.subscribe(() => {
      if (this.dialog.open && this.mode === 'home' && !this.pending) this.home();
    });
  }

  get hasPendingReview(): boolean { return this.pending || (this.dialog.open && this.mode !== 'home'); }
  private status(message: string): void { this.dialog.querySelector('#saved-data-status')!.textContent = message; }
  open(): void {
    if (!this.dialog.open) this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.home();
    if (!this.dialog.open) this.dialog.showModal();
  }
  private home(): void {
    this.mode = 'home';
    this.incoming = null;
    const data = this.store.data;
    const backup = this.store.backup();
    this.status(savedStatusMessage(this.store.status));
    this.dialog.querySelector('#saved-data-body')!.innerHTML = `
      <p class="saved-data-summary">코스 <strong>${data.stops.length}곳</strong> · 즐겨찾기 <strong>${data.favorites.length}곳</strong></p>
      <div class="saved-data-actions"><button id="saved-export" class="button button--primary">${icon('share')}자료 파일 내보내기</button><label class="saved-file-label" for="saved-import-file">${icon('plus')}자료 파일 가져오기<input id="saved-import-file" type="file" accept=".json,application/json" aria-label="여행 자료 JSON 파일 가져오기"></label></div>
      <p>장소 좌표·출처·체류 시간과 즐겨찾기를 JSON 파일로 보관합니다. 파일을 가져올 때 내용을 확인하고 병합 또는 교체할 수 있어요.</p>
      ${this.store.hasUnsavedChanges ? '<div class="saved-recovery-actions"><button id="saved-retry" class="button">현재 편집본 저장 재시도</button><button id="saved-review-draft" class="button">저장본과 편집본 비교·병합</button><button id="saved-discard" class="button">미저장 편집본 버리기</button></div>' : ''}
      ${backup ? '<button id="saved-backup" class="button saved-backup">이전 정상 저장본 확인</button>' : ''}
      <details class="device-privacy"><summary>자료 보관과 전송 알아보기</summary><p>코스와 즐겨찾기는 이 브라우저에 저장됩니다. 다른 기기로 자동 동기화하지 않습니다.</p><p>코스 공유 주소의 # 뒤에는 장소 이름·좌표·순서·체류 시간·출처가 담깁니다. 주소를 받은 사람은 이 내용을 볼 수 있어요. 공유 주소는 전체 자료 백업과 다릅니다.</p><p>AI 질문을 보내면 질문과 필요한 탐색 맥락이 서버를 거쳐 AWS의 기존 AI 런타임에 전달됩니다. 서버는 이용 한도를 관리합니다.</p><p>아래 삭제는 이 기기의 코스·즐겨찾기·이전 정상 저장본에만 적용됩니다. 서버에 전송된 자료나 이미 공유한 주소는 삭제하지 않으며, 이용 한도용 세션 쿠키는 유지됩니다.</p></details>
      <button id="saved-delete" class="button saved-danger">이 기기의 여행 자료 삭제</button>`;
  }
  private download(): void {
    try {
      const blob = new Blob([this.store.export()], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `jeju-atlas-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      this.status('자료 파일의 다운로드를 요청했어요. 브라우저 다운로드 목록을 확인해 주세요.');
    } catch { this.status('파일을 내보내지 못했어요. 브라우저의 다운로드 허용 상태를 확인해 주세요.'); }
  }
  private async readFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.pending = true;
    try {
      if (file.size > savedLimits.bytes) throw new Error('자료 파일은 700 KB 이하여야 합니다.');
      const preview = previewImport(await file.text());
      this.reviewImport(preview.data, file.name);
    } catch (error) { this.status(error instanceof Error ? error.message : '자료 파일을 읽지 못했어요.'); }
    finally { this.pending = false; }
  }
  reviewImport(data: SavedData, label: string): void {
    if (!this.dialog.open) this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.mode = 'import';
    this.incoming = structuredClone(data);
    try {
      const latest = this.store.latest();
      this.base = latest.data;
      this.revision = latest.revision;
    } catch {
      this.base = this.store.data;
      this.revision = this.store.revision;
    }
    this.status('아직 저장 자료를 변경하지 않았어요. 아래 내용을 확인해 주세요.');
    this.dialog.querySelector('#saved-data-body')!.innerHTML = `
      <section id="saved-import-preview" aria-labelledby="saved-preview-title"><h3 id="saved-preview-title" tabindex="-1">가져올 자료 확인</h3><p class="saved-filename">${html(label)}</p><p>코스 ${data.stops.length}곳 · 즐겨찾기 ${data.favorites.length}곳</p><ol>${data.stops.map(place => `<li>${html(place.name)} <span>${place.stay_min}분</span></li>`).join('')}</ol>${data.favorites.length ? `<p>즐겨찾기: ${data.favorites.slice(0, 6).map(place => html(place.name)).join(' · ')}${data.favorites.length > 6 ? ' 외' : ''}</p>` : ''}
      <fieldset><legend>기존 저장 자료 처리</legend><label><input type="radio" name="saved-import-mode" value="merge" checked> 병합 — 같은 장소는 기존 저장 정보를 유지</label><label><input type="radio" name="saved-import-mode" value="replace"> 교체 — 기존 코스와 즐겨찾기를 가져온 자료로 교체</label></fieldset><p id="saved-import-result" role="status"></p><div class="saved-data-actions"><button id="saved-back" class="button">취소</button><button id="saved-confirm" class="button button--primary">확인한 자료 가져오기</button></div></section>`;
    this.previewResult();
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>('#saved-preview-title')?.focus({ preventScroll: true });
  }
  private proposed(): SavedData {
    if (!this.incoming || !this.base) throw new Error('가져올 자료를 다시 선택해 주세요.');
    return this.dialog.querySelector<HTMLInputElement>('[name="saved-import-mode"]:checked')?.value === 'replace'
      ? this.incoming : mergeSavedData(this.base, this.incoming);
  }
  private previewResult(): void {
    const button = this.dialog.querySelector<HTMLButtonElement>('#saved-confirm')!;
    const result = this.dialog.querySelector('#saved-import-result')!;
    try {
      const proposed = this.proposed();
      result.textContent = `적용 후: 코스 ${proposed.stops.length}곳 · 즐겨찾기 ${proposed.favorites.length}곳`;
      button.disabled = false;
    } catch (error) {
      result.textContent = error instanceof Error ? error.message : '가져오기 한도를 확인해 주세요.';
      button.disabled = true;
    }
  }
  private reviewDelete(): void {
    this.mode = 'delete';
    this.revision = this.store.revision;
    const data = this.store.data;
    this.status('삭제할 범위를 확인해 주세요.');
    this.dialog.querySelector('#saved-data-body')!.innerHTML = `<section aria-labelledby="saved-delete-title"><h3 id="saved-delete-title" tabindex="-1">이 기기의 자료를 삭제할까요?</h3><p>코스 ${data.stops.length}곳, 즐겨찾기 ${data.favorites.length}곳과 이전 정상 저장본을 이 브라우저에서 삭제합니다.</p><p>서버에 전송된 자료와 이미 공유한 주소는 삭제되지 않습니다. AI 이용 한도용 세션 쿠키도 유지됩니다.</p><p>필요한 자료는 먼저 파일로 내보내 주세요. 삭제 후 이 화면에서 되돌릴 수 없습니다.</p><label class="saved-delete-label"><input id="saved-delete-confirm" type="checkbox"> 이 기기의 여행 자료 삭제를 확인했습니다.</label><div class="saved-data-actions"><button id="saved-back" class="button">취소</button><button id="saved-confirm" class="button saved-danger" disabled>확인한 기기 자료 삭제</button></div></section>`;
    this.dialog.querySelector<HTMLElement>('#saved-delete-title')?.focus();
  }
  private reviewDiscard(): void {
    this.mode = 'discard';
    this.status('파일로 보관했거나 필요 없는 편집본인지 확인해 주세요.');
    this.dialog.querySelector('#saved-data-body')!.innerHTML = `<section><h3 tabindex="-1">미저장 편집본을 버릴까요?</h3><p>현재 화면의 미저장 편집본을 비우고, 읽을 수 있는 기존 저장본을 다시 엽니다. 브라우저 저장 자료와 서버 자료는 삭제하지 않습니다.</p><label class="saved-delete-label"><input id="saved-discard-confirm" type="checkbox"> 필요한 편집본을 파일로 보관했거나 버려도 괜찮습니다.</label><div class="saved-data-actions"><button id="saved-back" class="button">취소</button><button id="saved-confirm" class="button saved-danger" disabled>확인한 편집본 버리기</button></div></section>`;
    this.dialog.querySelector<HTMLElement>('h3')?.focus();
  }
  private async confirm(): Promise<void> {
    const mode = this.mode;
    if (mode === 'home') return;
    if (mode === 'delete' && !this.dialog.querySelector<HTMLInputElement>('#saved-delete-confirm')?.checked) return;
    if (mode === 'discard' && !this.dialog.querySelector<HTMLInputElement>('#saved-discard-confirm')?.checked) return;
    this.pending = true;
    this.dialog.querySelector<HTMLButtonElement>('#saved-confirm')!.disabled = true;
    try {
      const result = mode === 'discard' ? (this.store.discardDraft(), { ok: true as const })
        : mode === 'delete' ? await this.store.clear(this.revision) : await this.store.replace(this.proposed(), this.revision);
      if (result.ok) {
        this.applied();
        this.home();
        const message = mode === 'discard' ? '미저장 편집본을 비웠어요. 기존 저장 자료는 변경하지 않았습니다.'
          : mode === 'delete' ? '이 기기의 여행 자료를 삭제했어요. 서버 자료와 세션 쿠키는 유지됩니다.' : '확인한 여행 자료를 이 브라우저에 저장했어요.';
        this.status(message);
        this.notify(message);
        this.dialog.querySelector<HTMLButtonElement>('#saved-export')?.focus();
      } else {
        this.status(`${mode === 'delete' ? '기기 자료 삭제를 완료하지 못했어요. ' : ''}${savedStatusMessage(result.reason)}`);
        this.dialog.querySelector<HTMLButtonElement>('#saved-back')?.focus();
      }
    } catch { this.status('자료를 적용하지 못했어요. 취소한 뒤 내용을 다시 확인해 주세요.'); }
    finally { this.pending = false; }
  }
  private async retry(): Promise<void> {
    this.pending = true;
    const result = await this.store.retry();
    this.pending = false;
    this.home();
    this.status(savedStatusMessage(result.ok ? 'saved' : result.reason));
  }
}
