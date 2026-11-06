import { describe, expect, it, vi } from 'vitest';
import {
  createErrorReporter,
  reporterFor,
  scrubSentryEvent,
  type ErrorReporter,
} from '../../apps/mcp-server/src/error-reporting.js';
import { buildGatewayHarness, createDatabaseStub } from '../support/gateway-server.js';

describe('error and not-found handling', () => {
  it('logs an unhandled error with its correlation id and answers a generic 500', async () => {
    const { app, logs, reports } = await buildGatewayHarness();
    app.post('/boom', () => {
      throw new Error('database exploded');
    });
    const correlationId = '0b8d3f6e-4b8f-4e44-9a3f-0e7d2c1b5a90';
    const response = await app.inject({
      method: 'POST',
      url: '/boom?code=oauth-code-must-not-leak',
      headers: {
        'x-correlation-id': correlationId,
        authorization: 'Bearer token-must-not-leak',
      },
      payload: { textBody: 'body-must-not-leak' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', correlationId });
    expect(response.body).not.toContain('database exploded');

    const entry = logs().find((line) => line.msg === 'unhandled error');
    expect(entry).toMatchObject({ level: 50, correlationId, route: '/boom' });
    expect(JSON.stringify(entry)).toContain('database exploded');
    const everything = JSON.stringify(logs());
    for (const secret of [
      'oauth-code-must-not-leak',
      'token-must-not-leak',
      'body-must-not-leak',
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]?.correlationId).toBe(correlationId);
  });

  describe('error report delivery', () => {
    /** A reporter whose flush never settles unless released, as a slow Sentry would. */
    function stalledReporter() {
      const state = { captured: 0, flushes: 0, release: () => {} };
      const reporter: ErrorReporter = {
        capture() {
          state.captured += 1;
        },
        flush() {
          state.flushes += 1;
          return new Promise<void>((resolve) => {
            state.release = resolve;
          });
        },
      };
      return { reporter, state };
    }

    async function boom(flushOnError?: boolean) {
      const { reporter, state } = stalledReporter();
      const { app } = await buildGatewayHarness({
        dependencies: {
          errorReporter: reporter,
          ...(flushOnError === undefined ? {} : { flushOnError }),
        },
      });
      app.get('/boom', () => {
        throw new Error('exploded');
      });
      return { response: app.inject({ method: 'GET', url: '/boom' }), state };
    }

    it('captures with Sentry without flushing, and flushes only when asked', () => {
      const calls: string[] = [];
      const scope = { setTag: (key: string, value: string) => calls.push(`tag ${key}=${value}`) };
      const reporter = reporterFor({
        withScope: ((callback: (s: typeof scope) => void) => callback(scope)) as never,
        captureException: () => {
          calls.push('capture');
          return 'event-id';
        },
        flush: (timeout?: number) => {
          calls.push(`flush ${timeout}`);
          return new Promise<boolean>(() => {});
        },
      });

      expect(reporter.capture(new Error('x'), 'corr-1')).toBeUndefined();
      expect(calls).toEqual(['tag correlation_id=corr-1', 'capture']);
      void reporter.flush();
      expect(calls).toContain('flush 2000');
    });

    it('answers a self-hosted 500 without waiting for delivery', async () => {
      const { response, state } = await boom();
      // The flush would never settle: the response only arrives if nobody waits for it.
      expect((await response).statusCode).toBe(500);
      expect(state).toMatchObject({ captured: 1, flushes: 0 });
    });

    it('waits for delivery on the serverless path, whose instance freezes after the response', async () => {
      const { response, state } = await boom(true);
      let answered = false;
      void response.then(() => {
        answered = true;
      });
      await vi.waitFor(() => expect(state.flushes).toBe(1));
      expect(answered).toBe(false);
      state.release();
      expect((await response).statusCode).toBe(500);
      expect(state.captured).toBe(1);
    });
  });

  it("keeps Fastify's client error responses and does not report them", async () => {
    const { app, reports } = await buildGatewayHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      error: 'Bad Request',
    });
    expect(reports).toHaveLength(0);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { app } = await buildGatewayHarness();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('boots without the deprecated disableRequestLogging option (FSTDEP023)', async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error & { code?: string }) => warnings.push(warning.code ?? '');
    process.on('warning', onWarning);
    try {
      await buildGatewayHarness();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).not.toContain('FSTDEP023');
  });
});

describe('health adapter wiring', () => {
  const adapterFactory = () => undefined;

  it('reports each provider wired from its OAuth settings', async () => {
    const { app } = await buildGatewayHarness({
      env: {
        MICROSOFT_TENANT_ID: 'common',
        MICROSOFT_CLIENT_ID: 'ms-client',
        MICROSOFT_CLIENT_SECRET: 'ms-secret',
      },
      dependencies: { adapterFactory },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      database: 'ok',
      configuration: 'ok',
      adapters: { gmail: true, microsoft: true, zoho: false },
    });
  });

  it('reports no provider wired without an adapter factory', async () => {
    const { app } = await buildGatewayHarness();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.json()).toMatchObject({
      adapters: { gmail: false, microsoft: false, zoho: false },
    });
  });

  it('answers 503 with the wiring when the database is unavailable', async () => {
    const { app } = await buildGatewayHarness({
      dependencies: { adapterFactory, database: createDatabaseStub({ failing: true }) },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: 'unavailable',
      adapters: { gmail: true, microsoft: false, zoho: false },
    });
  });
});

describe('Sentry event scrubbing', () => {
  it('drops bodies, cookies, credentials, query strings and user data', () => {
    const event = {
      type: undefined,
      request: {
        url: 'https://mail.example.test/oauth/google/callback?code=secret-code&state=s',
        method: 'GET',
        data: { textBody: 'mail content' },
        query_string: 'code=secret-code',
        cookies: { session: 'cookie-value' },
        env: { REMOTE_ADDR: '203.0.113.1' },
        headers: {
          Authorization: 'Basic c2VjcmV0',
          cookie: 'session=cookie-value',
          'x-mcp-client-secret': 'client-secret',
          'user-agent': 'vitest',
        },
      },
      user: { ip_address: '203.0.113.1' },
      breadcrumbs: [{ message: 'GET https://gmail.googleapis.com/?q=from:someone' }],
    } as Parameters<typeof scrubSentryEvent>[0];

    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.request).toEqual({
      url: 'https://mail.example.test/oauth/google/callback',
      method: 'GET',
      headers: { 'user-agent': 'vitest' },
    });
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toMatch(/secret|cookie-value|mail content|c2VjcmV0/u);
  });

  it('stays disabled, without loading the SDK, when no DSN is configured', async () => {
    await expect(createErrorReporter({ dsn: undefined, environment: 'test' })).resolves.toBe(
      undefined,
    );
  });
});
