// Browser-facing protections for a gateway whose operator UI authenticates
// with HTTP Basic. Browsers resend cached Basic credentials on every request
// to the origin, including requests a third-party page triggers, so the
// credential alone cannot tell the operator's click from a forged form post.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The dashboard and the OAuth pages are server-rendered with inline styles and
 * plain forms: no script, image, font or frame is ever needed. Forms post to
 * the gateway itself; `extraFormActionSources` exists for the MCP consent
 * page, whose post is answered with a redirect to the client's callback.
 */
export function htmlContentSecurityPolicy(extraFormActionSources: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ["form-action 'self'", ...extraFormActionSources].join(' '),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export const HTML_CONTENT_SECURITY_POLICY = htmlContentSecurityPolicy();

/** `request.url` carries the query string; route matching needs the path. */
function pathOf(request: FastifyRequest): string {
  const queryStart = request.url.indexOf('?');
  return queryStart === -1 ? request.url : request.url.slice(0, queryStart);
}

/** Routes that act with the admin password: dashboard, connect flows, MCP consent. */
export function isAdminSurface(path: string): boolean {
  return (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/authorize' ||
    /^\/oauth\/[^/]+\/start$/u.test(path)
  );
}

/** Dashboard actions and the MCP consent decision (POST /authorize). */
function isStateChangingAdminRequest(request: FastifyRequest): boolean {
  const path = pathOf(request);
  return (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.method !== 'OPTIONS' &&
    (path === '/admin' || path.startsWith('/admin/') || path === '/authorize')
  );
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Same-origin check for a state-changing admin request. Fetch metadata is
 * authoritative when the browser sends it (every current engine does); older
 * browsers fall back to Origin, then Referer, compared with PUBLIC_BASE_URL.
 * A request carrying none of them is refused: the dashboard's own forms always
 * produce one, and a client that strips all three gains nothing by being let in.
 */
export function isSameOriginRequest(request: FastifyRequest, expectedOrigin: string): boolean {
  const fetchSite = headerValue(request, 'sec-fetch-site');
  if (fetchSite !== undefined) return fetchSite === 'same-origin' || fetchSite === 'none';

  const origin = headerValue(request, 'origin');
  if (origin !== undefined) return origin === expectedOrigin;

  const referer = headerValue(request, 'referer');
  return referer !== undefined && originOf(referer) === expectedOrigin;
}

function applyResponseHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const contentType = String(reply.getHeader('content-type') ?? '');
  if (contentType.startsWith('text/html') || isAdminSurface(pathOf(request))) {
    // A route may send a policy of its own (the consent page widens
    // form-action to one validated origin); it never loosens anything else.
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', HTML_CONTENT_SECURITY_POLICY);
    }
    reply.header('x-frame-options', 'DENY');
    // same-origin, not no-referrer: no-referrer makes browsers without
    // Sec-Fetch-Site send `Origin: null` on the dashboard's own form posts,
    // which the CSRF check must refuse. same-origin still sends nothing
    // cross-site, so URLs carrying OAuth codes or mailbox ids never leak.
    reply.header('referrer-policy', 'same-origin');
  }
}

export interface HttpSecurityOptions {
  publicBaseUrl: string;
}

export function registerHttpSecurity(app: FastifyInstance, options: HttpSecurityOptions): void {
  const expectedOrigin = new URL(options.publicBaseUrl).origin;

  app.addHook('onRequest', async (request, reply) => {
    // Set on the raw response: the MCP route hijacks the reply and writes the
    // response itself, which bypasses onSend. A route that sets its own
    // Cache-Control through reply.header still wins at writeHead.
    reply.raw.setHeader('x-content-type-options', 'nosniff');
    reply.raw.setHeader('cache-control', 'no-store');

    if (isStateChangingAdminRequest(request) && !isSameOriginRequest(request, expectedOrigin)) {
      request.log.warn(
        {
          correlationId: request.id,
          method: request.method,
          route: pathOf(request),
          fetchSite: headerValue(request, 'sec-fetch-site'),
          origin: headerValue(request, 'origin'),
        },
        'cross-site admin request refused',
      );
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Cross-site request refused: submit the form from the gateway admin pages.');
    }
    return undefined;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    applyResponseHeaders(request, reply);
    return payload;
  });
}
