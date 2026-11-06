// Email body rendering: turns LLM-authored Markdown, plain text or HTML into a
// text part plus an email-safe HTML fragment, and appends signatures and quoted
// originals the way Gmail does, so providers render paragraphs and collapse
// signatures/quotes instead of showing one run-on block. Output HTML is always a
// fragment: adapters wrap it in their own document.

import { compile } from 'html-to-text';
import { Marked } from 'marked';
import { FilterXSS } from 'xss';

export interface EmailBodyInput {
  markdown?: string;
  text?: string;
  html?: string;
}

export interface RenderedEmailBody {
  text: string;
  html: string;
}

export interface EmailSignature {
  html?: string;
  text?: string;
  displayName?: string;
}

export interface QuotedOriginal {
  from?: { name?: string; address: string };
  sentAt?: string;
  textBody?: string;
  htmlBody?: string;
}

export interface QuoteOptions {
  timeZone?: string;
  locale?: string;
}

const PARAGRAPH_STYLE = 'margin:0 0 1em 0';
const QUOTE_STYLE =
  'margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex';
const BLOCK_TAG_PATTERN = /<(?:p|div|br|ul|ol|li|blockquote|table|h[1-4]|hr|pre)\b/iu;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_URL_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);
// A trailing closing bracket is cut only when the URL holds more closers than
// openers: "(see https://x.y/a)" drops the ")", "https://x.y/wiki/Foo_(bar)"
// keeps it.
const URL_BRACKET_PAIRS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

