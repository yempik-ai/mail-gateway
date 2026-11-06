import { Writable } from 'node:stream';
import { createLogger } from '../../packages/observability/src/index.js';
import { describe, expect, it } from 'vitest';

describe('security log redaction', () => {
  it('redacts provider credentials and message bodies from structured logs', () => {
    let emitted = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        emitted += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ destination });
    const secrets = {
      refresh_token: 'refresh-value-must-not-leak',
      client_secret: 'client-secret-must-not-leak',
      authorization: 'authorization-must-not-leak',
      textBody: 'plain-body-must-not-leak',
      htmlBody: 'html-body-must-not-leak',
      mimeContent: 'mime-content-must-not-leak',
      signature: 'gmail-signature-must-not-leak',
      signatureHtml: 'signature-html-must-not-leak',
      signatureText: 'signature-text-must-not-leak',
    };

    logger.info({ provider: { ...secrets }, safe: 'visible-marker' });

    for (const value of Object.values(secrets)) expect(emitted).not.toContain(value);
    expect(emitted).toContain('visible-marker');
    expect(emitted.match(/\[Redacted\]/g)).toHaveLength(Object.keys(secrets).length);
  });
});
