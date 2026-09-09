const paths = {
  mountain: '<path d="m3 19 6-10 4 6 3-10 6 14H3Z"/><path d="m7 12 2 2 2-1m3-4 2 2 2-2"/>',
  coast: '<path d="M3 10c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2M3 16c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2"/><path d="m5 6 3-3 3 3"/>',
  island: '<path d="M2 18c2 0 2 2 5 2s2-2 5-2 2 2 5 2 3-2 5-2"/><path d="m4 16 6-7 4 4 3-3 4 6M13 8V3m-3 2 3-2 4 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  compass: '<path d="m12 3 6 17-6-4-6 4 6-17Z"/><path d="M12 3v13"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7"/>',
  share: '<path d="M12 15V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Z"/><path d="m3 14 9 5 9-5M3 19l9 5 9-5" transform="translate(0 -2)"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  mouse: '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 2v6"/>',
  route: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  cafe: '<path d="M4 9h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Zm12 1h2a3 3 0 0 1 0 6h-2M3 22h15M7 3v3m4-4v4m4-3v3"/>',
  food: '<path d="M5 3v6a3 3 0 0 0 6 0V3M8 3v19M18 3c-3 4-3 8 0 9h2V3h-2Zm2 9v10"/>',
  museum: '<path d="m3 8 9-5 9 5H3Zm2 3v8m5-8v8m4-8v8m5-8v8M3 21h18M3 11h18"/>',
  market: '<path d="M4 4h16l2 6H2l2-6Zm-1 6v3a3 3 0 0 0 5 2 3 3 0 0 0 4 0 3 3 0 0 0 4 0 3 3 0 0 0 5-2v-3M4 16v6h16v-6M9 22v-5h6v5"/>',
  parking: '<path d="M8 20V5h5a4 4 0 0 1 0 8H8"/><rect x="2" y="2" width="20" height="20" rx="4"/>',
  trail: '<path d="M4 22c9-3 9-7 4-9s-2-6 7-7M16 2v9m0-9 6 3-6 3"/>',
  lodging: '<path d="M3 20V7m18 13V7M3 16h18M3 10h18v6M6 6h5v4H6V6Zm7 0h5v4h-5V6Z"/>',
} as const;

export type IconName = keyof typeof paths;

/** Shared pictograms for the actual catalog taxonomy and legacy terrain pins. */
export function categorySymbol(category: string): { icon: IconName; color: string } {
  if (['해변', 'beach', 'coast'].includes(category)) return { icon: 'coast', color: '#187c87' };
  if (['오름', 'mountain', 'nature', 'park'].includes(category)) return { icon: 'mountain', color: '#5f805a' };
  if (['카페', 'cafe'].includes(category)) return { icon: 'cafe', color: '#86644a' };
  if (['맛집', 'food', 'restaurant'].includes(category)) return { icon: 'food', color: '#b16845' };
  if (['박물관', 'museum', 'culture'].includes(category)) return { icon: 'museum', color: '#64759a' };
  if (['시장', 'market', 'shopping'].includes(category)) return { icon: 'market', color: '#927b43' };
  if (['주차장', 'parking'].includes(category)) return { icon: 'parking', color: '#5c7582' };
  if (['올레길', 'trail'].includes(category)) return { icon: 'trail', color: '#5b8d72' };
  if (['숙소', 'stay', 'hotel', 'lodging', 'accommodation'].includes(category)) return { icon: 'lodging', color: '#787096' };
  if (['섬', 'island'].includes(category)) return { icon: 'island', color: '#748757' };
  return { icon: 'pin', color: '#187c87' };
}

/** Draw trusted local icon artwork synchronously for MapLibre sprite images. */
export function paintIcon(context: CanvasRenderingContext2D, name: IconName): void {
  const document = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${paths[name]}</svg>`, 'image/svg+xml');
  for (const element of document.documentElement.children) {
    const number = (attribute: string) => Number(element.getAttribute(attribute) ?? 0);
    context.beginPath();
    if (element.tagName === 'path') {
      context.stroke(new Path2D(element.getAttribute('d') ?? ''));
      continue;
    }
    if (element.tagName === 'circle') context.arc(number('cx'), number('cy'), number('r'), 0, Math.PI * 2);
    if (element.tagName === 'ellipse') context.ellipse(number('cx'), number('cy'), number('rx'), number('ry'), 0, 0, Math.PI * 2);
    if (element.tagName === 'rect') context.roundRect(number('x'), number('y'), number('width'), number('height'), number('rx'));
    context.stroke();
  }
}

export function icon(name: IconName, className = ''): string {
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export const brandMark = `<svg viewBox="0 0 44 44" width="44" height="44" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="43" height="43" rx="13" fill="#187c87"/><path d="m8 29 9-11 5 5 7-12 8 18H8Z" stroke="white" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 34h25M25 17l4 4 3-3M15 29l7-6" stroke="white" stroke-width="1.3" stroke-linecap="round"/><circle cx="12" cy="12" r="2" stroke="white" stroke-width="1.2"/></svg>`;