// Values are matched whole; the character classes exclude quotes, semicolons and
// backslashes, and the lookahead blocks url()/expression() so a style cannot load
// remote content or run script in old Outlook/IE engines.
const SAFE_CSS_VALUE = /^(?!.*(?:url|expression)\s*\()[a-z0-9#.,%()\s-]+$/iu;
const LENGTHS = /^(?:-?\d*\.?\d+(?:px|em|ex|rem|pt|%)?\s*){1,4}$/iu;
const FONT_FAMILY = /^[a-z0-9\s,'"-]+$/iu;
const KEYWORD_ALIGN = /^(?:left|right|center|justify|start|end)$/iu;

const ALLOWED_STYLES: Record<string, RegExp[]> = {
  margin: [LENGTHS],
  'margin-top': [LENGTHS],
  'margin-right': [LENGTHS],
  'margin-bottom': [LENGTHS],
  'margin-left': [LENGTHS],
  padding: [LENGTHS],
  'padding-top': [LENGTHS],
  'padding-right': [LENGTHS],
  'padding-bottom': [LENGTHS],
  'padding-left': [LENGTHS],
  color: [SAFE_CSS_VALUE],
  'font-family': [FONT_FAMILY],
  'font-size': [SAFE_CSS_VALUE],
  'border-left': [SAFE_CSS_VALUE],
  'text-align': [KEYWORD_ALIGN],
  'line-height': [SAFE_CSS_VALUE],
};

const STYLED_TAGS = [
  'p',
  'div',
  'span',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'pre',
  'table',
  'td',
  'th',
];

const BASE_TAGS = [
  'p',
  'br',
  'div',
  'span',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'img',
  'pre',
  'code',
];

const VOID_TAGS = new Set(['br', 'hr', 'img']);
const URL_ATTRIBUTES = new Set(['href', 'src']);
const LINK_SCHEMES = ['http', 'https', 'mailto'];
const IMAGE_SCHEMES = ['http', 'https'];

// Head-only and executable containers are dropped with their text, otherwise a
// <title> or <noscript> would leak into the message body as stray words.
const DROPPED_WITH_CONTENT = new Set([
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'title',
  'head',
  'template',
  'iframe',
  'object',
]);
// Browsers read these as raw text up to their first closing tag, so an inner
// "<script>" is text and must not deepen the drop; the others really nest.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'iframe']);

// Opening one of these closes the listed elements while they are innermost, as
// HTML parsers do: "<p>a<div>" or "<li>a<li>b" become siblings, not a nested
// <p> that clients would split around an empty paragraph.
const PARAGRAPH = ['p'];
const OPEN_IMPLIES_CLOSE: ReadonlyMap<string, readonly string[]> = new Map([
  ['tr', ['tr', 'th', 'td']],
  ['th', ['th']],
  ['td', ['thead', 'th', 'td']],
  ['tbody', ['thead', 'tbody']],
  ['li', ['li']],
  ...['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr'].map(
    (tag): [string, readonly string[]] => [tag, PARAGRAPH],
  ),
]);

interface SanitizeProfile {
  /** Every allowed tag with its allowed attributes; any other tag is unwrapped. */
  attributes: Record<string, string[]>;
  /** Allowed class names, for tags whose attributes include `class`. */
  classes?: Readonly<Record<string, readonly string[]>>;
  /** Rewrites an allowed tag's raw attributes before they are filtered. */
  transform?: (tag: string, attributes: Map<string, string>) => void;
}

function baseAttributes(): Record<string, string[]> {
  const attributes: Record<string, string[]> = Object.fromEntries(
    BASE_TAGS.map((tag) => [tag, []]),
  );
  attributes.a = ['href', 'target', 'rel'];
  attributes.img = ['src', 'alt', 'width', 'height'];
  for (const tag of STYLED_TAGS) attributes[tag] = ['style', 'dir'];
  return attributes;
}

const BASE_PROFILE: SanitizeProfile = { attributes: baseAttributes() };

// Signatures and quoted originals come from mail clients (Gmail signatures are
// table layouts with images; replies nest earlier gmail_quote blocks), so they
// keep layout attributes and Gmail's structural classes the body does not need.
function extendedProfile(): SanitizeProfile {
  const attributes = baseAttributes();
  const layout = ['width', 'height', 'align', 'valign', 'bgcolor', 'style'];
  attributes.table = [...layout, 'cellpadding', 'cellspacing', 'border', 'dir'];
  attributes.tr = layout;
  attributes.td = [...layout, 'colspan', 'rowspan', 'dir'];
  attributes.th = [...layout, 'colspan', 'rowspan', 'dir'];
  attributes.img = ['src', 'alt', 'width', 'height', 'style'];
  attributes.div = ['style', 'dir', 'class'];
  attributes.blockquote = ['style', 'dir', 'class'];
  return {
    attributes,
    classes: {
      div: ['gmail_quote', 'gmail_quote_container', 'gmail_attr', 'gmail_signature'],
      blockquote: ['gmail_quote'],
    },
  };
}

const MARKDOWN_PROFILE: SanitizeProfile = {
  attributes: baseAttributes(),
  transform: (tag, attributes) => {
    // Outlook ignores default <p> margins, so paragraph spacing must be inline.
    if (tag === 'p' && !attributes.has('style')) attributes.set('style', PARAGRAPH_STYLE);
    if (tag === 'a') attributes.delete('target');
  },
};

// Named references an attribute check must see through, the scheme-hiding
// colon and whitespace included; numeric references are decoded in full.
const ATTRIBUTE_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['colon', ':'],
  ['Tab', '\t'],
  ['NewLine', '\n'],
]);

function decodeAttribute(value: string): string {
  return value.replace(
    /&#(\d+);?|&#x([0-9a-f]+);?|&([a-z][a-z0-9]*);/giu,
    (entity: string, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) return ATTRIBUTE_ENTITIES.get(name) ?? entity;
      const code = Number.parseInt(decimal ?? hex ?? '', decimal === undefined ? 16 : 10);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : '�';
    },
  );
}

