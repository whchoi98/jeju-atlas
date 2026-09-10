import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guideEmoji } from '../src/guide-emoji.ts';

const assets = [
  ['🤖', '1f916.svg'], ['🧭', '1f9ed.svg'], ['🍽️', '1f37d.svg'],
  ['🌿', '1f33f.svg'], ['☔', '2614.svg'], ['👨‍👩‍👧', '1f468-200d-1f469-200d-1f467.svg'],
];

test('fixed UI emoji resolve to small local, self-contained SVGs with accessible Unicode labels', async () => {
  let total = 0;
  for (const [emoji, file] of assets) {
    const markup = guideEmoji(emoji);
    assert.ok(markup.includes(`src="/emoji/${file}"`));
    assert.ok(markup.includes(`data-emoji="${emoji}"`));
    assert.ok(markup.includes(`alt="${emoji} `));
    const svg = await readFile(new URL(`../public/emoji/${file}`, import.meta.url), 'utf8');
    total += Buffer.byteLength(svg);
    assert.match(svg, /<svg\b/);
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|\bon\w+\s*=|(?:href|src)=["']https?:/i);
  }
  assert.ok(total < 15000);
});

test('UI emoji helper cannot turn arbitrary model text or URLs into image sources', () => {
  for (const value of ['https://tracker.invalid/pixel.svg', '"><img src=x onerror=alert(1)>', '__proto__']) {
    const markup = guideEmoji(value);
    assert.match(markup, /src="\/emoji\/1f9ed\.svg"/);
    assert.doesNotMatch(markup, /tracker|onerror|__proto__/);
  }
});
