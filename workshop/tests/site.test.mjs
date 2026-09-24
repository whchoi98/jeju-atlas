import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { buildSite } from '../scripts/build.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const manifest = () => ({
  title: '제주 배포 실습',
  subtitle: 'Codex와 AgentCore CLI',
  updatedAt: '2026-09-11',
  language: 'ko',
  chapters: [
    { id: '00', slug: '00-start', title: '실습 안내', day: 1, minutes: 15, summary: '완성할 지도를 확인합니다.' },
    { id: '01', slug: '01-tools', title: '도구 준비', day: 1, minutes: 30, summary: '터미널과 CLI를 준비합니다.' },
    { id: '02', slug: '02-finish', title: '검증과 정리', day: 2, minutes: 20, summary: '관찰 결과를 확인합니다.' },
  ],
  references: [{ slug: 'commands', title: '명령어 참고' }],
});

const documents = {
  'chapters/00-start.md': `# 00 · 실습 안내

제주 **워크숍**의 시작입니다.

[다음 장](01-tools.md#설치-확인) · [참고](../reference/commands.md#명령어)

## 학습 목표

- [ ] 지도 읽기
- [x] 준비물 확인

| 도구 | 용도 |
| --- | --- |
| Codex | 실습 |

\`\`\`bash
printf '<hello> & 제주\\n'
\`\`\`

본문 각주[^note]와 [이 절](#학습-목표).

[^note]: 각주 내용입니다.
`,
  'chapters/01-tools.md': `# 01 · 도구 준비

## 설치 확인

[안내](00-start.md#%ED%95%99%EC%8A%B5-%EB%AA%A9%ED%91%9C)
[정리](02-finish.md?from=tools#검증)
[명령어](../reference/commands.md#명령어)
[저장소 문서](../../README.md)
[프롬프트 카드](../prompts/01-tools.md)
[공식 문서](https://example.com/docs)

## 설치 확인

중복 제목도 별도로 이동할 수 있어야 합니다.

[두 번째 확인](#설치-확인-1)
`,
  'chapters/02-finish.md': `# 02 · 검증과 정리

## 검증

[앞 장](01-tools.md#설치-확인)
`,
  'reference/commands.md': `# 명령어 참고

## 명령어

[실습으로](../chapters/01-tools.md#설치-확인)
`,
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-workshop-site-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'workshop');
  const coursePath = join(source, 'course.json');
  const outputDir = join(root, 'site');
  const course = options.course ?? manifest();
  await mkdir(source, { recursive: true });
  await writeFile(coursePath, JSON.stringify(course), 'utf8');
  for (const [name, contents] of Object.entries({ ...documents, ...options.documents })) {
    if (contents === null) continue;
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  return { root, source, coursePath, outputDir, course };
}

const readPage = (output, path) => readFile(join(output, path), 'utf8');
const decodeAttribute = (value) => value.replaceAll('&amp;', '&').replaceAll('&#x26;', '&');

test('a timed course separates optional lessons from its time budget, progress and next step', async (t) => {
  const course = { ...manifest(), coreChapterCount: 2, bufferMinutes: 15, targetMinutes: 60 };
  const input = await fixture(t, { course });
  await buildSite({ coursePath: input.coursePath, outputDir: input.outputDir });
  const overview = await readPage(input.outputDir, 'index.html');
  assert.match(overview, /60분 과정/);
  assert.match(overview, /실습 45분 \+ 여유 15분/);
  assert.match(overview, /본 실습 2개 장/);
  assert.match(overview, /심화 선택/);
  assert.doesNotMatch(overview, /2일 과정/);
  assert.match(overview, /data-reading-progress max="2"/);
  assert.equal((overview.match(/data-core-chapter="true"/g) || []).length, 2);
  assert.equal((overview.match(/data-core-chapter="false"/g) || []).length, 1);
  const lastCore = await readPage(input.outputDir, 'chapters/01-tools.html');
  assert.match(lastCore, /class="pagination-link next"[^>]*href="\.\.\/index.html"/);
  const optional = await readPage(input.outputDir, 'chapters/02-finish.html');
  assert.match(optional, /심화 선택/);
  assert.match(optional, /별도 일정/);
});

