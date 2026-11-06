import { describe, expect, it } from 'vitest';
import {
  appendQuotedOriginal,
  appendSignature,
  escapeHtml,
  extractHtmlBodyContent,
  htmlToText,
  renderEmailBody,
  textToHtml,
} from '../../packages/core/src/index.js';
import type { RenderedEmailBody } from '../../packages/core/src/index.js';

const P = '<p style="margin:0 0 1em 0">';
const BODY: RenderedEmailBody = { text: 'Hi Mario', html: `${P}Hi Mario</p>` };

describe('renderEmailBody', () => {
  it('rejects a body with no content', () => {
    expect(() => renderEmailBody({})).toThrow('An email body needs markdown, text or html');
    expect(() => renderEmailBody({ markdown: '  ', text: '', html: '\n' })).toThrow(
      'An email body needs markdown, text or html',
    );
  });

  it('prefers html over markdown over text', () => {
    expect(renderEmailBody({ html: '<p>h</p>', markdown: 'm', text: 't' }).html).toBe('<p>h</p>');
    expect(renderEmailBody({ markdown: '**m**', text: 't' }).html).toBe(
      `${P}<strong>m</strong></p>`,
    );
    expect(renderEmailBody({ html: '', text: 't' }).text).toBe('t');
  });

  describe('markdown', () => {
    const rendered = renderEmailBody({
      markdown:
        'Hi Mario,\n\nthanks **a lot** for the call.\nHere is the [deck](https://example.com/deck).\n\n- one\n- two\n\n1. first',
    });

    it('turns blank lines into styled paragraphs and single newlines into <br>', () => {
      expect(rendered.html).toContain(`${P}Hi Mario,</p>`);
      expect(rendered.html).toContain(
        `${P}thanks <strong>a lot</strong> for the call.<br>Here is the <a href="https://example.com/deck">deck</a>.</p>`,
      );
    });

    it('renders lists', () => {
      expect(rendered.html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/u);
      expect(rendered.html).toMatch(/<ol>\s*<li>first<\/li>\s*<\/ol>/u);
    });

    it('derives a text part with links as "text (url)" and no wrapping', () => {
      expect(rendered.text).toBe(
        'Hi Mario,\n\nthanks a lot for the call.\nHere is the deck (https://example.com/deck).\n\n * one\n * two\n\n 1. first',
      );
      const long = renderEmailBody({ markdown: 'word '.repeat(60).trim() });
      expect(long.text).not.toContain('\n');
    });

    it('drops target from links and keeps the href as given', () => {
      const html = renderEmailBody({
        markdown: 'See <a href="https://a.example/x?y=1" target="_blank">this</a>',
      }).html;
      expect(html).toContain('<a href="https://a.example/x?y=1">this</a>');
      expect(html).not.toContain('target');
    });

    it('normalizes CRLF input', () => {
      expect(renderEmailBody({ markdown: 'a\r\nb\r\n\r\nc' }).html).toBe(
        `${P}a<br>b</p>\n${P}c</p>`,
      );
    });
  });

  describe('html', () => {
    it('adds paragraphs to html without block tags', () => {
      const rendered = renderEmailBody({
        html: 'Hi <b>Mario</b>,\n\nline one\nline two <a href="https://a.example">site</a>\n',
      });
      expect(rendered.html).toBe(
        `${P}Hi <b>Mario</b>,</p>${P}line one<br>line two <a href="https://a.example">site</a></p>`,
      );
      expect(rendered.text).toBe('Hi Mario,\n\nline one\nline two site (https://a.example)');
    });

    it('leaves html with block tags untouched apart from sanitization', () => {
      const html =
        '<div dir="ltr">Hi\nthere</div><p style="text-align:center">x</p><ul><li>one</li></ul>';
      expect(renderEmailBody({ html }).html).toBe(html);
    });

    it('strips scripts, event handlers, javascript: URLs and disallowed styles', () => {
      const html = renderEmailBody({
        html:
          '<p onclick="steal()" style="color:red;background:url(https://evil/x)">Hi</p>' +
          '<script>alert(1)</script><a href="javascript:alert(1)">x</a>' +
          '<img src="data:image/png;base64,AAAA"><iframe src="https://evil">frame</iframe>' +
          '<a href="mailto:a@b.it" target="_blank">mail</a>',
      }).html;
      expect(html).toBe(
        '<p style="color:red">Hi</p><a>x</a><a href="mailto:a@b.it" target="_blank">mail</a>',
      );
    });

    it('unwraps full documents to their body content', () => {
      const rendered = renderEmailBody({
        html: '<html><head><title>Subject</title><style>p{color:red}</style></head><body><p>Body</p></body></html>',
      });
      expect(rendered.html).toBe('<p>Body</p>');
      expect(rendered.text).toBe('Body');
    });

    it('is idempotent on already-normalized html', () => {
      const first = renderEmailBody({ html: 'one\ntwo\n\nthree <i>x</i>' }).html;
      expect(renderEmailBody({ html: first }).html).toBe(first);
      const md = renderEmailBody({ markdown: 'a\nb\n\n**c**' }).html;
      expect(renderEmailBody({ html: md }).html).toBe(md);
    });
  });

  describe('text', () => {
    it('keeps the text as given and escapes plus autolinks the html', () => {
      const rendered = renderEmailBody({
        text: 'Hi <Mario> & co,\r\n\r\nsee https://x.example/a?b=1&c=2. ok\nbye (https://y.example)',
      });
      expect(rendered.text).toBe(
        'Hi <Mario> & co,\n\nsee https://x.example/a?b=1&c=2. ok\nbye (https://y.example)',
      );
      expect(rendered.html).toBe(
        `${P}Hi &lt;Mario&gt; &amp; co,</p>` +
          `${P}see <a href="https://x.example/a?b=1&amp;c=2">https://x.example/a?b=1&amp;c=2</a>. ok<br>` +
          'bye (<a href="https://y.example">https://y.example</a>)</p>',
      );
    });

    it('keeps a balanced closing bracket in an autolinked URL', () => {
      const rendered = renderEmailBody({
        text: 'See https://en.wikipedia.org/wiki/Foo_(bar) and https://x.example/a[1]!',
      });
      expect(rendered.html).toBe(
        `${P}See <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>` +
          ' and <a href="https://x.example/a[1]">https://x.example/a[1]</a>!</p>',
      );
    });

    it('strips an unbalanced closing bracket and the punctuation around it', () => {
      const rendered = renderEmailBody({
        text: '(see https://en.wikipedia.org/wiki/Foo_(bar)). [https://y.example/b], ok',
      });
      expect(rendered.html).toBe(
        `${P}(see <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>).` +
          ' [<a href="https://y.example/b">https://y.example/b</a>], ok</p>',
      );
    });
  });

  it('never wraps output in html, head or body elements', () => {
    const inputs = [
      { markdown: '<html><body>hi</body></html>' },
      { html: '<!doctype html><html><head><title>t</title></head><body>hi</body></html>' },
      { html: '<html><body><p>hi</p>' },
      { text: '<html><body>hi</body></html>' },
    ];
    for (const input of inputs) {
      const { html } = renderEmailBody(input);
      expect(html).not.toMatch(/<html|<head|<body/iu);
    }
  });
});

