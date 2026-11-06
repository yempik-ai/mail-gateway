import { describe, expect, it } from 'vitest';
import { buildMimeMessage, encodeQuotedPrintable } from '../../packages/gmail-adapter/src/index.js';

function expectCrLfOnly(value: string): void {
  expect(value.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/u);
}

/** Reference RFC 2045 decoder: drops soft breaks, then turns =XX back into bytes. */
function decodeQuotedPrintable(value: string): string {
  const unfolded = value.replace(/=\r\n/gu, '');
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    if (unfolded[index] === '=') {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

describe('buildMimeMessage', () => {
  it('builds a plain-text UTF-8 message', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Plain message',
      textBody: 'First line\nSecond line',
    });

    expect(mime).toContain('To: alice@example.com\r\n');
    expect(mime).toContain('Subject: Plain message\r\n');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8\r\n');
    expect(mime).toContain('Content-Transfer-Encoding: quoted-printable\r\n');
    expect(mime).not.toContain('8bit');
    expect(mime.endsWith('\r\n\r\nFirst line\r\nSecond line')).toBe(true);
    expect(mime).not.toContain('multipart/alternative');
  });

  it('builds an HTML-only message', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      cc: ['copy@example.com'],
      subject: 'HTML message',
      htmlBody: '<p>Hello</p>',
    });

    expect(mime).toContain('Cc: copy@example.com\r\n');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8\r\n');
    expect(mime.endsWith('\r\n\r\n<p>Hello</p>')).toBe(true);
    expect(mime).not.toContain('Content-Type: text/plain');
  });

  it('builds multipart alternative content when both bodies are present', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Two formats',
      textBody: 'Plain version',
      htmlBody: '<p>HTML version</p>',
    });
    const boundary = /boundary="([^"]+)"/u.exec(mime)?.[1];

    expect(boundary).toBeTruthy();
    expect(mime).toContain(
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n` +
        'Content-Transfer-Encoding: quoted-printable\r\n',
    );
    expect(mime).toContain(
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n` +
        'Content-Transfer-Encoding: quoted-printable\r\n',
    );
    expect(mime.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('pairs From with a quoted ASCII display name, escaping quotes and backslashes', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      from: 'alex@example.com',
      fromDisplayName: 'Alex "Raf" Morgan, C\\O',
      subject: 'Hello',
      textBody: 'Hi',
    });

    expect(mime).toContain('From: "Alex \\"Raf\\" Morgan, C\\\\O" <alex@example.com>\r\n');
  });

  it('RFC 2047-encodes a non-ASCII display name outside quotes', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      from: 'nicolo@example.com',
      fromDisplayName: 'Nicolò Rossi',
      subject: 'Hello',
      textBody: 'Hi',
    });
    const encoded = Buffer.from('Nicolò Rossi', 'utf8').toString('base64');

    expect(mime).toContain(`From: =?UTF-8?B?${encoded}?= <nicolo@example.com>\r\n`);
  });

  it('keeps a bare From address without a display name and ignores a name without From', () => {
    const bare = buildMimeMessage({
      to: ['alice@example.com'],
      from: 'alex@example.com',
      fromDisplayName: '  ',
      subject: 'Hello',
      textBody: 'Hi',
    });
    const nameOnly = buildMimeMessage({
      to: ['alice@example.com'],
      fromDisplayName: 'Alex',
      subject: 'Hello',
      textBody: 'Hi',
    });

    expect(bare).toContain('From: alex@example.com\r\n');
    expect(nameOnly).not.toContain('From:');
  });

  it('collapses line breaks in a display name so it cannot inject headers', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      from: 'alex@example.com',
      fromDisplayName: 'Alex\r\nBcc: victim@example.com',
      subject: 'Hello',
      textBody: 'Hi',
    });

    expect(mime).toContain('From: "Alex Bcc: victim@example.com" <alex@example.com>\r\n');
    expect(mime).not.toMatch(/^Bcc:/mu);
  });

  it('RFC 2047-encodes a non-ASCII subject', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Caffè ☕',
      textBody: 'Hello',
    });
    const encoded = Buffer.from('Caffè ☕', 'utf8').toString('base64');

    expect(mime).toContain(`Subject: =?UTF-8?B?${encoded}?=\r\n`);
  });

  it('includes reply threading headers', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Re: Conversation',
      textBody: 'Reply',
      replyTo: 'answers@example.com',
      inReplyTo: '<source@example.com>',
      references: ['<first@example.com>', '<source@example.com>'],
    });

    expect(mime).toContain('Reply-To: answers@example.com\r\n');
    expect(mime).toContain('In-Reply-To: <source@example.com>\r\n');
    expect(mime).toContain('References: <first@example.com> <source@example.com>\r\n');
  });

  it('uses CRLF exclusively and contains no prohibited provider operation name', () => {
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Line endings',
      textBody: 'one\ntwo\rthree\r\nfour',
      htmlBody: '<p>one</p>\n<p>two</p>',
    });
    const prohibited = [
      ['users', 'messages', 'send'].join('.'),
      ['users', 'drafts', 'send'].join('.'),
    ];

    expectCrLfOnly(mime);
    for (const operation of prohibited) expect(mime).not.toContain(operation);
  });

  it('quoted-printable encodes both parts so they decode back to the original bodies', () => {
    const textBody = `Café = good ☕\n\n${'A long paragraph written on one single line. '.repeat(40)}\nline end  `;
    const htmlBody = `<p style="margin:0 0 1em 0">${'Crème brûlée, voilà, '.repeat(120)}</p>`;
    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'QP',
      textBody,
      htmlBody,
    });
    const boundary = /boundary="([^"]+)"/u.exec(mime)?.[1] ?? '';
    const parts = mime
      .split(`--${boundary}`)
      .slice(1, 3)
      .map((part) => part.slice(part.indexOf('\r\n\r\n') + 4, -2));

    expect(parts.map(decodeQuotedPrintable)).toEqual([textBody.replaceAll('\n', '\r\n'), htmlBody]);
    const bodyLines = mime.slice(mime.indexOf('\r\n\r\n') + 4).split('\r\n');
    for (const line of bodyLines) {
      expect(line.length).toBeLessThanOrEqual(76);
      expect(line).toMatch(/^[\x20-\x7e]*$/u);
      expect(line).not.toMatch(/[ \t]$/u);
    }
  });
});

describe('encodeQuotedPrintable', () => {
  it('escapes "=", non-ASCII bytes and line-final whitespace and keeps CRLF', () => {
    expect(encodeQuotedPrintable('a=b è\r\ntrailing \nok\ttab\t')).toBe(
      'a=3Db =C3=A8\r\ntrailing=20\r\nok\ttab=09',
    );
  });

  it('inserts soft line breaks at 76 characters without splitting an escape', () => {
    const encoded = encodeQuotedPrintable(`${'x'.repeat(74)}è${'y'.repeat(10)}`);
    const lines = encoded.split('\r\n');

    expect(lines[0]).toBe(`${'x'.repeat(74)}=`);
    expect(lines[1]).toBe(`=C3=A8${'y'.repeat(10)}`);
    expect(decodeQuotedPrintable(encoded)).toBe(`${'x'.repeat(74)}è${'y'.repeat(10)}`);
  });
});
