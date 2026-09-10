import { en } from './locales/en.ts';

export type Locale = 'ko' | 'en';
type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const localeKey = 'jeju-atlas.locale.v1';
export const dictionaries: Record<Locale, Record<string, string>> = {
  ko: Object.fromEntries(Object.keys(en).map(key => [key, key])), en,
};
const reverse = new Map(Object.entries(en).map(([ko, english]) => [english, ko]));
function browserStorage(): LocaleStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
export function readLocale(storage: Pick<Storage, 'getItem'> | null = browserStorage()): Locale {
  try { return storage?.getItem(localeKey) === 'en' ? 'en' : 'ko'; } catch { return 'ko'; }
}
let current = readLocale();
export function getLocale(): Locale { return current; }
export function setLocale(locale: Locale, storage: Pick<Storage, 'setItem'> | null = browserStorage()): boolean {
  if (locale !== 'ko' && locale !== 'en') throw new Error('Unsupported locale');
  current = locale;
  let persisted = false;
  try { if (storage) { storage.setItem(localeKey, locale); persisted = true; } } catch { /* Session-only language still works. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('atlas:locale-change', { detail: { locale, persisted } }));
  return persisted;
}
export function placeName(place: { name: string; name_en?: string | null; english?: string }): string {
  const english = place.name_en || place.english;
  return current === 'en' && typeof english === 'string' && english.trim() ? english : place.name;
}
type Pattern = { ko: RegExp; en: RegExp; english: (m: RegExpMatchArray) => string; korean: (m: RegExpMatchArray) => string };
const patterns: Pattern[] = [
  { ko: /^([\d,]+)곳$/, en: /^([\d,]+) places$/, english: m => `${m[1]} places`, korean: m => `${m[1]}곳` },
  { ko: /^([\d,]+)개의 장소$/, en: /^([\d,]+) landmarks$/, english: m => `${m[1]} landmarks`, korean: m => `${m[1]}개의 장소` },
  { ko: /^약 ([\d.]+) (m|km)$/, en: /^Approx\. ([\d.]+) (m|km)$/, english: m => `Approx. ${m[1]} ${m[2]}`, korean: m => `약 ${m[1]} ${m[2]}` },
  { ko: /^고도 배율 ([\d.]+×)$/, en: /^Elevation scale ([\d.]+×)$/, english: m => `Elevation scale ${m[1]}`, korean: m => `고도 배율 ${m[1]}` },
  { ko: /^실제 고도의 ([\d.]+)배$/, en: /^([\d.]+) times actual elevation$/, english: m => `${m[1]} times actual elevation`, korean: m => `실제 고도의 ${m[1]}배` },
  { ko: /^(.+) 자세히 보기$/, en: /^View details: (.+)$/, english: m => `View details: ${m[1]}`, korean: m => `${m[1]} 자세히 보기` },
  { ko: /^(.+) 체류 시간$/, en: /^Planned stay: (.+)$/, english: m => `Planned stay: ${m[1]}`, korean: m => `${m[1]} 체류 시간` },
  { ko: /^(.+) 위로$/, en: /^Move (.+) up$/, english: m => `Move ${m[1]} up`, korean: m => `${m[1]} 위로` },
  { ko: /^(.+) 아래로$/, en: /^Move (.+) down$/, english: m => `Move ${m[1]} down`, korean: m => `${m[1]} 아래로` },
  { ko: /^(.+) 코스에서 제거$/, en: /^Remove (.+) from trip$/, english: m => `Remove ${m[1]} from trip`, korean: m => `${m[1]} 코스에서 제거` },
  { ko: /^(.+) 코스에 추가$/, en: /^Add (.+) to trip$/, english: m => `Add ${m[1]} to trip`, korean: m => `${m[1]} 코스에 추가` },
  { ko: /^(.+) 즐겨찾기 해제$/, en: /^Remove (.+) from favorites$/, english: m => `Remove ${m[1]} from favorites`, korean: m => `${m[1]} 즐겨찾기 해제` },
  { ko: /^(.+) 내 여행에 담기$/, en: /^Add (.+) to my trip$/, english: m => `Add ${m[1]} to my trip`, korean: m => `${m[1]} 내 여행에 담기` },
  { ko: /^(.+), 내 여행에 저장했어요\.$/, en: /^Saved (.+) to your trip\.$/, english: m => `Saved ${m[1]} to your trip.`, korean: m => `${m[1]}, 내 여행에 저장했어요.` },
  { ko: /^공유 코스 (\d+)곳을 저장했어요\.$/, en: /^Saved (\d+) stops from the shared trip\.$/, english: m => `Saved ${m[1]} stops from the shared trip.`, korean: m => `공유 코스 ${m[1]}곳을 저장했어요.` },
  { ko: /^코스 (\d+)곳 · 즐겨찾기 (\d+)곳$/, en: /^Trip: (\d+) stops · Favorites: (\d+) places$/, english: m => `Trip: ${m[1]} stops · Favorites: ${m[2]} places`, korean: m => `코스 ${m[1]}곳 · 즐겨찾기 ${m[2]}곳` },
  { ko: /^적용 후: 코스 (\d+)곳 · 즐겨찾기 (\d+)곳$/, en: /^After import: (\d+) stops · (\d+) favorites$/, english: m => `After import: ${m[1]} stops · ${m[2]} favorites`, korean: m => `적용 후: 코스 ${m[1]}곳 · 즐겨찾기 ${m[2]}곳` },
  { ko: /^계획 체류 (\d+)분 · 이동시간 별도$/, en: /^Stay: (\d+) min · Travel time excluded$/, english: m => `Stay: ${m[1]} min · Travel time excluded`, korean: m => `계획 체류 ${m[1]}분 · 이동시간 별도` },
  { ko: /^직선 합계 (.+)$/, en: /^Straight-line total: (.+)$/, english: m => `Straight-line total: ${translate(m[1], 'en')}`, korean: m => `직선 합계 ${translate(m[1], 'ko')}` },
  { ko: /^내 여행 (\d+)곳 · 직선 연결 (.+)$/, en: /^My trip: (\d+) stops · Straight line: (.+)$/, english: m => `My trip: ${m[1]} stops · Straight line: ${translate(m[2], 'en')}`, korean: m => `내 여행 ${m[1]}곳 · 직선 연결 ${translate(m[2], 'ko')}` },
  { ko: /^하루 최대 (\d+)회 · AI 답변은 출처를 함께 확인하세요\.$/, en: /^Up to (\d+) requests per day · Check the sources of AI answers\.$/, english: m => `Up to ${m[1]} requests per day · Check the sources of AI answers.`, korean: m => `하루 최대 ${m[1]}회 · AI 답변은 출처를 함께 확인하세요.` },
  { ko: /^오늘의 이용 한도에 도달했어요\. 하루 최대 (\d+)회까지 이용할 수 있어요\.$/, en: /^Daily limit reached\. You can use up to (\d+) requests a day\.$/, english: m => `Daily limit reached. You can use up to ${m[1]} requests a day.`, korean: m => `오늘의 이용 한도에 도달했어요. 하루 최대 ${m[1]}회까지 이용할 수 있어요.` },
  { ko: /^자료는 최대 (\d+)곳까지 가져올 수 있습니다\.$/, en: /^You can import up to (\d+) places\.$/, english: m => `You can import up to ${m[1]} places.`, korean: m => `자료는 최대 ${m[1]}곳까지 가져올 수 있습니다.` },
  { ko: /^관측 (.+) · 이용허락 (.+)$/, en: /^Observed: (.+) · License: (.+)$/, english: m => `Observed: ${translate(m[1], 'en')} · License: ${translate(m[2], 'en')}`, korean: m => `관측 ${translate(m[1], 'ko')} · 이용허락 ${translate(m[2], 'ko')}` },
  { ko: /^인허가 상태: (.+)$/, en: /^Licensing status: (.+)$/, english: m => `Licensing status: ${translate(m[1], 'en')}`, korean: m => `인허가 상태: ${translate(m[1], 'ko')}` },
  { ko: /^(.+) 더 보기$/, en: /^More (.+)$/, english: m => `More ${translate(m[1], 'en')}`, korean: m => `${translate(m[1], 'ko')} 더 보기` },
  { ko: /^(\d+)분$/, en: /^(\d+) min$/, english: m => `${m[1]} min`, korean: m => `${m[1]}분` },
  { ko: /^\/ (\d+)곳$/, en: /^\/ (\d+) places$/, english: m => `/ ${m[1]} places`, korean: m => `/ ${m[1]}곳` },
  { ko: /^지도에 펼칠 추천 (\d+)곳$/, en: /^(\d+) recommendations for the map$/, english: m => `${m[1]} recommendations for the map`, korean: m => `지도에 펼칠 추천 ${m[1]}곳` },
  { ko: /^편의 (\d+)항목 기록$/, en: /^(\d+) facilities recorded$/, english: m => `${m[1]} facilities recorded`, korean: m => `편의 ${m[1]}항목 기록` },
  { ko: /^요일별 영업시간 (\d+)건 등록$/, en: /^(\d+) weekday hours records$/, english: m => `${m[1]} weekday hours records`, korean: m => `요일별 영업시간 ${m[1]}건 등록` },
  { ko: /^이용시간 문구에서 추출: (.+) · 휴무일 미확인$/, en: /^Parsed from visiting-hours text: (.+) · Closed days unconfirmed$/, english: m => `Parsed from visiting-hours text: ${m[1]} · Closed days unconfirmed`, korean: m => `이용시간 문구에서 추출: ${m[1]} · 휴무일 미확인` },
  { ko: /^([\d,]+)곳의 제주( · 최근 저장본)?$/, en: /^([\d,]+) places in Jeju( · Last saved snapshot)?$/, english: m => `${m[1]} places in Jeju${m[2] ? ' · Last saved snapshot' : ''}`, korean: m => `${m[1]}곳의 제주${m[2] ? ' · 최근 저장본' : ''}` },
  { ko: /^(.+) 가까이 보기$/, en: /^Fly closer to (.+)$/, english: m => `Fly closer to ${m[1]}`, korean: m => `${m[1]} 가까이 보기` },
  { ko: /^(.+) 직선$/, en: /^(.+) straight line$/, english: m => `${translate(m[1], 'en')} straight line`, korean: m => `${translate(m[1], 'ko')} 직선` },
  { ko: /^([\d,]+)원$/, en: /^KRW ([\d,]+)$/, english: m => `KRW ${m[1]}`, korean: m => `${m[1]}원` },
  { ko: /^(.+) · (.+) 제공 사진$/, en: /^(.+) · Photo from (.+)$/, english: m => `${m[1]} · Photo from ${translate(m[2], 'en')}`, korean: m => `${m[1]} · ${translate(m[2], 'ko')} 제공 사진` },
  { ko: /^코스 (\d+)곳, 즐겨찾기 (\d+)곳과 이전 정상 저장본을 이 브라우저에서 삭제합니다\.$/, en: /^Delete (\d+) trip stops, (\d+) favorites and the last good backup from this browser\.$/, english: m => `Delete ${m[1]} trip stops, ${m[2]} favorites and the last good backup from this browser.`, korean: m => `코스 ${m[1]}곳, 즐겨찾기 ${m[2]}곳과 이전 정상 저장본을 이 브라우저에서 삭제합니다.` },
];
const prefixes: [string, string][] = [
  ['기본: ', 'Base: '], ['출처: ', 'Source: '], ['출처 ', 'Source: '],
  ['기본 시간 안내: ', 'Original hours text: '], ['기본 시간 출처: ', 'Base hours source: '],
  ['소개 관련 보강 출처: ', 'Description enrichment sources: '], ['보강 자료 출처: ', 'Enrichment sources: '],
  ['보강 갱신 ', 'Enrichment updated: '], ['보강일: ', 'Enriched: '],
  ['관측 기준 ', 'Observed: '], ['조회 ', 'Retrieved: '], ['강수 확률 ', 'Precipitation chance: '],
  ['즐겨찾기: ', 'Favorites: '],
];
function translate(value: string, locale: Locale): string {
  const text = value.trim().replace(/\s+/g, ' ');
  const direct = locale === 'en' ? Object.hasOwn(en, text) ? en[text] : undefined : reverse.get(text);
  if (direct) return direct;
  for (const pattern of patterns) {
    const match = text.match(locale === 'en' ? pattern.ko : pattern.en);
    if (match) return locale === 'en' ? pattern.english(match) : pattern.korean(match);
  }
  for (const [ko, english] of prefixes) {
    const from = locale === 'en' ? ko : english;
    if (text.startsWith(from)) return (locale === 'en' ? english : ko) + translate(text.slice(from.length), locale);
  }
  if (text.includes(' · ')) return text.split(' · ').map(part => translate(part, locale)).join(' · ');
  return value;
}
export function t(value: string, locale: Locale = current): string { return translate(value, locale); }

const originals = new WeakMap<Text, { original: string; rendered: string }>();
const attributes = new WeakMap<Element, Map<string, { original: string; rendered: string }>>();
const ignored = '[data-i18n-ignore],.guide-markdown,.chat-message--user>p,.detail-overview,.detail-hours-raw,script,style,pre,code';
const localizedAttributes = ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'placeholder', 'alt'];
function translateTextNode(node: Text): void {
  if (!node.parentElement || node.parentElement.closest(ignored)) return;
  const cached = originals.get(node);
  const original = cached?.rendered === node.data ? cached.original : node.data;
  if (!original.trim()) return;
  const leading = original.match(/^\s*/)?.[0] ?? '';
  const trailing = original.match(/\s*$/)?.[0] ?? '';
  const rendered = `${leading}${t(original.trim())}${trailing}`;
  originals.set(node, { original, rendered });
  if (node.data !== rendered) node.data = rendered;
}
function translateElement(element: Element): void {
  if (element.closest(ignored)) return;
  const values = attributes.get(element) ?? new Map();
  for (const attribute of localizedAttributes) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const cached = values.get(attribute);
    const original = cached?.rendered === value ? cached.original : value;
    const rendered = t(original);
    values.set(attribute, { original, rendered });
    if (value !== rendered) element.setAttribute(attribute, rendered);
  }
  attributes.set(element, values);
}
function translateTree(root: Node): void {
  if (root instanceof Text) { translateTextNode(root); return; }
  if (!(root instanceof Element)) return;
  translateElement(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text) translateTextNode(node);
    else if (node instanceof Element) translateElement(node);
  }
}
export function initializeI18n(button: HTMLButtonElement, notify: (message: string) => void): void {
  document.documentElement.lang = current;
  button.setAttribute('data-i18n-ignore', '');
  const paint = () => {
    button.textContent = current === 'ko' ? 'English' : '한국어';
    button.lang = current === 'ko' ? 'en' : 'ko';
    button.setAttribute('aria-label', current === 'ko' ? 'Switch language to English' : '한국어로 전환');
    button.title = current === 'ko' ? 'English' : '한국어';
    document.title = current === 'ko' ? '제주 아틀라스 — 제주를, 입체적으로.' : 'Jeju Atlas — Explore Jeju in 3D';
    translateTree(document.body);
  };
  button.addEventListener('click', () => {
    const persisted = setLocale(current === 'ko' ? 'en' : 'ko');
    if (!persisted) notify(t('언어 선택을 저장하지 못했어요. 현재 화면에는 적용했습니다.'));
  });
  window.addEventListener('atlas:locale-change', paint);
  window.addEventListener('storage', event => {
    if (event.key !== localeKey || !['ko', 'en'].includes(event.newValue ?? '')) return;
    current = event.newValue as Locale;
    document.documentElement.lang = current;
    window.dispatchEvent(new CustomEvent('atlas:locale-change', { detail: { locale: current, persisted: true } }));
  });
  const observer = new MutationObserver(records => {
    const roots = new Set<Node>();
    for (const record of records) {
      if (record.type === 'characterData') roots.add(record.target);
      else if (record.type === 'attributes' && record.target instanceof Element) translateElement(record.target);
      else record.addedNodes.forEach(node => roots.add(node));
    }
    roots.forEach(translateTree);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: localizedAttributes });
  paint();
}