describe('htmlToText', () => {
  it('renders links as "text (url)" unless the text is the url', () => {
    expect(
      htmlToText(
        '<p>See <a href="https://a.example">site</a> or <a href="https://a.example">https://a.example</a></p>',
      ),
    ).toBe('See site (https://a.example) or https://a.example');
  });

  it('prefixes blockquote lines, skips images and collapses blank lines', () => {
    expect(
      htmlToText(
        '<p>Intro</p><br><br><br><blockquote>l1<br>l2</blockquote><img src="https://x/y.png" alt="logo">',
      ),
    ).toBe('Intro\n\n> l1\n> l2');
  });

  // Regression: a production signature's text part read
  // "LinkedIn (https://…)Example Ltd · Company no…" because rows were joined.
  it('puts each table row of a signature on its own line', () => {
    expect(
      htmlToText(
        '<table cellpadding="0"><tbody>' +
          '<tr><td><a href="https://www.linkedin.com/company/example">LinkedIn</a></td></tr>' +
          '<tr><td>Example Ltd · Company no 12345678</td></tr>' +
          '</tbody></table>',
      ),
    ).toBe(
      'LinkedIn (https://www.linkedin.com/company/example)\nExample Ltd · Company no 12345678',
    );
  });

  it('separates the cells of a row and keeps nested tables row by row', () => {
    expect(
      htmlToText(
        '<p>Totals</p><table><tr><th>Item</th><th>Qty</th></tr><tr><td>Apples</td><td>3</td></tr>' +
          '<tr><td><table><tr><td>N1</td></tr><tr><td>N2</td></tr></table></td></tr></table><p>Bye</p>',
      ),
    ).toBe('Totals\n\nItem Qty\nApples 3\nN1\nN2\n\nBye');
  });
});

describe('extractHtmlBodyContent', () => {
  it('returns the body of a Graph-style document', () => {
    const graph =
      '<html>\r\n<head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
      '<style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style>\r\n</head>\r\n' +
      '<BODY dir="ltr"><style>.x{}</style><div class="elementToProof">Hello<script>x()</script></div></BODY>\r\n</html>';
    expect(extractHtmlBodyContent(graph)).toBe('<div class="elementToProof">Hello</div>');
  });

  it('returns fragments unchanged', () => {
    expect(extractHtmlBodyContent('<p>hi</p><style>x</style>')).toBe('<p>hi</p><style>x</style>');
  });
});

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('textToHtml', () => {
  it('escapes plain text and turns every line ending into a line break', () => {
    expect(textToHtml('\nA <b>\r\nB & C\rD\n\n')).toBe('A &lt;b&gt;<br>B &amp; C<br>D');
  });
});

