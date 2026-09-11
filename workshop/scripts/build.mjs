#!/usr/bin/env node
/**
 * Build the workshop without a server, Markdown fetches, or deployment state.
 *
 *   node workshop/scripts/build.mjs
 *   node workshop/scripts/build.mjs --output /tmp/atlas-workshop-preview
 *   node workshop/scripts/build.mjs --course /tmp/fixture/course.json --output /tmp/fixture/site
 *
 * Only manifest-listed documents, workshop/assets and the named public fonts
 * enter the output. A failed content/link check leaves existing output intact.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

const scriptPath = fileURLToPath(import.meta.url);
const workshopRoot = resolve(dirname(scriptPath), '..');
const repositoryRoot = resolve(workshopRoot, '..');
const assetsRoot = join(workshopRoot, 'assets');
const outputMarker = '.workshop-site.json';
const generator = 'jeju-atlas-workshop/v1';
const fontFiles = ['NanumSquareR.woff', 'NanumSquareB.woff', 'OFL-NanumSquare.txt'];
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const text = (value) => ({ type: 'text', value });
const element = (tagName, properties = {}, children = []) => ({ type: 'element', tagName, properties, children });
const nodeText = (node) => node.type === 'text' || node.type === 'inlineCode'
  ? node.value : node.alt ?? (node.children ?? []).map(nodeText).join('');
const isInside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function manifestError(message) {
  throw new Error(`Invalid course manifest: ${message}`);
}

function validateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) manifestError('expected an object');
  for (const key of ['title', 'subtitle']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) manifestError(`${key} must be nonempty text`);
  }
  if (!Array.isArray(input.chapters) || !input.chapters.length) manifestError('chapters must not be empty');
  if (!Array.isArray(input.references)) manifestError('references must be an array');
  if (input.includePromptCards !== undefined && typeof input.includePromptCards !== 'boolean') {
    manifestError('includePromptCards must be boolean');
  }
  if (input.language && !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(input.language)) manifestError('invalid language');
  if (input.updatedAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.updatedAt)) manifestError('updatedAt must use YYYY-MM-DD');
  const seen = new Set();
  let lastDay = 1;
  const entries = [];
  for (const kind of ['chapters', 'reference']) {
    const list = kind === 'chapters' ? input.chapters : input.references;
    for (const [index, entry] of list.entries()) {
      if (!entry || typeof entry !== 'object') manifestError(`${kind}[${index}] must be an object`);
      if (typeof entry.slug !== 'string' || !slugPattern.test(entry.slug)) manifestError(`unsafe slug in ${kind}[${index}]`);
      if (typeof entry.title !== 'string' || !entry.title.trim()) manifestError(`${entry.slug}: title is required`);
      const route = `${kind}/${entry.slug}`;
      if (seen.has(route)) manifestError(`duplicate route ${route}`);
      seen.add(route);
      if (kind === 'chapters') {
        const expected = String(index).padStart(2, '0');
        if (entry.id !== expected) manifestError(`${entry.slug}: chapter id must be ${expected} in navigation order`);
        if (!Number.isInteger(entry.day) || entry.day < lastDay) manifestError(`${entry.slug}: days must be positive and ordered`);
        if (!Number.isInteger(entry.minutes) || entry.minutes <= 0) manifestError(`${entry.slug}: minutes must be a positive integer`);
        if (entry.summary !== undefined && typeof entry.summary !== 'string') manifestError(`${entry.slug}: summary must be text`);
        lastDay = entry.day;
      }
      entries.push({
        ...entry, kind, index,
        sourceFile: `${route}.md`,
        outputFile: `${route}.html`,
      });
    }
  }
  return { ...input, language: input.language || 'ko', entries };
}

async function assertNoSymlinks(path, root) {
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in workshop input/output: ${current}`);
    }
  }
}

function decodeUrl(value, context) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid URL encoding in ${context}: ${value}`);
  }
}

function checkPrivateUrl(url, context) {
  let decoded = url;
  for (let count = 0; count < 4; count++) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // An encoded literal percent (%25) is valid after the first decode.
      if (count === 0) throw new Error(`Invalid URL encoding in ${context}: ${url}`);
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (/^file:/i.test(decoded) || /(?:^|[/\\])\.(?:local|aws|ssh|git|env(?:\.[^/\\?#]*)?)(?:[/\\?#]|$)/i.test(decoded)
    || /[\u0000-\u001f\\]/.test(decoded)) {
    throw new Error(`Unsafe/private link in ${context}: ${url}`);
  }
}

function headingSlug(value) {
  return value.normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-') || 'section';
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, {
    // The sanitizer adds its own prefix. Reconcile links after sanitation.
    clobberPrefix: 'note-',
    footnoteLabel: '각주',
    footnoteBackLabel: (referenceIndex, rereferenceIndex) =>
      `본문의 각주 ${referenceIndex + 1}${rereferenceIndex > 1 ? ` (${rereferenceIndex})` : ''}로 돌아가기`,
  })
  .use(rehypeSanitize);
const stringifier = unified().use(rehypeStringify);

function decorateBlocks(node, counter) {
  if (node.children) node.children = node.children.map((child) => decorateBlocks(child, counter));
  if (node.type !== 'element') return node;
  if (node.tagName === 'th') node.properties.scope = 'col';
  if (node.tagName === 'table') {
    return element('div', {
      className: ['table-scroll'], tabIndex: 0, role: 'region', ariaLabel: '가로로 스크롤할 수 있는 표',
    }, [node]);
  }
  if (node.tagName !== 'pre' || node.children[0]?.tagName !== 'code') return node;
  const code = node.children[0];
  const language = (code.properties.className ?? []).find((name) => name.startsWith('language-'))?.slice(9) || 'text';
  const id = `code-${++counter.value}`;
  code.properties.id = id;
  node.properties.tabIndex = 0;
  node.properties.ariaLabel = `${language} 코드`;
  return element('div', { className: ['code-block'] }, [
    element('div', { className: ['code-toolbar'] }, [
      element('span', { className: ['code-language'] }, [text(language)]),
      element('button', {
        type: 'button', className: ['copy-button', 'js-only'], dataCopyCode: id, ariaLabel: `${language} 코드 복사`,
      }, [text('복사')]),
    ]),
    node,
  ]);
}

async function prepareDocument(entry, source, sourcePath) {
  const mdast = markdownProcessor.parse(source);
  visit(mdast, (node) => {
    if (node.url) checkPrivateUrl(node.url, entry.sourceFile);
  });
  let tree = await markdownProcessor.run(mdast);
  const headings = [];
  const aliases = new Map();
  const used = new Set();
  const firstElement = tree.children.find((node) => node.type === 'element');
  let title = entry.title;
  let titleId;
  visit(tree, (node) => {
    if (node.type !== 'element' || !/^h[1-6]$/.test(node.tagName)) return;
    if (String(node.properties.id ?? '').endsWith('footnote-label')) return;
    const label = nodeText(node);
    const base = headingSlug(label);
    let slug = base;
    let duplicate = 0;
    while (used.has(slug)) slug = `${base}-${++duplicate}`;
    used.add(slug);
    const id = `heading-${slug}`;
    node.properties.id = id;
    aliases.set(slug, id);
    if (node === firstElement && node.tagName === 'h1') {
      title = label.replace(new RegExp(`^${entry.id ?? '(?!)'}\\s*[·.:—–-]\\s*`), '').trim() || label;
      titleId = id;
    } else {
      if (node.tagName === 'h1') node.tagName = 'h2';
      headings.push({ id, label, depth: Number(node.tagName.slice(1)) });
    }
  });
  if (titleId) tree.children = tree.children.filter((node) => node !== firstElement);
  else {
    let slug = headingSlug(title);
    while (used.has(slug)) slug += '-title';
    titleId = `heading-${slug}`;
    aliases.set(slug, titleId);
  }
  tree = decorateBlocks(tree, { value: 0 });
  const anchors = new Set([titleId, 'top', 'main-content', 'course-nav', 'on-this-page']);
  visit(tree, (node) => {
    if (node.properties?.id) anchors.add(node.properties.id);
  });
  return { ...entry, title, navTitle: entry.title, titleId, sourcePath, tree, headings, aliases, anchors };
}

function fragmentFor(target, fragment, context) {
  if (!fragment) return '';
  const name = decodeUrl(fragment.slice(1), context).normalize('NFC');
  const id = target.aliases.get(name)
    ?? (target.anchors.has(name) ? name : null)
    ?? (target.anchors.has(`user-content-${name}`) ? `user-content-${name}` : null);
  if (!id) throw new Error(`Unknown heading in ${context}: #${name} (target: ${target.sourceFile ?? 'index.html'})`);
  return `#${id}`;
}

function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const rest = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  return {
    path: queryAt === -1 ? rest : rest.slice(0, queryAt),
    query: queryAt === -1 ? '' : rest.slice(queryAt),
    fragment,
  };
}

function sourceReference(node, sourcePath) {
  const children = node.tagName === 'img' ? [text(node.properties.alt || '이미지')] : (node.children ?? []);
  return element('span', {
    className: ['source-reference'],
    title: `소스 저장소에서 확인: ${sourcePath}`,
  }, [...children,
    text(' '), element('small', {}, [text('소스 참고')])]);
}

function rewriteDocumentLinks(doc, bySource, byOutput, assetFiles) {
  function rewrite(node) {
    if (node.children) node.children = node.children.map(rewrite);
    if (node.type !== 'element') return node;
    if (node.properties.ariaDescribedBy) {
      node.properties.ariaDescribedBy = node.properties.ariaDescribedBy.map((id) =>
        doc.anchors.has(`user-content-${id}`) ? `user-content-${id}` : id);
    }
    const isImage = node.tagName === 'img';
    if (!isImage && node.tagName !== 'a') return node;
    if ('dataFootnoteBackref' in node.properties) {
      node.children = [element('svg', {
        className: ['footnote-back-icon'], viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: 'true',
      }, [element('path', { d: 'm9 9-5 5 5 5M4 14h10a6 6 0 0 0 0-12' })])];
    }
    let url = node.properties[isImage ? 'src' : 'href'];
    if (!url) return isImage ? sourceReference(node, '이미지 경로 생략') : node;
    checkPrivateUrl(url, doc.sourceFile);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/^(?:https?:|mailto:)/i.test(url)) {
      if (isImage) {
        // An offline reader never contacts an image host on page load.
        node = element('a', {}, [text(node.properties.alt || '그림 출처')]);
      }
      node.properties.href = url;
      node.properties.className = ['external-link'];
      node.properties.rel = ['noopener', 'noreferrer'];
      node.properties.target = '_blank';
      node.children.push(element('span', { className: ['sr-only'] }, [text(' (새 탭)')]));
      return node;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('/')) {
      throw new Error(`Unsafe absolute link in ${doc.sourceFile}: ${url}`);
    }
    const { path: rawPath, query, fragment } = splitUrl(url);
    const path = decodeUrl(rawPath, doc.sourceFile);
    if (!path && !isImage) {
      node.properties.href = `${query}${fragmentFor(doc, fragment, doc.sourceFile) || '#top'}`;
      return node;
    }
    const outputPath = posix.normalize(posix.join(posix.dirname(doc.outputFile), path));
    const sourcePath = resolve(dirname(doc.sourcePath), path);
    const target = /\.md$/i.test(path) ? bySource.get(sourcePath) : byOutput.get(outputPath);
    if (target && !isImage) {
      const targetPath = posix.relative(posix.dirname(doc.outputFile), target.outputFile);
      node.properties.href = `${targetPath}${query}${fragmentFor(target, fragment, doc.sourceFile)}`;
      return node;
    }
    if (assetFiles.has(outputPath)) {
      node.properties[isImage ? 'src' : 'href'] = `${posix.relative(posix.dirname(doc.outputFile), outputPath)}${query}${fragment}`;
      if (!isImage && outputPath.startsWith('prompts/') && outputPath.endsWith('.md')) {
        node.properties.download = posix.basename(outputPath);
      }
      if (isImage) {
        node.properties.loading = 'lazy';
        node.properties.decoding = 'async';
      }
      return node;
    }
    const courseDirectory = dirname(dirname(doc.sourcePath));
    const inCourseDocuments = ['chapters', 'reference'].some((kind) => isInside(join(courseDirectory, kind), sourcePath));
    const inCourseHtml = /\.html?$/i.test(path) && isInside(courseDirectory, sourcePath);
    if (/\.(?:md|html?)$/i.test(path) && (inCourseDocuments || inCourseHtml || outputPath === 'index.html')) {
      throw new Error(`Invalid course link in ${doc.sourceFile}: ${url} is not in course.json`);
    }
    if (outputPath.startsWith('assets/')) {
      throw new Error(`Missing workshop asset in ${doc.sourceFile}: ${url}`);
    }
    return sourceReference(node, path);
  }
  doc.tree = rewrite(doc.tree);
  doc.html = String(stringifier.stringify(doc.tree));
}

const iconPaths = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  moon: '<path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  print: '<path d="M7 8V3h10v5M7 17H4V8h16v9h-3M7 14h10v7H7Z"/><path d="M16 11h1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  book: '<path d="M12 5v15M3 4c4-1 6 0 9 1 3-1 5-2 9-1v15c-4-1-6 0-9 1-3-1-5-2-9-1Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] ?? ''}</svg>`;
const duration = (minutes) => `${minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : ''}${minutes >= 60 && minutes % 60 ? ' ' : ''}${minutes % 60 || minutes < 60 ? `${minutes % 60}분` : ''}`;
const pageHref = (page, target) => posix.relative(posix.dirname(page), target);
const totalMinutes = (entries) => entries.reduce((sum, entry) => sum + entry.minutes, 0);

function sidebar(course, docs, currentFile) {
  const chapters = docs.filter((doc) => doc.kind === 'chapters');
  const references = docs.filter((doc) => doc.kind === 'reference');
  const days = [...new Set(chapters.map((doc) => doc.day))];
  const current = (doc) => doc.outputFile === currentFile ? ' aria-current="page"' : '';
  const navItem = (doc) => `<li data-nav-entry data-search="${escapeHtml([doc.id, doc.navTitle, doc.summary, ...doc.headings.map((heading) => heading.label)].filter(Boolean).join(' '))}">
    <a class="${doc.kind === 'chapters' ? 'chapter-link' : 'reference-link'}" href="${pageHref(currentFile, doc.outputFile)}"${current(doc)}${doc.kind === 'chapters' ? ` data-chapter-link="${escapeHtml(doc.slug)}"` : ''}>
      ${doc.kind === 'chapters' ? `<span class="nav-number">${doc.id}</span>` : icon('book')}
      <span class="nav-title">${escapeHtml(doc.navTitle)}</span>
      ${doc.kind === 'chapters' ? `<span class="read-indicator" aria-hidden="true">${icon('check')}</span>` : ''}
    </a></li>`;
  return `<aside class="sidebar" id="course-nav" aria-label="워크숍 목차">
    <div class="sidebar-brand">
      <a class="brand" href="${pageHref(currentFile, 'index.html')}" aria-label="Jeju Atlas 워크숍 전체 과정">
        <img src="${pageHref(currentFile, 'assets/mark.svg')}" width="42" height="42" alt="">
        <span><strong>Jeju Atlas</strong><span>배포 워크숍</span></span>
      </a>
      <button class="icon-button mobile-only js-only" type="button" data-nav-close aria-label="목차 닫기">${icon('close')}</button>
    </div>
    <div class="nav-search js-only">
      <label class="sr-only" for="chapter-search">챕터와 참고 자료의 제목·주제 검색</label>
      ${icon('search')}<input id="chapter-search" type="search" placeholder="제목·주제 검색" autocomplete="off" spellcheck="false" aria-controls="chapter-navigation">
      <kbd aria-hidden="true">/</kbd>
    </div>
    <p class="search-result sr-only" data-search-result role="status" aria-live="polite"></p>
    <nav class="chapter-navigation" id="chapter-navigation" aria-label="전체 과정과 챕터">
      <a class="overview-link" href="${pageHref(currentFile, 'index.html')}"${currentFile === 'index.html' ? ' aria-current="page"' : ''}>전체 과정<span aria-hidden="true">${chapters[0].id} — ${chapters.at(-1).id}</span></a>
      ${days.map((day) => `<section class="nav-group" data-nav-group aria-label="${day}일 차">
        <h2><span>DAY ${day}</span><span>${duration(totalMinutes(chapters.filter((doc) => doc.day === day)))}</span></h2>
        <ol>${chapters.filter((doc) => doc.day === day).map(navItem).join('')}</ol>
      </section>`).join('')}
      ${references.length ? `<section class="nav-group reference-group" data-nav-group aria-label="참고 자료"><h2>참고 자료</h2><ul>${references.map(navItem).join('')}</ul></section>` : ''}
      <p class="search-empty" data-search-empty hidden>검색 결과가 없습니다.<br>다른 제목이나 주제를 입력하세요.</p>
    </nav>
    <div class="reading-progress">
      <div class="progress-label"><span>나의 읽기 기록</span><strong data-progress-count>0 / ${chapters.length} 읽음</strong></div>
      <progress data-reading-progress max="${chapters.length}" value="0" aria-label="읽은 챕터 수"></progress>
      <p data-storage-note>이 브라우저에만 저장됩니다.<br>AWS 배포 상태를 나타내지 않습니다.</p>
      <button class="text-button js-only" type="button" data-reset-progress hidden>읽기 기록 초기화</button>
    </div>
  </aside>`;
}

function courseOverview(course, docs, architecture) {
  const chapters = docs.filter((doc) => doc.kind === 'chapters');
  const references = docs.filter((doc) => doc.kind === 'reference');
  const days = [...new Set(chapters.map((doc) => doc.day))];
  return `<div class="overview">
    <header class="overview-header">
      <p class="eyebrow"><span class="eyebrow-dot"></span>JEJU ATLAS · HANDS-ON WORKSHOP</p>
      <h1 id="overview-title">${escapeHtml(course.title)}</h1>
      <p class="overview-subtitle">${escapeHtml(course.subtitle)}</p>
      <p class="overview-intro">준비부터 배포, 검증과 정리까지.<br>번호 순서대로 읽고, 터미널에서 직접 연결하며 완성하는 실습입니다.</p>
      <div class="course-meta"><span>${days.length}일 과정</span><span>${chapters.length}개 챕터</span><span>약 ${duration(totalMinutes(chapters))}</span></div>
      <a class="button primary-button" data-resume-link href="${chapters[0].outputFile}"><span data-resume-label>첫 장 읽기 · ${chapters[0].id}</span>${icon('arrow')}</a>
    </header>
    <section class="route-section" id="course-route" aria-labelledby="route-title">
      <div class="section-heading"><div><p class="eyebrow">LEARNING ROUTE</p><h2 id="route-title">한 장씩, 배포의 끝까지</h2></div><span class="route-range">${chapters[0].id} <span aria-hidden="true">→</span> ${chapters.at(-1).id}</span></div>
      ${days.map((day) => {
        const entries = chapters.filter((doc) => doc.day === day);
        return `<section class="route-day" aria-labelledby="day-${day}">
          <div class="day-heading"><h3 id="day-${day}">DAY ${day}</h3><span>${entries.length}개 챕터 · ${duration(totalMinutes(entries))}</span></div>
          <ol class="route-list" start="${entries[0].index + 1}">
          ${entries.map((doc) => `<li class="route-step" data-route-slug="${doc.slug}">
            <a href="${doc.outputFile}"><span class="route-number">${doc.id}</span><span class="route-description"><strong>${escapeHtml(doc.navTitle)}<span class="route-read-label">읽음</span></strong><span>${escapeHtml(doc.summary ?? '')}</span></span><span class="route-duration">${doc.minutes}<small>분</small></span><span class="route-arrow">${icon('arrow')}</span></a>
          </li>`).join('')}
          </ol>
        </section>`;
      }).join('')}
    </section>
    <section class="architecture-section" id="architecture" aria-labelledby="architecture-heading">
      <details class="architecture-details">
        <summary><span><span class="eyebrow">SYSTEM MAP</span><strong id="architecture-heading">실습에서 연결할 자원</strong></span><span class="details-hint">구조 펼치기<span aria-hidden="true">＋</span></span></summary>
        <figure><div class="architecture-scroll" tabindex="0" role="region" aria-label="배포 구조, 가로로 스크롤 가능">${architecture}</div><figcaption>브라우저에서 데이터와 AI 가이드까지의 연결 흐름. VPC·서브넷·NAT는 준비된 공유 네트워크를 사용하며, 참가자가 소유하는 실습 자원과 구분합니다.</figcaption></figure>
      </details>
    </section>
    ${references.length ? `<section class="reference-section" id="references" aria-labelledby="reference-heading"><div class="section-heading"><div><p class="eyebrow">KEEP AT HAND</p><h2 id="reference-heading">실습 옆에 두는 참고 자료</h2></div></div><div class="reference-grid">${references.map((doc) => `<a class="reference-card" href="${doc.outputFile}">${icon('book')}<strong>${escapeHtml(doc.navTitle)}</strong>${icon('arrow')}</a>`).join('')}</div></section>` : ''}
  </div>`;
}

function documentPage(doc, docs) {
  const chapters = docs.filter((entry) => entry.kind === 'chapters');
  const chapter = doc.kind === 'chapters';
  const previous = chapter ? chapters[doc.index - 1] : null;
  const next = chapter ? chapters[doc.index + 1] : null;
  const toc = doc.headings.filter((heading) => heading.depth <= 3);
  const paginationLink = (target, direction) => `<a class="pagination-link ${direction}"${target ? ` rel="${direction}"` : ''} href="${pageHref(doc.outputFile, target?.outputFile ?? 'index.html')}">
    ${direction === 'prev' ? icon('back') : ''}<span><small>${target ? direction === 'prev' ? '이전 장' : '다음 장' : '전체 과정'}</small><strong>${target ? `${target.id} · ${escapeHtml(target.navTitle)}` : chapter && !next ? '읽기 경로 돌아보기' : '워크숍 둘러보기'}</strong></span>${direction === 'next' ? icon('arrow') : ''}
  </a>`;
  return `<div class="article-layout${toc.length ? '' : ' without-toc'}">
    <article class="lesson" aria-labelledby="${doc.titleId}">
      <header class="lesson-header">
        <p class="eyebrow">${chapter ? `<span class="chapter-stamp">${doc.id}</span>DAY ${doc.day}<span class="meta-separator">/</span>${doc.minutes}분 실습` : `${icon('book')}REFERENCE · 참고 자료`}</p>
        <h1 id="${doc.titleId}">${escapeHtml(doc.title)}</h1>
        ${doc.summary ? `<p class="lesson-summary">${escapeHtml(doc.summary)}</p>` : ''}
        ${chapter ? `<div class="lesson-location"><span>${doc.index + 1} / ${chapters.length}번째 챕터</span><span class="lesson-read-state" data-chapter-state>아직 읽지 않음</span></div>` : ''}
      </header>
      <div class="prose">${doc.html}</div>
      ${chapter ? `<section class="reading-check js-only" aria-label="이 장의 읽기 기록">
        <div><p class="eyebrow">READING CHECK</p><h2>이 장을 읽었나요?</h2><p>읽음 표시는 이 브라우저에만 저장됩니다.<br>실제 실습 결과는 터미널에서 확인하세요.</p></div>
        <button class="button primary-button" type="button" data-progress-toggle aria-pressed="false">${icon('check')}<span data-toggle-label>읽음으로 표시</span></button>
      </section>` : ''}
      <nav class="page-pagination" aria-label="${chapter ? '이전 다음 장' : '과정으로 돌아가기'}">
        ${paginationLink(previous, 'prev')}${chapter ? paginationLink(next, 'next') : ''}
      </nav>
    </article>
    ${toc.length ? `<aside class="article-toc" aria-label="이 페이지 목차"><details open data-page-toc><summary id="on-this-page">이 페이지에서${icon('chevron')}</summary><nav aria-labelledby="on-this-page"><ol>${toc.map((heading) => `<li class="toc-depth-${heading.depth}"><a href="#${heading.id}" data-toc-link>${escapeHtml(heading.label)}</a></li>`).join('')}</ol></nav><a class="back-to-top" href="#top">맨 위로 ↑</a></details></aside>` : ''}
  </div>`;
}

function renderPage(course, docs, doc, architecture, hasFontLicense) {
  const currentFile = doc?.outputFile ?? 'index.html';
  const asset = (file) => pageHref(currentFile, `assets/${file}`);
  const title = doc ? `${doc.navTitle} · Jeju Atlas 워크숍` : `${course.title} · Jeju Atlas`;
  const courseKey = createHash('sha256')
    .update(`${course.title}\0${course.chapters.map((chapter) => chapter.slug).join('\0')}`)
    .digest('hex').slice(0, 16);
  return `<!doctype html>
<html lang="${escapeHtml(course.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <meta name="description" content="${escapeHtml(doc?.summary || course.subtitle)}">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${asset('mark.svg')}">
  <script src="${asset('theme.js')}"></script>
  <link rel="stylesheet" href="${asset('reader.css')}">
  <script src="${asset('reader.js')}" defer></script>
</head>
<body id="top" data-course-key="${courseKey}" data-page-kind="${doc?.kind ?? 'overview'}"${doc?.kind === 'chapters' ? ` data-current-chapter="${doc.slug}"` : ''}>
  <a class="skip-link" href="#main-content">본문으로 바로 가기</a>
  ${sidebar(course, docs, currentFile)}
  <button class="nav-backdrop" type="button" data-nav-backdrop aria-label="목차 닫기" tabindex="-1" hidden></button>
  <div class="workspace" data-workspace>
    <header class="topbar">
      <div class="topbar-leading"><button class="toolbar-button mobile-only js-only" type="button" data-nav-toggle aria-controls="course-nav" aria-expanded="false">${icon('menu')}<span>목차</span></button>
        <nav class="breadcrumb" aria-label="현재 위치"><a href="${pageHref(currentFile, 'index.html')}">워크숍</a><span aria-hidden="true">/</span><span>${doc ? doc.kind === 'chapters' ? `CHAPTER ${doc.id}` : '참고 자료' : '전체 과정'}</span></nav>
      </div>
      <div class="toolbar js-only"><button class="toolbar-button" type="button" data-theme-toggle aria-label="어두운 화면으로 전환" aria-pressed="false"><span class="theme-moon">${icon('moon')}</span><span class="theme-sun">${icon('sun')}</span><span data-theme-label>다크</span></button><button class="toolbar-button" type="button" data-print>${icon('print')}<span>인쇄</span></button></div>
    </header>
    <main id="main-content" tabindex="-1">
      <noscript><p class="noscript-note">목차와 본문은 그대로 읽을 수 있습니다. 검색·코드 복사·읽기 기록은 JavaScript를 켜면 사용할 수 있습니다.</p></noscript>
      ${doc ? documentPage(doc, docs) : courseOverview(course, docs, architecture)}
    </main>
    <footer class="site-footer"><span>Jeju Atlas · 배포 워크숍${course.updatedAt ? `<span class="footer-date">${escapeHtml(course.updatedAt.replaceAll('-', '.'))} 기준</span>` : ''}</span>${hasFontLicense ? `<a href="${asset('fonts/OFL-NanumSquare.txt')}">나눔스퀘어 · 글꼴 라이선스</a>` : ''}</footer>
  </div>
  <p class="reader-status" role="status" aria-live="polite" data-reader-status></p>
</body>
</html>
`.split(/(<pre\b[^>]*>[\s\S]*?<\/pre>)/g)
    .map((part) => part.startsWith('<pre') ? part : part.replace(/[ \t]+$/gm, ''))
    .join('');
}

async function loadAssets() {
  const assets = new Map();
  async function collect(directory, prefix = 'assets') {
    await assertNoSymlinks(directory, assetsRoot);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) throw new Error(`Refusing private/hidden workshop asset: ${entry.name}`);
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in workshop assets: ${file}`);
      if (entry.isDirectory()) await collect(file, `${prefix}/${entry.name}`);
      else if (entry.isFile()) assets.set(`${prefix}/${entry.name}`, await readFile(file));
    }
  }
  await collect(assetsRoot);
  for (const name of ['reader.css', 'reader.js', 'theme.js', 'mark.svg', 'architecture.svg']) {
    if (!assets.has(`assets/${name}`)) throw new Error(`Missing workshop reader asset: ${name}`);
  }
  for (const name of fontFiles) {
    const path = join(repositoryRoot, 'public/fonts', name);
    await assertNoSymlinks(path, join(repositoryRoot, 'public'));
    assets.set(`assets/fonts/${name}`, await readFile(path));
  }
  return assets;
}

const unescapeAttribute = (value) => value.replace(/&(?:amp|quot|lt|gt|#39|#x[\da-f]+|#\d+);/gi, (entity) => {
  const named = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#39;': "'" };
  return named[entity] ?? String.fromCodePoint(Number.parseInt(entity.slice(entity[2]?.toLowerCase() === 'x' ? 3 : 2, -1), entity[2]?.toLowerCase() === 'x' ? 16 : 10));
});

function htmlAttributes(html) {
  const attributes = [];
  // Only scan real start tags: href="..." inside an escaped code example is text.
  for (const [tag] of html.matchAll(/<[a-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    for (const [, name, value] of tag.matchAll(/\s(id|href|src|aria-describedby)="([^"]*)"/g)) {
      attributes.push({ name, value: unescapeAttribute(value) });
    }
  }
  return attributes;
}

function validateRenderedSite(pages, assets) {
  const ids = new Map();
  for (const [file, html] of pages) {
    const pageIds = htmlAttributes(html).filter((attribute) => attribute.name === 'id').map((attribute) => attribute.value);
    if (new Set(pageIds).size !== pageIds.length) throw new Error(`Duplicate HTML id in ${file}`);
    ids.set(file, new Set(pageIds));
  }
  for (const [file, html] of pages) {
    for (const { name, value } of htmlAttributes(html)) {
      if (name === 'id') continue;
      if (name === 'aria-describedby') {
        for (const id of value.split(/\s+/)) {
          if (!ids.get(file).has(id)) throw new Error(`Invalid aria-describedby in ${file}: ${id}`);
        }
        continue;
      }
      checkPrivateUrl(value, file);
      if (/^(?:https?:|mailto:)/i.test(value)) continue;
      const { path, fragment } = splitUrl(value);
      const target = path ? posix.normalize(posix.join(posix.dirname(file), decodeUrl(path, file))) : file;
      if (!pages.has(target) && !assets.has(target)) throw new Error(`Invalid generated navigation/asset link in ${file}: ${value}`);
      if (fragment && pages.has(target) && !ids.get(target).has(decodeUrl(fragment.slice(1), file))) {
        throw new Error(`Invalid generated heading link in ${file}: ${value}`);
      }
    }
  }
  for (const [name, contents] of assets) {
    if (!name.endsWith('.css')) continue;
    for (const [, path] of contents.toString().matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(name), path));
      if (!assets.has(target)) throw new Error(`Missing/nonlocal CSS asset in ${name}: ${path}`);
    }
  }
}

function validateOutputPath(outputDir, courseDirectory) {
  const sourceDirectories = [join(courseDirectory, 'chapters'), join(courseDirectory, 'reference'), assetsRoot, join(repositoryRoot, 'public')];
  if (isInside(outputDir, courseDirectory) || sourceDirectories.some((source) =>
    isInside(source, outputDir) || isInside(outputDir, source))) {
    throw new Error('The output directory must not overlap a workshop/source directory.');
  }
}

async function writeSite(outputDir, pages, assets) {
  // Do not adopt or recursively erase an arbitrary --output directory.
  let exists = false;
  try {
    await assertNoSymlinks(outputDir, resolve(outputDir, '/'));
    const info = await lstat(outputDir);
    if (!info.isDirectory()) throw new Error(`Workshop output is not a directory: ${outputDir}`);
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists && (await readdir(outputDir)).length) {
    let marker;
    try {
      await assertNoSymlinks(join(outputDir, outputMarker), outputDir);
      marker = JSON.parse(await readFile(join(outputDir, outputMarker), 'utf8'));
    } catch {
      throw new Error(`Output is not an owned workshop site: ${outputDir}. Choose an empty --output directory.`);
    }
    if (marker.generator !== generator) throw new Error(`Output is not an owned workshop site: ${outputDir}`);
    for (const name of ['chapters', 'reference', 'assets', 'index.html', outputMarker]) {
      await rm(join(outputDir, name), { recursive: true, force: true });
    }
  }
  await mkdir(outputDir, { recursive: true });
  for (const directory of ['chapters', 'reference', 'assets']) await mkdir(join(outputDir, directory), { recursive: true });
  for (const [file, contents] of [...pages, ...assets]) {
    const output = join(outputDir, file);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
  await writeFile(join(outputDir, outputMarker), `${JSON.stringify({ generator, pages: [...pages.keys()] }, null, 2)}\n`);
}

export async function buildSite({
  coursePath = join(workshopRoot, 'course.json'),
  outputDir = join(workshopRoot, 'site'),
} = {}) {
  coursePath = resolve(coursePath);
  outputDir = resolve(outputDir);
  const courseDirectory = dirname(coursePath);
  validateOutputPath(outputDir, courseDirectory);
  await assertNoSymlinks(coursePath, courseDirectory);
  let rawManifest;
  try {
    rawManifest = JSON.parse(await readFile(coursePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read course manifest ${coursePath}: ${error.message}`);
  }
  const course = validateManifest(rawManifest);
  const sourceResults = await Promise.allSettled(course.entries.map(async (entry) => {
    const sourcePath = join(courseDirectory, entry.sourceFile);
    await assertNoSymlinks(sourcePath, courseDirectory);
    let source = await readFile(sourcePath, 'utf8');
    if (!source.trim()) throw new Error(`Empty workshop document: ${entry.sourceFile}`);
    let promptAsset;
    if (course.includePromptCards && entry.kind === 'chapters') {
      const name = `prompts/${entry.slug}.md`;
      const promptPath = join(courseDirectory, name);
      let prompt;
      try {
        await assertNoSymlinks(promptPath, courseDirectory);
        prompt = await readFile(promptPath, 'utf8');
      } catch (error) {
        throw new Error(`Cannot include workshop prompt ${name}: ${error.message}`);
      }
      if (!prompt.trim() || Buffer.byteLength(prompt) > 128 * 1024) {
        throw new Error(`Invalid workshop prompt: ${name}`);
      }
      promptAsset = { name, contents: Buffer.from(prompt, 'utf8') };
      const fence = '`'.repeat(Math.max(3, ...[...prompt.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      source += `\n\n## AI CLI 프롬프트 카드\n\n아래 카드 전체를 복사해 실습 EC2에서 선택한 Codex·Kiro CLI·Claude Code에 전달합니다. `
        + `[Markdown 카드 다운로드](../${name})\n\n${fence}markdown\n${prompt}${prompt.endsWith('\n') ? '' : '\n'}${fence}\n`;
    }
    return { entry, source, sourcePath, promptAsset };
  }));
  const missing = [];
  const errors = [];
  for (const [index, result] of sourceResults.entries()) {
    if (result.status === 'rejected') {
      if (result.reason.code === 'ENOENT') missing.push(course.entries[index].sourceFile);
      else errors.push(result.reason.message);
    }
  }
  if (missing.length || errors.length) {
    throw new Error([
      missing.length ? `Missing workshop documents:\n${missing.map((path) => `  - ${path}`).join('\n')}\nWrite every course.json document before building; no placeholder pages are generated.` : '',
      ...errors,
    ].filter(Boolean).join('\n'));
  }
  const assets = await loadAssets();
  for (const { value } of sourceResults) {
    if (value.promptAsset) assets.set(value.promptAsset.name, value.promptAsset.contents);
  }
  const docs = await Promise.all(sourceResults.map(({ value }) => prepareDocument(value.entry, value.source, value.sourcePath)));
  const bySource = new Map(docs.map((doc) => [doc.sourcePath, doc]));
  const byOutput = new Map(docs.map((doc) => [doc.outputFile, doc]));
  byOutput.set('index.html', {
    outputFile: 'index.html', aliases: new Map(),
    anchors: new Set(['top', 'main-content', 'overview-title', 'course-route', 'route-title', 'architecture', 'architecture-heading', 'references', 'reference-heading',
      ...course.chapters.map((chapter) => `day-${chapter.day}`)]),
  });
  for (const doc of docs) rewriteDocumentLinks(doc, bySource, byOutput, new Set(assets.keys()));
  const architecture = assets.get('assets/architecture.svg').toString('utf8');
  const pages = new Map([['index.html', renderPage(course, docs, null, architecture, true)],
    ...docs.map((doc) => [doc.outputFile, renderPage(course, docs, doc, architecture, true)])]);
  validateRenderedSite(pages, assets);
  await writeSite(outputDir, pages, assets);
  return { outputDir, pages: [...pages.keys()], assets: [...assets.keys()] };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node workshop/scripts/build.mjs [--output DIRECTORY] [--course COURSE_JSON]\nBuild every manifest-listed document. Missing documents and broken links fail the build.');
      return;
    }
    if (!['--output', '--course'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${arg}. Use --help for usage.`);
    }
    options[arg === '--output' ? 'outputDir' : 'coursePath'] = args[++index];
  }
  const result = await buildSite(options);
  console.log(`Built ${result.pages.length} workshop pages with local assets → ${result.outputDir}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Workshop build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