// Text keeps the references it already has, so a second rendering pass does not
// turn "&amp;" into "&amp;amp;"; only a bare "&" is escaped.
function escapeText(text: string): string {
  return text
    .replace(/&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/giu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

// URLs are checked in decoded form, so there every "&" is escaped and the
// client reads back exactly the value that was checked. Other values keep the
// named references the decoder does not know (an &eacute; in alt text) rather
// than showing them literally.
function escapeAttribute(value: string, keepUnknownEntities: boolean): string {
  return value
    .replace(/&(?:([a-z][a-z0-9]*);)?/giu, (match: string, name?: string) =>
      keepUnknownEntities && name !== undefined && !ATTRIBUTE_ENTITIES.has(name)
        ? match
        : `&amp;${match.slice(1)}`,
    )
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function isAllowedUrl(tag: string, url: string): boolean {
  // Clients skip control characters and spaces while reading a URL, so
  // "java\tscript:" is still a javascript: URL: they go before the scheme is read.
  const compact = Array.from(url)
    .filter((char) => char > ' ')
    .join('');
  const scheme = /^([a-z][a-z0-9.+-]*):/iu.exec(compact)?.[1];
  // A protocol-relative URL would take whatever scheme the client renders under.
  if (scheme === undefined) return !/^[/\\]{2}/u.test(compact);
  return (tag === 'img' ? IMAGE_SCHEMES : LINK_SCHEMES).includes(scheme.toLowerCase());
}

// Declarations split on semicolons outside quotes and parentheses, so a quoted
// font name holding ";" is judged whole (and rejected) instead of being cut into
// a valid-looking fragment.
function splitDeclarations(style: string): string[] {
  const declarations: string[] = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;
  for (const char of style) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')' && depth > 0) {
      depth -= 1;
    } else if (char === ';' && depth === 0) {
      declarations.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  declarations.push(current);
  return declarations;
}

const IMPORTANT = /\s*!\s*important\s*$/iu;

/** Allowed declarations whose whole value passes the property's pattern, as "prop:value;prop:value". */
function filterStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of splitDeclarations(style.replace(/\/\*.*?\*\//gsu, ''))) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    const rawValue = declaration.slice(colon + 1);
    const important = IMPORTANT.test(rawValue);
    const value = rawValue.replace(IMPORTANT, '').trim();
    const patterns = Object.hasOwn(ALLOWED_STYLES, property) ? ALLOWED_STYLES[property] : [];
    if (patterns?.some((pattern) => pattern.test(value)) === true) {
      kept.push(`${property}:${value}${important ? ' !important' : ''}`);
    }
  }
  return kept.join(';');
}

/** The cleaned (decoded) attribute value, or undefined to drop the attribute. */
function attributeValue(
  profile: SanitizeProfile,
  tag: string,
  name: string,
  value: string,
): string | undefined {
  // Only alt means something empty: alt="" marks a decorative image.
  if (value === '') return name === 'alt' ? '' : undefined;
  if (URL_ATTRIBUTES.has(name)) return isAllowedUrl(tag, value) ? value : undefined;
  if (name === 'style') return filterStyle(value) || undefined;
  if (name === 'class') {
    const allowed = profile.classes?.[tag] ?? [];
    return (
      value
        .split(/\s+/u)
        .filter((className) => allowed.includes(className))
        .join(' ') || undefined
    );
  }
  return value;
}

// Attribute syntax as browsers read it: a name, then an optional double-quoted,
// single-quoted or unquoted value.
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;

function readAttributes(tag: string, source: string): Map<string, string> {
  // `source` is the tag as written ("<IMG src=x />"); xss has already read the
  // name, so only what follows it is parsed.
  const rest = source.slice(1 + tag.length, source.endsWith('>') ? -1 : undefined);
  const attributes = new Map<string, string>();
  for (const match of rest.matchAll(ATTRIBUTE_PATTERN)) {
    const name = (match[1] ?? '').toLowerCase();
    // As in browsers, the first of a repeated attribute wins.
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** Rebuilds an allowed opening tag from its filtered attributes, HTML5-style (no "/>"). */
function openTag(profile: SanitizeProfile, tag: string, source: string): string {
  const attributes = readAttributes(tag, source);
  profile.transform?.(tag, attributes);
  const allowed = profile.attributes[tag] ?? [];
  let serialized = '';
  let hasSrc = false;
  for (const [name, raw] of attributes) {
    if (!allowed.includes(name)) continue;
    const value = attributeValue(profile, tag, name, decodeAttribute(raw));
    if (value === undefined) continue;
    if (name === 'src') hasSrc = true;
    serialized += ` ${name}="${escapeAttribute(value, !URL_ATTRIBUTES.has(name))}"`;
  }
  // An image whose src was rejected (data:, cid:, javascript:) would render as a
  // broken-image box, so it is removed entirely.
  if (tag === 'img' && !hasSrc) return '';
  return `<${tag}${serialized}>`;
}

interface SanitizeRun {
  /** Allowed elements opened and not yet closed, innermost last. */
  open: string[];
  /** Output ranges [start, end) holding a dropped container and its content. */
  cuts: [number, number][];
  /** The dropped container being skipped, if any. */
  dropping: { tag: string; start: number; depth: number } | undefined;
}

function closeTags(tags: string[]): string {
  return tags
    .reverse()
    .map((tag) => `</${tag}>`)
    .join('');
}

// Built on xss for its tokenizer (quote-aware tag boundaries, comment removal)
// with every allowed tag rebuilt here. xss's own stripIgnoreTagBody is not used:
// it leaves a "[removed]" marker and the container's text in the output when the
// container is unclosed or nested at the start of the input, so dropped
// containers are cut by output position instead. Tags are also balanced (stray
// closes dropped, open ones closed at the end) so a signature or quoted original
// can neither close the wrapper it is embedded in nor swallow what follows it.
function createSanitizer(profile: SanitizeProfile): (html: string) => string {
  let run: SanitizeRun = { open: [], cuts: [], dropping: undefined };

  function onTag(
    tag: string,
    source: string,
    isClosing: boolean,
    isWhite: boolean,
    position: number,
  ): string | undefined {
    const { dropping } = run;
    if (dropping !== undefined) {
      // Everything inside a dropped container goes, allowed tags included; only
      // the container's own tag is counted, so its matching close ends the cut.
      if (tag === dropping.tag && (isClosing || !RAW_TEXT_TAGS.has(tag))) {
        dropping.depth += isClosing ? -1 : 1;
        if (dropping.depth === 0) {
          run.cuts.push([dropping.start, position]);
          run.dropping = undefined;
        }
      }
      return '';
    }
    if (DROPPED_WITH_CONTENT.has(tag)) {
      if (!isClosing) run.dropping = { tag, start: position, depth: 1 };
      return '';
    }
    // Any other unknown tag is unwrapped by stripIgnoreTag: its text stays.
    if (!isWhite) return undefined;
    if (!isClosing) {
      const html = openTag(profile, tag, source);
      if (html === '') return '';
      const implied = OPEN_IMPLIES_CLOSE.get(tag) ?? [];
      let closes = '';
      while (implied.includes(run.open.at(-1) ?? '')) closes += closeTags(run.open.splice(-1));
      if (!VOID_TAGS.has(tag)) run.open.push(tag);
      return closes + html;
    }
    const index = run.open.lastIndexOf(tag);
    // A close without a matching open element is dropped.
    return index === -1 ? '' : closeTags(run.open.splice(index));
  }

  const filter = new FilterXSS({
    whiteList: profile.attributes,
    stripIgnoreTag: true,
    // Styles are validated by filterStyle, which also fixes their serialization.
    css: false,
    escapeHtml: escapeText,
    onTag: (tag, source, { isClosing = false, isWhite = false, position = 0 }) =>
      onTag(tag, source, isClosing, isWhite, position),
  });

  return (html) => {
    const current: SanitizeRun = { open: [], cuts: [], dropping: undefined };
    run = current;
    // A "<" that cannot start a tag is text ("1 < 2"); xss would otherwise read
    // up to the next ">" as a tag and drop it.
    const output = filter.process(html.replace(/<(?![a-z/!?])/giu, '&lt;'));
    if (current.dropping !== undefined) current.cuts.push([current.dropping.start, output.length]);
    let kept = '';
    let from = 0;
    for (const [start, end] of current.cuts) {
      kept += output.slice(from, start);
      from = end;
    }
    return kept + output.slice(from) + closeTags(current.open);
  };
}

const sanitizeBody = createSanitizer(BASE_PROFILE);
const sanitizeMarkdown = createSanitizer(MARKDOWN_PROFILE);
const sanitizeExtended = createSanitizer(extendedProfile());

const markdownParser = new Marked({ gfm: true, breaks: true });

// Email tables are almost always layout (signatures, newsletters), and
// html-to-text renders a non-data table's cells as bare inline content: rows
// ran together ("LinkedIn (url)Example Ltd"). Each row is a line here and cells
// are space separated; the column-padded dataTable output is unreadable once a
// cell holds a nested table or a line break.
const convertHtmlToText = compile({
  wordwrap: false,
  formatters: {
    tableCell(element, walk, builder) {
      walk(element.children, builder);
      builder.addInline(' ');
    },
  },
  selectors: [
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: ['(', ')'] } },
    { selector: 'img', format: 'skip' },
    { selector: 'blockquote', options: { trimEmptyLines: true } },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
    {
      selector: 'table',
      format: 'block',
      options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
    },
    { selector: 'tr', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: 'td', format: 'tableCell' },
    { selector: 'th', format: 'tableCell' },
  ],
});

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** Plain-text rendering of an HTML fragment or document, links as "text (url)". */
export function htmlToText(html: string): string {
  return convertHtmlToText(html)
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Returns the inner HTML of `<body>` for full documents (Graph returns those),
 * dropping head/style/script blocks; fragments are returned unchanged.
 */
export function extractHtmlBodyContent(html: string): string {
  const match = /<body\b[^>]*>(.*?)(?:<\/body\s*>|$)/isu.exec(html);
  if (!match) return html;
  return (match[1] ?? '')
    .replace(/<head\b[^>]*>.*?<\/head\s*>/gisu, '')
    .replace(/<style\b[^>]*>.*?<\/style\s*>/gisu, '')
    .replace(/<script\b[^>]*>.*?<\/script\s*>/gisu, '');
}

function hasContent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function toParagraphs(content: string, renderLine: (line: string) => string): string {
  return content
    .trim()
    .split(/\n[ \t]*\n\s*/u)
    .map((paragraph) => {
      const lines = paragraph.split('\n').map(renderLine).join('<br>');
      return `<p style="${PARAGRAPH_STYLE}">${lines}</p>`;
    })
    .join('');
}

function countOf(value: string, character: string): number {
  return value.split(character).length - 1;
}

/** The usual autolinker rule: sentence punctuation and unbalanced closers are not URL. */
function trimTrailingUrlPunctuation(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const opener = URL_BRACKET_PAIRS[last];
    const strip =
      TRAILING_URL_PUNCTUATION.has(last) ||
      (opener !== undefined && countOf(url, last) > countOf(url, opener));
    if (!strip) return url;
    url = url.slice(0, -1);
  }
}

function linkifyLine(line: string): string {
  let html = '';
  let cursor = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const start = match.index;
    const url = trimTrailingUrlPunctuation(match[0]);
    html += escapeHtml(line.slice(cursor, start));
    html += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    cursor = start + url.length;
  }
  return html + escapeHtml(line.slice(cursor));
}

/** Plain text as an HTML fragment: escaped, trimmed, line breaks as `<br>`. */
export function textToHtml(text: string): string {
  return escapeHtml(normalizeNewlines(text).trim()).replace(/\n/gu, '<br>');
}

function renderHtml(input: string): RenderedEmailBody {
  const sanitized = sanitizeBody(extractHtmlBodyContent(normalizeNewlines(input))).trim();
  // HTML without any block structure is prose with inline markup: its newlines
  // carry the layout, which every HTML renderer would otherwise collapse.
  const html = BLOCK_TAG_PATTERN.test(sanitized)
    ? sanitized
    : sanitizeBody(toParagraphs(sanitized, (line) => line));
  return { text: htmlToText(html), html };
}

function renderMarkdown(input: string): RenderedEmailBody {
  const raw = markdownParser.parse(normalizeNewlines(input), { async: false });
  const html = sanitizeMarkdown(raw).trim();
  return { text: htmlToText(html), html };
}

function renderText(input: string): RenderedEmailBody {
  const text = normalizeNewlines(input);
  return { text, html: toParagraphs(text, linkifyLine) };
}

/** Renders a draft body; precedence is html, then markdown, then text. */
export function renderEmailBody(input: EmailBodyInput): RenderedEmailBody {
  if (hasContent(input.html)) return renderHtml(input.html);
  if (hasContent(input.markdown)) return renderMarkdown(input.markdown);
  if (hasContent(input.text)) return renderText(input.text);
  throw new Error('An email body needs markdown, text or html');
}

/** Appends a signature using the RFC 3676 text separator and Gmail's HTML marker. */
export function appendSignature(
  body: RenderedEmailBody,
  signature: EmailSignature,
): RenderedEmailBody {
  const hasHtml = hasContent(signature.html);
  const hasText = hasContent(signature.text);
  if (!hasHtml && !hasText) return body;

  const signatureText =
    hasText && signature.text !== undefined
      ? normalizeNewlines(signature.text).trim()
      : htmlToText(signature.html ?? '');
  const signatureHtml =
    hasHtml && signature.html !== undefined
      ? sanitizeExtended(extractHtmlBodyContent(signature.html)).trim()
      : textToHtml(signature.text ?? '');

  return {
    text: `${body.text}\n\n-- \n${signatureText}`,
    html: `${body.html}<br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signatureHtml}</div>`,
  };
}

function formatSentAt(sentAt: string | undefined, options: QuoteOptions): string | undefined {
  if (sentAt === undefined) return undefined;
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const locale = options.locale ?? 'en-US';
  const timeZone = options.timeZone ?? 'UTC';
  try {
    const day = new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
    // Recent ICU data separates "AM" with U+202F, which some text clients mangle.
    return `${day} at ${time}`.replace(/[\u202f\u00a0]/gu, ' ');
  } catch {
    // An unknown time zone or locale should not block the draft: drop the date.
    return undefined;
  }
}

function attributionLine(original: QuotedOriginal, options: QuoteOptions): string {
  if (original.from === undefined) return 'Original message:';
  const { name, address } = original.from;
  const sender = hasContent(name) ? `${name.trim()} <${address}>` : address;
  const sentAt = formatSentAt(original.sentAt, options);
  return sentAt === undefined ? `${sender} wrote:` : `On ${sentAt} ${sender} wrote:`;
}

function quoteTextLines(text: string): string {
  return normalizeNewlines(text)
    .replace(/^\n+|\s+$/gu, '')
    .split('\n')
    .map((line) => {
      if (line.startsWith('>')) return `>${line}`;
      // Blank lines get a bare ">" so the quote has no trailing whitespace.
      return line.length === 0 ? '>' : `> ${line}`;
    })
    .join('\n');
}

/** Appends the original message as a Gmail-style quote (attribution plus blockquote). */
export function appendQuotedOriginal(
  body: RenderedEmailBody,
  original: QuotedOriginal,
  options: QuoteOptions = {},
): RenderedEmailBody {
  const hasHtml = hasContent(original.htmlBody);
  const hasText = hasContent(original.textBody);
  if (!hasHtml && !hasText) return body;

  const attribution = attributionLine(original, options);
  const originalText =
    hasText && original.textBody !== undefined
      ? original.textBody
      : htmlToText(extractHtmlBodyContent(original.htmlBody ?? ''));
  const quotedHtml =
    hasHtml && original.htmlBody !== undefined
      ? sanitizeExtended(extractHtmlBodyContent(original.htmlBody)).trim()
      : textToHtml(original.textBody ?? '');

  return {
    text: `${body.text}\n\n${attribution}\n${quoteTextLines(originalText)}`,
    html:
      `${body.html}<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">` +
      `${escapeHtml(attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">${quotedHtml}</blockquote></div>`,
  };
}