describe('appendSignature', () => {
  it('returns the body unchanged without signature content', () => {
    expect(appendSignature(BODY, {})).toBe(BODY);
    expect(appendSignature(BODY, { displayName: 'Alex', text: ' ' })).toBe(BODY);
  });

  it('uses the RFC 3676 separator and Gmail signature marker for html signatures', () => {
    const signed = appendSignature(BODY, {
      html:
        '<table cellpadding="0"><tr><td><img src="https://cdn.example/logo.png" width="40" onerror="x()"></td>' +
        '<td><b>Alex Morgan</b><br>CEO, <a href="https://example.com">Example</a></td></tr></table>',
    });
    expect(signed.text).toBe('Hi Mario\n\n-- \nAlex Morgan\nCEO, Example (https://example.com)');
    expect(signed.html).toBe(
      `${BODY.html}<br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">` +
        '<table cellpadding="0"><tr><td><img src="https://cdn.example/logo.png" width="40"></td>' +
        '<td><b>Alex Morgan</b><br>CEO, <a href="https://example.com">Example</a></td></tr></table></div>',
    );
  });

  it('escapes text-only signatures', () => {
    const signed = appendSignature(BODY, { text: 'Alex\nR&D <Example>' });
    expect(signed.text).toBe('Hi Mario\n\n-- \nAlex\nR&D <Example>');
    expect(signed.html).toContain('class="gmail_signature"');
    expect(signed.html).toMatch(/>Alex<br>R&amp;D &lt;Example&gt;<\/div>$/u);
  });
});

describe('appendQuotedOriginal', () => {
  const from = { name: 'Alex Morgan', address: 'alex@example.com' };

  it('returns the body unchanged without original content', () => {
    expect(appendQuotedOriginal(BODY, { from })).toBe(BODY);
  });

  it('writes a dated Gmail-style attribution and prefixes quoted text lines', () => {
    const quoted = appendQuotedOriginal(BODY, {
      from,
      sentAt: '2026-11-02T10:15:00Z',
      textBody: 'Hello\r\n\r\n> earlier\nbye\n',
    });
    expect(quoted.text).toBe(
      'Hi Mario\n\nOn Mon, Nov 2, 2026 at 10:15 AM Alex Morgan <alex@example.com> wrote:\n' +
        '> Hello\n>\n>> earlier\n> bye',
    );
    expect(quoted.html).toBe(
      `${BODY.html}<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">` +
        'On Mon, Nov 2, 2026 at 10:15 AM Alex Morgan &lt;alex@example.com&gt; wrote:<br></div>' +
        '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
        'Hello<br><br>&gt; earlier<br>bye</blockquote></div>',
    );
  });

  it('honours time zone and omits a missing or invalid date', () => {
    const rome = appendQuotedOriginal(
      BODY,
      { from, sentAt: '2026-11-02T10:15:00Z', textBody: 'x' },
      { timeZone: 'Europe/Rome' },
    );
    expect(rome.text).toContain('On Mon, Nov 2, 2026 at 11:15 AM Alex Morgan');
    for (const sentAt of [undefined, 'not a date']) {
      const quoted = appendQuotedOriginal(BODY, {
        from,
        ...(sentAt === undefined ? {} : { sentAt }),
        textBody: 'x',
      });
      expect(quoted.text).toBe('Hi Mario\n\nAlex Morgan <alex@example.com> wrote:\n> x');
    }
    expect(appendQuotedOriginal(BODY, { textBody: 'x' }).text).toBe(
      'Hi Mario\n\nOriginal message:\n> x',
    );
  });

  it('quotes html originals, keeping nested Gmail quotes and dropping the document shell', () => {
    const quoted = appendQuotedOriginal(BODY, {
      from,
      sentAt: '2026-11-02T10:15:00Z',
      htmlBody:
        '<html><head><title>T</title></head><body><div dir="ltr">Hello<br>world<img src="https://x.example/a.png"></div>' +
        '<div class="gmail_quote evil"><blockquote class="gmail_quote" onclick="x()">old</blockquote></div></body></html>',
    });
    expect(quoted.html).toContain(
      'padding-left:1ex"><div dir="ltr">Hello<br>world<img src="https://x.example/a.png"></div>' +
        '<div class="gmail_quote"><blockquote class="gmail_quote">old</blockquote></div></blockquote></div>',
    );
    expect(quoted.html).not.toMatch(/<html|<head|<body|<title/iu);
    expect(quoted.text).toBe(
      'Hi Mario\n\nOn Mon, Nov 2, 2026 at 10:15 AM Alex Morgan <alex@example.com> wrote:\n' +
        '> Hello\n> world\n>\n>> old',
    );
  });
});
