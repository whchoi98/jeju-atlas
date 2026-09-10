import test from 'node:test';
import assert from 'node:assert/strict';

let renderGuideMarkdown;
try { ({ renderGuideMarkdown } = await import('../src/guide-markdown.ts')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('assistant answers render headings, emphasis, lists, safe links and fenced code', async () => {
  assert.equal(typeof renderGuideMarkdown, 'function');
  const output = await renderGuideMarkdown('# 한라산 식사\n\n**확인된 장소**와 *이용 정보*\n\n- [장소 출처](https://visitjeju.net/detail?id=1&lang=ko)\n- `주차` 확인\n\n1. 위치 확인\n2. 방문 문의\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.match(output, /<h[1-6]>한라산 식사<\/h[1-6]>/);
  assert.match(output, /<strong>확인된 장소<\/strong>/);
  assert.match(output, /<em>이용 정보<\/em>/);
  assert.match(output, /<ul>/);
  assert.match(output, /<ol>/);
  assert.match(output, /href="https:\/\/visitjeju\.net\/detail\?id=1(?:&amp;|&#x26;)lang=ko"/i);
  assert.match(output, /rel="noopener noreferrer"/);
  assert.match(output, /<code>주차<\/code>/);
  assert.match(output, /<pre><code[^>]*>(?:&lt;|&#x3c;)img src=x onerror=alert\(1\)(?:&gt;|>)/i);
});

test('tables and nested lists retain their structure without accepting raw HTML', async () => {
  assert.equal(typeof renderGuideMarkdown, 'function');
  const output = await renderGuideMarkdown('| 장소 | 자료 |\n| --- | --- |\n| **공원** | 주차 정보 |\n| 식당 | 정보 없음 |\n\n- 첫 장소\n  - 안내 확인\n\n> 방문 전 확인하세요.');
  assert.match(output, /<table>/);
  assert.match(output, /<th[^>]*>장소<\/th>/);
  assert.match(output, /<td[^>]*><strong>공원<\/strong><\/td>/);
  assert.match(output, /<li>[\s\S]*<ul>/);
  assert.match(output, /<blockquote>/);
});

test('raw HTML stays escaped, images never load, and unsafe or credentialed links become text', async () => {
  assert.equal(typeof renderGuideMarkdown, 'function');
  const attack = [
    '<script>window.__unsafe = 1</script>',
    '<img src=x onerror="window.__unsafe=2">',
    '<svg onload="window.__unsafe=3"></svg>',
    '[bad](javascript:alert(1))', '[data](data:text/html,test)',
    '[vb](vbscript:msgbox(1))', '[file](file:///tmp/private)',
    '[entity](jav&#x61;script:alert(1))',
    '[credentials](https://user:password@example.com/private)',
    '![remote](https://tracker.example/image.png)',
  ].join('\n\n');
  const output = await renderGuideMarkdown(attack);
  assert.doesNotMatch(output, /<(?:script|img|svg|iframe|style)\b/i);
  assert.doesNotMatch(output, /\shref=/i);
  assert.match(output, /(?:&lt;|&#x3c;)script(?:&gt;|>)/i);
  assert.match(output, /credentials/);
  assert.doesNotMatch(output, /user:password/);
  assert.match(output, /remote/);
});

test('inline markup cannot escape a safe link attribute or a code fence', async () => {
  assert.equal(typeof renderGuideMarkdown, 'function');
  const output = await renderGuideMarkdown('[원문](https://example.com/?q=%22onmouseover%3Dalert)\n\n```text\n</code></pre><img src=x onerror=alert(1)>\n```\n\n**마지막**');
  assert.match(output, /<a href="https:\/\/example.com/);
  assert.doesNotMatch(output, /<img| onmouseover="| onerror="/);
  assert.match(output, /(?:&lt;|&#x3c;)\/code(?:&gt;|>)(?:&lt;|&#x3c;)\/pre(?:&gt;|>)(?:&lt;|&#x3c;)img/i);
  assert.match(output, /<strong>마지막<\/strong>/);
});

test('the reference GFM pipeline supports autolinks, tasks, references and nested emphasis', async () => {
  const output = await renderGuideMarkdown('www.visitjeju.net\n\n- [x] **확인한 _자료_**\n- [ ] 미확인\n\n[공식 안내][source]\n\n[source]: https://example.com/source\n\n~~수정 전~~');
  assert.match(output, /href="http:\/\/www\.visitjeju\.net\/?"/);
  assert.match(output, /type="checkbox"/);
  assert.match(output, /disabled/);
  assert.match(output, /<strong>확인한 <em>자료<\/em><\/strong>/);
  assert.match(output, /href="https:\/\/example.com\/source"/);
  assert.match(output, /<del>수정 전<\/del>/);
});

test('seasonal months and opening-hour ranges keep literal tildes', async () => {
  const output = await renderGuideMarkdown('11~2월 06:00~18:00, 5~8월 04:30~20:00입니다.\n\n~~폐기한 안내~~');
  assert.match(output, /11~2월 06:00~18:00/);
  assert.match(output, /5~8월 04:30~20:00/);
  assert.match(output, /<del>폐기한 안내<\/del>/);
  assert.equal((output.match(/<del>/g) || []).length, 1);
});
