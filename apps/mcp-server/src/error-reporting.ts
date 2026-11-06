// Optional Sentry reporting for unhandled errors. The gateway handles mailbox
// content and OAuth secrets, so the SDK runs with every automatic collection
// switched off: it sees only the exception, its stack and the correlation id.

import type * as SentryModule from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

export interface ErrorReporter {
  /** Queues the report and returns at once; the SDK delivers it in the background. */
  capture(error: unknown, correlationId: string): void;
  /**
   * Waits (bounded) until queued reports are delivered. Only a serverless
   * instance needs it: it freezes after the response, background delivery
   * included. A long-lived process delivers on its own.
   */
  flush(): Promise<void>;
}

const FLUSH_TIMEOUT_MS = 2_000;
const SENSITIVE_HEADER =
  /^(?:authorization|cookie|set-cookie|x-mcp-client-secret|proxy-authorization)$/iu;

/**
 * Last line of defence before an event leaves the process: no request body,
 * cookies, credentials or query string (OAuth callbacks carry codes there),
 * whatever an integration or a future code path attached.
 */
export function scrubSentryEvent<T extends ErrorEvent>(event: T): T {
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    delete request.env;
    if (request.url !== undefined) request.url = request.url.split('?')[0] ?? '';
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) => !SENSITIVE_HEADER.test(name)),
      );
    }
  }
  delete event.user;
  delete event.breadcrumbs;
  return event;
}

export interface ErrorReporterOptions {
  dsn: string | undefined;
  environment: string;
}

/**
 * Loads `@sentry/node` only when a DSN is configured, so deployments without
 * Sentry never pay its import cost on a cold start.
 */
export async function createErrorReporter(
  options: ErrorReporterOptions,
): Promise<ErrorReporter | undefined> {
  if (!options.dsn) return undefined;
  const Sentry = await import('@sentry/node');
  // One client per process: a second app built in the same process (tests,
  // the boot smoke) shares it instead of leaking a competing client.
  if (Sentry.isInitialized()) return reporterFor(Sentry);
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    // Default integrations instrument HTTP, the console and the database, and
    // would attach request bodies and MCP tool payloads (mailbox content).
    // Errors are captured explicitly from the Fastify error handler instead.
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration()],
    enableRuntimeChannelInjection: false,
    // SDK 11 replaced `sendDefaultPii` with per-category switches; all off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
    },
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubSentryEvent(event),
  });
  return reporterFor(Sentry);
}

/** The reporter over an initialised SDK; exported so tests can pass a fake one. */
export function reporterFor(
  Sentry: Pick<typeof SentryModule, 'withScope' | 'captureException' | 'flush'>,
): ErrorReporter {
  return {
    capture(error, correlationId) {
      Sentry.withScope((scope) => {
        scope.setTag('correlation_id', correlationId);
        Sentry.captureException(error);
      });
    },
    async flush() {
      await Sentry.flush(FLUSH_TIMEOUT_MS);
    },
  };
}