test('a timed course rejects misleading totals and misplaced optional lessons', async (t) => {
  for (const change of [
    course => { course.targetMinutes = 120; },
    course => { course.coreChapterCount = 0; },
    course => { course.coreChapterCount = 4; },
    course => { course.bufferMinutes = -1; },
    course => { course.chapters[1].day = 2; },
    course => { delete course.bufferMinutes; },
  ]) {
    const course = { ...manifest(), coreChapterCount: 2, bufferMinutes: 15, targetMinutes: 60 };
    change(course);
    const input = await fixture(t, { course });
    await assert.rejects(buildSite({ coursePath: input.coursePath, outputDir: input.outputDir }),
      /core|budget|targetMinutes/);
  }
});

test('PC handbook includes downloadable Codex cards and their copyable text', async (t) => {
  const course = { ...manifest(), includePromptCards: true };
  const cards = Object.fromEntries(course.chapters.map((chapter) => [
    `prompts/${chapter.slug}.md`, `# Codex card ${chapter.id}\nRun this task on the EC2 terminal.\n`,
  ]));
  const input = await fixture(t, { course, documents: cards });
  await buildSite({ coursePath: input.coursePath, outputDir: input.outputDir });
  const page = await readPage(input.outputDir, 'chapters/01-tools.html');
  assert.match(page, /href="\.\.\/prompts\/01-tools\.md"/);
  assert.match(page, /Codex card 01/);
  assert.equal(await readFile(join(input.outputDir, 'prompts/01-tools.md'), 'utf8'),
    cards['prompts/01-tools.md']);
  assert.match(page, /data-prompt-screen/);
  for (const tool of ['codex', 'kiro', 'claude']) assert.match(page, new RegExp(`data-prompt-tool="${tool}"`));
  assert.match(page, /프롬프트 입력/);
  assert.match(page, /Agentic AI 코딩 어시스턴트의 대화 입력창/);
});

test('terminal, file and AI prompt windows identify their destination without changing copyable text', async (t) => {
  const code = 'echo \"$ATLAS_PROJECT\"';
  const prompt = '제주 장소 검색 도구를 작성해 주세요.';
  const f = await fixture(t, { documents: {
    'chapters/00-start.md': `${documents['chapters/00-start.md']}\n\n\`\`\`bash\n${code}\n\`\`\`\n\n\`\`\`json\n{\"sample\":true}\n\`\`\`\n\n\`\`\`ai-prompt\n${prompt}\n\`\`\`\n`,
  } });
  await buildSite(f);
  const page = await readPage(f.outputDir, 'chapters/00-start.html');
  assert.match(page, /data-code-kind="terminal"/);
  assert.match(page, /terminal-lights[^>]*aria-hidden="true"/);
  assert.match(page, /VSCode Server 터미널에서 실행/);
  assert.match(page, /data-code-kind="file"/);
  assert.match(page, /파일 내용/);
  assert.match(page, /data-prompt-screen/);
  assert.match(page, /<code[^>]*class="language-bash"[^>]*>echo "\$ATLAS_PROJECT"\n<\/code>/);
  assert.match(page, /<code[^>]*class="language-ai-prompt"[^>]*>제주 장소 검색 도구를 작성해 주세요\.\n<\/code>/);
});

function assistantCommands(script = 'check_env.sh') {
  return ['codex', 'claude', 'kiro'].map(assistant =>
    `\`\`\`bash assistant=${assistant}\ncd /tmp\nbash ${script} --assistant ${assistant}\n\`\`\``).join('\n\n');
}

test('assistant command variants become labelled tabs without changing shell text', async (t) => {
  const f = await fixture(t, { documents: {
    'reference/commands.md': `# 명령어 참고\n\n## 명령어\n\n${assistantCommands()}\n\n## 준비\n\n${assistantCommands('start.sh')}\n`,
  } });
  await buildSite(f);
  const page = await readPage(f.outputDir, 'reference/commands.html');
  assert.equal((page.match(/data-command-tabs/g) || []).length, 2);
  for (const [assistant, label] of [['codex', '코덱스'], ['claude', '클로드 코드'], ['kiro', '키로']]) {
    assert.equal((page.match(new RegExp(`data-command-assistant="${assistant}"`, 'g')) || []).length, 2);
    assert.match(page, new RegExp(`role="tab"[^>]*>${label}</button>`));
    assert.match(page, new RegExp(`<code[^>]*>cd /tmp\\nbash check_env\\.sh --assistant ${assistant}\\n</code>`));
    assert.match(page, new RegExp(`data-command-panel="${assistant}"`));
  }
  // Without JavaScript every labelled command must remain readable.
  assert.doesNotMatch(page, /<section[^>]*data-command-panel[^>]*\shidden/);
  await assertClosedSite(f.outputDir);
});

