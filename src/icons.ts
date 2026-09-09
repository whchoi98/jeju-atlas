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
} as const;

export type IconName = keyof typeof paths;

export function icon(name: IconName, className = ''): string {
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export const brandMark = `<svg viewBox="0 0 44 44" width="44" height="44" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="43" height="43" rx="13" fill="#187c87"/><path d="m8 29 9-11 5 5 7-12 8 18H8Z" stroke="white" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 34h25M25 17l4 4 3-3M15 29l7-6" stroke="white" stroke-width="1.3" stroke-linecap="round"/><circle cx="12" cy="12" r="2" stroke="white" stroke-width="1.2"/></svg>`;
