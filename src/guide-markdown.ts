// Same lazily loaded GFM pipeline as agentcore-cli-main/product/web/frontend/
// src/lib/markdown.ts, with stricter literal-HTML/image and URL policies.
type Render = (markdown: string) => Promise<string>;
type TreeNode = {
  type: string;
  value?: string;
  alt?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
};

let pipeline: Promise<Render> | undefined;

function literalHtmlAndImages() {
  return (tree: TreeNode) => {
    const visit = (node: TreeNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'html') {
          const text: TreeNode = { type: 'text', value: child.value ?? '' };
          return ['root', 'blockquote', 'listItem'].includes(node.type)
            ? [{ type: 'paragraph', children: [text] }] : [text];
        }
        if (child.type === 'image' || child.type === 'imageReference') {
          return [{ type: 'text', value: child.alt ?? '' }];
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

function safeHref(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 3000 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value, 'https://atlas.invalid');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return /^https?:\/\//i.test(value) ? url.href : value;
  } catch { return null; }
}

function hardenLinks() {
  return (tree: TreeNode) => {
    const visit = (node: TreeNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        visit(child);
        if (child.type === 'element' && child.tagName === 'table') {
          return [{
            type: 'element', tagName: 'div',
            properties: { className: ['guide-table-scroll'], tabIndex: 0, role: 'region', ariaLabel: '가이드 표' },
            children: [child],
          }];
        }
        if (child.type === 'element' && child.tagName === 'a') {
          const href = safeHref(child.properties?.href);
          if (!href) return child.children ?? [];
          child.properties = { href, target: '_blank', rel: ['noopener', 'noreferrer'] };
        }
        return [child];
      });
    };
    visit(tree);
  };
}

async function load(): Promise<Render> {
  const [
    { unified }, { default: remarkParse }, { default: remarkGfm },
    { default: remarkRehype }, { default: rehypeSanitize, defaultSchema },
    { default: rehypeStringify },
  ] = await Promise.all([
    import('unified'), import('remark-parse'), import('remark-gfm'),
    import('remark-rehype'), import('rehype-sanitize'), import('rehype-stringify'),
  ]);
  const schema = {
    ...defaultSchema,
    tagNames: defaultSchema.tagNames?.filter((tag) => tag !== 'img'),
    protocols: { ...defaultSchema.protocols, href: ['http', 'https'] },
    attributes: {
      ...defaultSchema.attributes,
      a: [...(defaultSchema.attributes?.a ?? []), ['target', '_blank'], ['rel', 'noopener', 'noreferrer']],
      div: [...(defaultSchema.attributes?.div ?? []), ['className', 'guide-table-scroll'], ['tabIndex', 0], ['role', 'region'], ['ariaLabel', '가이드 표']],
    },
  } as typeof defaultSchema;
  const processor = unified()
    .use(remarkParse).use(remarkGfm).use(literalHtmlAndImages)
    .use(remarkRehype).use(hardenLinks).use(rehypeSanitize, schema).use(rehypeStringify);
  return async (markdown) => String(await processor.process(markdown));
}

/** The caller keeps escaped stream text visible while the pipeline is loading. */
export async function renderGuideMarkdown(markdown: string): Promise<string> {
  pipeline ??= load();
  return (await pipeline)(markdown.slice(0, 30000));
}
