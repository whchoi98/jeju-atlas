import type { CatalogPlace } from '../shared/api-types';
import { categoryName, html } from './api.ts';
import { categorySymbol, icon } from './icons.ts';
import { t } from './i18n.ts';
import './place-visual.css';

/** Category artwork only; the caller owns photo validation and retry controls. */
export function placeVisualHTML(
  place: Pick<CatalogPlace, 'category'>,
  { failed = false }: { failed?: boolean } = {},
): string {
  const category = place.category.trim() || 'other';
  const message = failed ? '사진을 불러오지 못했어요.' : '제공된 실제 사진 없음';
  return `<div class="place-visual${failed ? ' place-visual--failed' : ''}">
    <div class="place-visual-art" aria-hidden="true">${icon(categorySymbol(category).icon)}</div>
    <div class="place-visual-copy">
      <p class="place-visual-category">${html(categoryName(category))}</p>
      <strong class="place-visual-title">${html(t(message))}</strong>
      <p class="place-visual-note">${html(t('장소 분류 일러스트'))}</p>
    </div>
  </div>`;
}
