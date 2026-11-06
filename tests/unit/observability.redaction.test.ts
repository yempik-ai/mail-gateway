import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../packages/observability/src/index.js';

describe('log redaction', () => {
  it('never serializes tokens, secrets, bodies, MIME, cookies, or attachments', () => {
    let output = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ destination });
    logger.info({
      accessToken: 'fake-token-value',
      nested: { clientSecret: 'fake-secret-value', body: 'fake-body-value' },
      mimeContent: 'fake-mime-value',
      cookie: 'fake-cookie-value',
      attachments: ['fake-attachment-value'],
      safe: 'visible-value',
    });

    for (const forbidden of [
      'fake-token-value',
      'fake-secret-value',
      'fake-body-value',
      'fake-mime-value',
      'fake-cookie-value',
      'fake-attachment-value',
    ]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('visible-value');
    expect(output).toContain('[Redacted]');
  });
});
