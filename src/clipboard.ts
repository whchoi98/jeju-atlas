import { getLocale } from './i18n.ts';

/** Copy plain text without changing the current URL or saved itinerary. */
export async function copyPlainText(value: string, message: string, notify: (message: string) => void): Promise<void> {
  if (!value || value.length > 8000) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(value);
    notify(message);
  } catch {
    let dialog = document.querySelector<HTMLDialogElement>('#copy-text-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'copy-text-dialog';
      dialog.className = 'copy-text-dialog';
      dialog.innerHTML = '<form method="dialog"><h2 id="copy-text-heading"></h2><p></p><textarea readonly rows="3"></textarea><button type="submit"></button></form>';
      dialog.setAttribute('aria-labelledby', 'copy-text-heading');
      dialog.dataset.i18nIgnore = '';
      document.body.append(dialog);
    }
    const en = getLocale() === 'en';
    dialog.querySelector('h2')!.textContent = en ? 'Copy this text' : '내용 복사';
    dialog.querySelector('p')!.textContent = en ? 'Select the text and copy it using your browser.' : '선택된 내용을 브라우저에서 직접 복사해 주세요.';
    dialog.querySelector('button')!.textContent = en ? 'Close' : '닫기';
    const input = dialog.querySelector('textarea')!;
    input.value = value;
    input.setAttribute('aria-label', en ? 'Text to copy' : '복사할 내용');
    if (!dialog.open) dialog.showModal();
    input.focus(); input.select();
  }
}