test('incomplete or ambiguous assistant command groups fail before publishing output', async (t) => {
  const invalid = [
    '```bash assistant=codex\ncd /tmp\n```',
    assistantCommands().replace('assistant=kiro', 'assistant=claude'),
    assistantCommands().replace('assistant=kiro', 'assistant=unknown'),
    assistantCommands().replace('bash assistant=kiro', 'json assistant=kiro'),
  ];
  for (const block of invalid) {
    const f = await fixture(t, { documents: {
      'reference/commands.md': `# 명령어 참고\n\n## 명령어\n\n${block}\n`,
    } });
    await assert.rejects(buildSite(f), /assistant|command.*group/i);
  }
});

test('assistant command tabs synchronize selection, keyboard focus and copied commands', {
  skip: process.env.WORKSHOP_BROWSER_TEST !== '1',
  timeout: 60000,
}, async (t) => {
  const f = await fixture(t, { documents: {
    'reference/commands.md': `# 명령어 참고\n\n## 명령어\n\n${assistantCommands()}\n\n## 준비\n\n${assistantCommands('start.sh')}\n`,
  } });
  await buildSite(f);
  const { chromium } = await import(pathToFileURL(
    process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
  ).href);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async value => { window.copiedCommand = value; } },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const url = pathToFileURL(join(f.outputDir, 'reference/commands.html')).href;
  await page.goto(url);
  const groups = page.locator('[data-command-tabs]');
  assert.equal(await groups.count(), 2);
  for (const [assistant, label] of [['claude', '클로드 코드'], ['kiro', '키로'], ['codex', '코덱스']]) {
    await groups.first().getByRole('tab', { name: label, exact: true }).click();
    for (let index = 0; index < 2; index++) {
      const group = groups.nth(index);
      assert.equal(await group.getByRole('tab', { name: label, exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await group.locator('[data-command-panel]:visible').count(), 1);
      const panel = group.locator(`[data-command-panel="${assistant}"]`);
      assert.equal(await panel.isVisible(), true);
      await panel.locator('[data-copy-code]').click();
      const expected = `cd /tmp\nbash ${index ? 'start.sh' : 'check_env.sh'} --assistant ${assistant}\n`;
      assert.equal(await page.evaluate(() => window.copiedCommand), expected);
    }
  }
  const first = groups.first();
  await first.getByRole('tab', { name: '코덱스', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await first.getByRole('tab', { name: '클로드 코드', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await first.getByRole('tab', { name: '키로', exact: true }).getAttribute('aria-selected'), 'true');
  await page.reload();
  assert.equal(await groups.first().getByRole('tab', { name: '키로', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('[data-command-panel]:visible').count(), 6);
  const plain = await browser.newContext({ javaScriptEnabled: false });
  const plainPage = await plain.newPage();
  await plainPage.goto(url);
  assert.equal(await plainPage.locator('[data-command-panel]:visible').count(), 6);
  assert.equal(await plainPage.locator('[role="tablist"]:visible').count(), 0);
});

test('portable course refuses to silently omit a required Codex card', async (t) => {
  const course = { ...manifest(), includePromptCards: true };
  const input = await fixture(t, { course });
  await assert.rejects(buildSite({ coursePath: input.coursePath, outputDir: input.outputDir }),
    /prompt|프롬프트/i);
});

test('AI input copies the prompt itself while the downloadable card keeps its teaching notes', async (t) => {
  const course = { ...manifest(), includePromptCards: true };
  const card = '# 작성 안내\n\n교재 설명입니다.\n\n```text\n검색 도구를 구현해 주세요.\n```\n';
  const cards = Object.fromEntries(course.chapters.map(chapter => [`prompts/${chapter.slug}.md`, card]));
  const f = await fixture(t, { course, documents: cards });
  await buildSite(f);
  const page = await readPage(f.outputDir, 'chapters/00-start.html');
  const input = page.match(/<code class="language-ai-prompt"[^>]*>([\s\S]*?)<\/code>/)?.[1];
  assert.equal(input, '검색 도구를 구현해 주세요.\n');
  assert.equal(await readFile(join(f.outputDir, 'prompts/00-start.md'), 'utf8'), card);
});

async function assertClosedSite(output) {
  const pages = ['index.html'];
  for (const dir of ['chapters', 'reference']) {
    for (const name of await readdir(join(output, dir))) pages.push(`${dir}/${name}`);
  }
  const ids = new Map();
  for (const page of pages) {
    const html = await readPage(output, page);
    const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
    const pageIds = tags.flatMap((tag) => [...tag.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    assert.equal(new Set(pageIds).size, pageIds.length, `${page} has duplicate IDs`);
    ids.set(page, new Set(pageIds));
  }
  for (const page of pages) {
    const html = await readPage(output, page);
    const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
    for (const [, raw] of tags.flatMap((tag) => [...tag.matchAll(/\b(?:href|src)="([^"]+)"/g)])) {
      const href = decodeAttribute(raw);
      if (/^(?:https?:|mailto:)/i.test(href)) continue;
      assert.ok(!href.includes('.local'), `${page} exposes a private local path`);
      assert.ok(!/\.md(?:[?#]|$)/i.test(href), `${page} still links to Markdown: ${href}`);
      const url = new URL(href, `file://${join(output, page)}`);
      const path = fileURLToPath(url);
      assert.ok(path.startsWith(`${output}/`), `${page} escapes the site: ${href}`);
      assert.ok((await stat(path)).isFile(), `${page} has a missing target: ${href}`);
      if (url.hash && path.endsWith('.html')) {
        const target = path.slice(output.length + 1);
        assert.ok(ids.get(target)?.has(decodeURIComponent(url.hash.slice(1))),
          `${page} has an unresolved fragment: ${href}`);
      }
    }
  }
}

test('builds a complete portable course with resolvable navigation, assets and anchors', async (t) => {
  const f = await fixture(t);
  const result = await buildSite(f);
  assert.equal(result.pages.length, 5);
  await assertClosedSite(f.outputDir);
  const index = await readPage(f.outputDir, 'index.html');
  assert.match(index, /lang="ko"/);
  assert.match(index, /제주 배포 실습/);
  assert.equal([...index.matchAll(/class="route-step\b/g)].length, 3);
  assert.match(index, /65|1시간 5분/);
});

test('renders GFM, safe copyable code, Korean headings and accessible footnotes', async (t) => {
  const f = await fixture(t);
  await buildSite(f);
  const html = await readPage(f.outputDir, 'chapters/00-start.html');
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"[^>]*disabled|disabled[^>]*type="checkbox"/);
  assert.match(html, /class="language-bash"/);
  assert.match(html, /printf '&#x3C;hello>|printf '&lt;hello&gt;|printf '&#x3C;hello&#x3E;/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /id="heading-학습-목표"/);
  assert.match(html, /href="#heading-학습-목표"/);
  assert.match(html, /각주/);
  await assertClosedSite(f.outputDir);
});

test('uses manifest ordering for current, previous and next chapter navigation', async (t) => {
  const f = await fixture(t);
  await buildSite(f);
  const first = await readPage(f.outputDir, 'chapters/00-start.html');
  const middle = await readPage(f.outputDir, 'chapters/01-tools.html');
  const last = await readPage(f.outputDir, 'chapters/02-finish.html');
  const reference = await readPage(f.outputDir, 'reference/commands.html');
  assert.match(middle, /href="01-tools.html"[^>]*aria-current="page"/);
  assert.match(middle, /rel="prev"[^>]*href="00-start.html"/);
  assert.match(middle, /rel="next"[^>]*href="02-finish.html"/);
  assert.doesNotMatch(first, /rel="prev"/);
  assert.doesNotMatch(last, /rel="next"/);
  assert.match(first, /data-progress-toggle/);
  assert.doesNotMatch(reference, /data-progress-toggle/);
});

test('rewrites Markdown paths, encoded fragments, duplicate headings and queries in both directions', async (t) => {
  const f = await fixture(t);
  await buildSite(f);
  const html = await readPage(f.outputDir, 'chapters/01-tools.html');
  assert.match(html, /href="00-start.html#heading-학습-목표"/);
  assert.match(html, /href="02-finish.html\?from=tools#heading-검증"/);
  assert.match(html, /href="\.\.\/reference\/commands.html#heading-명령어"/);
  assert.match(html, /id="heading-설치-확인-1"/);
  assert.match(html, /href="#heading-설치-확인-1"/);
  assert.match(await readPage(f.outputDir, 'reference/commands.html'),
    /href="\.\.\/chapters\/01-tools.html#heading-설치-확인"/);
});

test('labels source references without copying or requesting source documents', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, '.local'), { recursive: true });
  await writeFile(join(f.source, '.local/state.json'), '{"private":"fixture-only-secret"}');
  await writeFile(join(f.source, 'chapters/unlisted.md'), '# Do not publish this');
  await buildSite(f);
  const html = await readPage(f.outputDir, 'chapters/01-tools.html');
  assert.match(html, /source-reference/);
  assert.match(html, /프롬프트 카드/);
  assert.match(html, /소스 참고/);
  assert.doesNotMatch(html, /href="[^"]*(?:README|prompts|\.local)/);
  assert.doesNotMatch(html, /fixture-only-secret|Do not publish this/);
  assert.deepEqual((await readdir(join(f.outputDir, 'chapters'))).sort(),
    ['00-start.html', '01-tools.html', '02-finish.html']);
  await assert.rejects(stat(join(f.outputDir, '.local')), { code: 'ENOENT' });
});

test('preserves source-image labels and valid percent-encoded external references', async (t) => {
  const f = await fixture(t, {
    documents: {
      'chapters/02-finish.md': `# 정리\n\n## 검증\n\n![원본 소스 다이어그램](../../architecture.png)\n\n[정확한 출처](https://example.com/docs?percent=100%25)\n`,
    },
  });
  await buildSite(f);
  const html = await readPage(f.outputDir, 'chapters/02-finish.html');
  assert.match(html, /원본 소스 다이어그램/);
  assert.doesNotMatch(html, /<img[^>]*architecture\.png/);
  assert.match(html, /href="https:\/\/example\.com\/docs\?percent=100%25"/);
});

test('does not mistake literal HTML examples inside code for navigation or document IDs', async (t) => {
  const f = await fixture(t, {
    documents: {
      'chapters/02-finish.md': '# 정리\n\n## 검증\n\n```html\n<a id="top" href="not-a-real-page.html"><img src="example-only.png"></a>\n```\n',
    },
  });
  await buildSite(f);
  const html = await readPage(f.outputDir, 'chapters/02-finish.html');
  assert.match(html, /not-a-real-page\.html/);
  await assertClosedSite(f.outputDir);
});

test('bundles the existing NanumSquare fonts and their unmodified license', async (t) => {
  const f = await fixture(t);
  await buildSite(f);
  for (const file of ['NanumSquareR.woff', 'NanumSquareB.woff', 'OFL-NanumSquare.txt']) {
    assert.deepEqual(await readFile(join(f.outputDir, 'assets/fonts', file)),
      await readFile(join(repository, 'public/fonts', file)));
  }
  const css = await readPage(f.outputDir, 'assets/reader.css');
  for (const [, path] of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    assert.ok(!/^(?:https?:|\/\/)/.test(path));
    assert.ok((await stat(resolve(f.outputDir, 'assets', path))).isFile());
  }
});

test('removes executable Markdown HTML and does not load remote images', async (t) => {
  const f = await fixture(t, {
    documents: {
      'chapters/02-finish.md': `# 정리\n\n## 검증\n\n<script>window.injection = 1</script>\n\n<img src="x" onerror="window.injection=2">\n\n[실행](javascript:alert%281%29)\n\n![외부 그림](https://example.com/tracker.png)\n`,
    },
  });
  await buildSite(f);
  const html = await readPage(f.outputDir, 'chapters/02-finish.html');
  assert.doesNotMatch(html, /window\.injection|onerror=|javascript:|<img[^>]*https:/);
  assert.match(html, /외부 그림/);
  await assertClosedSite(f.outputDir);
});

test('reports every missing required document before changing existing output', async (t) => {
  const f = await fixture(t, {
    documents: { 'chapters/01-tools.md': null, 'reference/commands.md': null },
  });
  await mkdir(f.outputDir);
  await writeFile(join(f.outputDir, 'keep.txt'), 'unchanged');
  await assert.rejects(buildSite(f), (error) => {
    assert.match(error.message, /Missing workshop documents/i);
    assert.match(error.message, /chapters\/01-tools.md/);
    assert.match(error.message, /reference\/commands.md/);
    return true;
  });
  assert.equal(await readPage(f.outputDir, 'keep.txt'), 'unchanged');
  await assert.rejects(stat(join(f.outputDir, 'index.html')), { code: 'ENOENT' });
});

test('rejects broken chapter and reference links rather than treating them as source references', async (t) => {
  for (const href of ['03-missing.md', '../reference/missing.md', 'missing.html', '../missing.html']) {
    const f = await fixture(t, {
      documents: { 'chapters/02-finish.md': `# 정리\n\n## 검증\n\n[다음](${href})\n` },
    });
    await assert.rejects(buildSite(f), /Invalid course link.*02-finish\.md/s);
    await assert.rejects(stat(join(f.outputDir, 'index.html')), { code: 'ENOENT' });
  }
});

test('rejects missing local and cross-document heading fragments with actionable source context', async (t) => {
  for (const href of ['#없는-제목', '01-tools.md#없는-제목']) {
    const f = await fixture(t, {
      documents: { 'chapters/02-finish.md': `# 정리\n\n## 검증\n\n[확인](${href})\n` },
    });
    await assert.rejects(buildSite(f), /Unknown heading.*02-finish\.md.*없는-제목/s);
  }
});

test('rejects private paths, encoded private paths and source symlinks', async (t) => {
  for (const href of ['../../.local/state.json', '../%2elocal/private.md', 'file:///tmp/private.txt']) {
    const f = await fixture(t, {
      documents: { 'chapters/02-finish.md': `# 정리\n\n## 검증\n\n[로컬](${href})\n` },
    });
    await assert.rejects(buildSite(f), /private|unsafe|file:/i);
  }
  const f = await fixture(t);
  await rm(join(f.source, 'chapters/02-finish.md'));
  await writeFile(join(f.root, 'private.md'), '# Private');
  await symlink(join(f.root, 'private.md'), join(f.source, 'chapters/02-finish.md'));
  await assert.rejects(buildSite(f), /symbolic link|symlink/i);
});

test('rejects duplicate routes, invalid route paths and out-of-order chapter numbers', async (t) => {
  const cases = [
    (course) => { course.chapters[1].slug = '00-start'; },
    (course) => { course.chapters[0].slug = '../../outside'; },
    (course) => { course.references[0].slug = '.local'; },
    (course) => { course.chapters[1].id = '04'; },
    (course) => { course.chapters[0].minutes = -1; },
  ];
  for (const change of cases) {
    const course = manifest();
    change(course);
    const f = await fixture(t, { course });
    await assert.rejects(buildSite(f), /Invalid course manifest/i);
  }
});

test('does not overwrite source directories or adopt an unrelated output directory', async (t) => {
  const f = await fixture(t);
  await assert.rejects(buildSite({ ...f, outputDir: f.source }), /output.*source|source.*output/i);
  await assert.rejects(buildSite({ ...f, outputDir: join(f.source, 'chapters/site') }), /output.*source|source.*output/i);
  await mkdir(f.outputDir);
  await writeFile(join(f.outputDir, 'keep.txt'), 'unrelated');
  await assert.rejects(buildSite(f), /not.*workshop|unrelated|unowned/i);
  assert.equal(await readPage(f.outputDir, 'keep.txt'), 'unrelated');
});

test('rebuilding removes obsolete generated pages and produces deterministic HTML', async (t) => {
  const f = await fixture(t);
  await buildSite(f);
  const first = await readPage(f.outputDir, 'index.html');
  await buildSite(f);
  assert.equal(await readPage(f.outputDir, 'index.html'), first);
  f.course.references.push({ slug: 'extra', title: '추가 참고' });
  await writeFile(f.coursePath, JSON.stringify(f.course));
  await writeFile(join(f.source, 'reference/extra.md'), '# 추가 참고');
  await buildSite(f);
  assert.ok((await stat(join(f.outputDir, 'reference/extra.html'))).isFile());
  f.course.references.pop();
  await writeFile(f.coursePath, JSON.stringify(f.course));
  await buildSite(f);
  await assert.rejects(stat(join(f.outputDir, 'reference/extra.html')), { code: 'ENOENT' });
});

test('CLI supports an explicit fixture course and output and returns nonzero for incomplete content', async (t) => {
  const f = await fixture(t);
  const script = join(repository, 'workshop/scripts/build.mjs');
  const good = spawnSync(process.execPath, [script, '--course', f.coursePath, '--output', f.outputDir], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  await assertClosedSite(f.outputDir);
  await rm(join(f.source, 'chapters/01-tools.md'));
  const bad = spawnSync(process.execPath, [script, '--course', f.coursePath, '--output', f.outputDir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Missing workshop documents.*01-tools\.md/s);
});

// Opt in to the same installed Playwright/Chromium used by scripts/browser-*.mjs:
// WORKSHOP_BROWSER_TEST=1 node --test workshop/tests/site.test.mjs
// WORKSHOP_SCREENSHOTS=/tmp/atlas-reader-review also saves visual review images.
test('reader works over file and HTTP with keyboard, copy, progress, themes, print and mobile navigation', {
  skip: process.env.WORKSHOP_BROWSER_TEST !== '1',
  timeout: 60000,
}, async (t) => {
  const f = await fixture(t);
  await buildSite(f);
  const { chromium } = await import(pathToFileURL(
    process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
  ).href);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  t.after(() => browser.close());
  const contentTypes = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.woff': 'font/woff', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const path = resolve(f.outputDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${f.outputDir}/`)) throw new Error('Outside fixture');
      response.setHeader('Content-Type', contentTypes[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch {
      response.statusCode = 404;
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const httpBase = `http://127.0.0.1:${server.address().port}/`;
  const fileBase = pathToFileURL(`${f.outputDir}/`).href;
  const screenshotDirectory = process.env.WORKSHOP_SCREENSHOTS;
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  const screenshot = async (page, name) => {
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `${name}.png`), fullPage: true });
  };
  const noOverflow = async (page) => {
    const dimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(dimensions.content <= dimensions.width, JSON.stringify(dimensions));
  };
  const errors = [];
  const unexpectedRequests = [];
  const makeContext = async (options = {}) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', colorScheme: 'light',
      reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'], ...options,
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'file:' || (url.hostname === '127.0.0.1' && url.port === String(server.address().port))) return route.continue();
      unexpectedRequests.push(url.href);
      return route.abort();
    });
    context.on('page', (page) => {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('request', (request) => {
        if (['fetch', 'xhr', 'websocket'].includes(request.resourceType())
          || /\.(?:md)(?:[?#]|$)|\/\.local\//.test(request.url())) unexpectedRequests.push(request.url());
      });
    });
    return context;
  };

  for (const [scheme, base] of [['http', httpBase], ['file', fileBase]]) {
    const context = await makeContext();
    const page = await context.newPage();
    await page.goto(`${base}index.html`);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('16px NanumSquare')), true);
    assert.equal(await page.locator('[data-progress-count]').textContent(), '0 / 3 읽음');
    assert.equal(await page.locator('[data-reset-progress]').isVisible(), false);
    await noOverflow(page);
    await screenshot(page, `${scheme}-overview-light`);
    await page.keyboard.press('/');
    assert.equal(await page.locator('#chapter-search').evaluate((input) => input === document.activeElement), true);
    await page.locator('#chapter-search').fill('설치 확인');
    assert.equal(await page.locator('[data-nav-entry]:visible').count(), 1);
    await page.locator('#chapter-search').fill('검색결과없음');
    assert.equal(await page.locator('[data-search-empty]').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-nav-entry]:visible').count(), 4);
    await page.locator('.route-step a').first().click();
    await page.waitForURL('**/chapters/00-start.html');
    await noOverflow(page);
    await screenshot(page, `${scheme}-chapter-light`);
    if (scheme === 'file') {
      await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true, value: () => Promise.reject(new DOMException('Blocked for fallback test')),
      }));
    }
    await page.locator('[data-copy-code]').first().click();
    await page.waitForFunction(() => document.querySelector('[data-copy-code]').textContent === '복사됨');
    assert.equal(await page.locator('[data-copy-code]').first().textContent(), '복사됨');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "printf '<hello> & 제주\\n'\n");
    await page.locator('[data-progress-toggle]').click();
    assert.equal(await page.locator('[data-progress-count]').textContent(), '1 / 3 읽음');
    assert.equal(await page.locator('[data-reset-progress]').isVisible(), true);
    assert.equal(await page.locator('[data-progress-toggle]').getAttribute('aria-pressed'), 'true');
    await page.reload();
    assert.equal(await page.locator('[data-progress-count]').textContent(), '1 / 3 읽음');
    await page.locator('[data-theme-toggle]').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await screenshot(page, `${scheme}-chapter-dark`);
    await page.locator('a[rel="next"]').click();
    await page.waitForURL('**/chapters/01-tools.html');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('[data-progress-count]').textContent(), '1 / 3 읽음');
    assert.equal(await page.locator('[data-progress-toggle]').getAttribute('aria-pressed'), 'false');
    await page.locator('[data-progress-toggle]').click();
    await page.locator('.overview-link').click();
    await page.waitForURL('**/index.html');
    assert.equal(await page.locator('[data-resume-link]').getAttribute('href'), 'chapters/02-finish.html');
    assert.equal(await page.locator('.route-step.is-read').count(), 2);
    await page.setViewportSize({ width: 1440, height: 480 });
    await page.goto(`${base}chapters/02-finish.html`);
    await page.evaluate(() => document.fonts.ready);
    const activeBounds = await page.evaluate(() => {
      const item = document.querySelector('.chapter-link[aria-current="page"]').getBoundingClientRect();
      const region = document.querySelector('#chapter-navigation').getBoundingClientRect();
      return { top: item.top, bottom: item.bottom, regionTop: region.top, regionBottom: region.bottom };
    });
    assert.ok(activeBounds.top >= activeBounds.regionTop && activeBounds.bottom <= activeBounds.regionBottom,
      `Current chapter must be visible inside the sidebar: ${JSON.stringify(activeBounds)}`);
    assert.equal(await page.evaluate(() => scrollY), 0, 'Revealing the current chapter must not scroll the document');
    await page.locator('[data-progress-toggle]').click();
    await page.locator('.overview-link').click();
    await page.waitForURL('**/index.html');
    assert.equal(await page.locator('[data-progress-count]').textContent(), '3 / 3 읽음');
    assert.equal(await page.locator('[data-resume-link]').getAttribute('href'), 'chapters/00-start.html');
    await page.locator('[data-reset-progress]').click();
    assert.equal(await page.locator('[data-progress-count]').textContent(), '0 / 3 읽음');
    await page.evaluate(() => localStorage.setItem(
      `jeju-atlas:workshop:${document.body.dataset.courseKey}:reading:v1`,
      JSON.stringify({ version: 1, read: ['00-start', 'not-in-this-course', '00-start'] }),
    ));
    await page.reload();
    assert.equal(await page.locator('[data-progress-count]').textContent(), '1 / 3 읽음');
    await page.evaluate(() => localStorage.setItem(
      `jeju-atlas:workshop:${document.body.dataset.courseKey}:reading:v1`, '{invalid JSON',
    ));
    await page.reload();
    assert.equal(await page.locator('[data-progress-count]').textContent(), '0 / 3 읽음');
    await page.locator('.route-step a').first().click();
    await page.waitForURL('**/chapters/00-start.html');
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    assert.equal(await page.locator('#course-nav').evaluate((node) => node.inert), true);
    await screenshot(page, `${scheme}-mobile-chapter`);
    await page.locator('[data-nav-toggle]').click();
    assert.equal(await page.locator('#course-nav').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('[data-workspace]').evaluate((node) => node.inert), true);
    await screenshot(page, `${scheme}-mobile-menu`);
    for (let step = 0; step < 18; step++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#course-nav').evaluate((node) => node.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-nav-toggle]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-nav-toggle]').evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
    await page.setViewportSize({ width: 320, height: 740 });
    await noOverflow(page);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.topbar').isVisible(), false);
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.locator('[data-progress-toggle]').isVisible(), false);
    assert.equal(await page.locator('.prose pre code').first().evaluate((node) => getComputedStyle(node).whiteSpace), 'pre-wrap');
    await page.emulateMedia({ media: 'screen' });
    await context.close();
  }

  const storageDenied = await makeContext();
  await storageDenied.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Disabled storage', 'SecurityError'); } });
  });
  const deniedPage = await storageDenied.newPage();
  await deniedPage.goto(`${fileBase}chapters/00-start.html`);
  assert.match(await deniedPage.locator('[data-storage-note]').textContent(), /이 페이지에서만/);
  await deniedPage.locator('[data-progress-toggle]').click();
  assert.equal(await deniedPage.locator('[data-progress-count]').textContent(), '1 / 3 읽음');
  await deniedPage.reload();
  assert.equal(await deniedPage.locator('[data-progress-count]').textContent(), '0 / 3 읽음');
  await storageDenied.close();

  const withoutJs = await makeContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const plainPage = await withoutJs.newPage();
  await plainPage.goto(`${fileBase}index.html`);
  assert.equal(await plainPage.locator('.route-step a').count(), 3);
  await plainPage.locator('.route-step a').first().click();
  await plainPage.waitForURL('**/chapters/00-start.html');
  assert.equal(await plainPage.locator('.prose').isVisible(), true);
  assert.equal(await plainPage.locator('noscript').isVisible(), true);
  await noOverflow(plainPage);
  await withoutJs.close();
  assert.deepEqual(unexpectedRequests, [], 'The reader must not request remote resources, Markdown or private state');
  assert.deepEqual(errors, [], 'The reader must have no browser runtime or resource errors');
});
