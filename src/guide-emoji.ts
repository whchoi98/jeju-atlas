// Fixed UI assets only. Markdown content never calls this helper.
// Twemoji v14.0.2 graphics © Twitter, Inc and other contributors, CC BY 4.0.
const symbols = {
  '🤖': { file: '1f916.svg', label: 'AI 로봇' },
  '🧭': { file: '1f9ed.svg', label: '나침반' },
  '🍽️': { file: '1f37d.svg', label: '식사' },
  '🌿': { file: '1f33f.svg', label: '자연' },
  '☔': { file: '2614.svg', label: '비 오는 날' },
  '👨‍👩‍👧': { file: '1f468-200d-1f469-200d-1f467.svg', label: '가족' },
} as const;

export function guideEmoji(value: string): string {
  const emoji = Object.hasOwn(symbols, value) ? value as keyof typeof symbols : '🧭';
  const symbol = symbols[emoji];
  return `<img class="guide-ui-emoji" src="/emoji/${symbol.file}" width="20" height="20" alt="${emoji} ${symbol.label}" data-emoji="${emoji}" draggable="false" decoding="async">`;
}
