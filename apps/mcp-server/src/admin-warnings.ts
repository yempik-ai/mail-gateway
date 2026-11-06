// Security posture warnings rendered at the top of the admin dashboard.
// Kept apart from the dashboard template so a warning can be added without
// touching its markup.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '@yempik/core';

export const ADMIN_SECRET_MIN_LENGTH = 16;

export const WEAK_ADMIN_SECRET_WARNING =
  'The admin password is shorter than 16 characters: set a longer ADMIN_DASHBOARD_SECRET and redeploy.';

/** Logged once per server; the dashboard shows the same words as a banner. */
export const FORWARDED_FOR_IGNORED_LOG =
  'requests carry X-Forwarded-For but TRUST_PROXY is off: rate limits and the admin login throttle see the proxy address; set TRUST_PROXY';

export const FORWARDED_FOR_IGNORED_WARNING =
  'Requests carry X-Forwarded-For but TRUST_PROXY is off: rate limits and the admin login throttle see the proxy address; set TRUST_PROXY.';

export function isWeakAdminSecret(adminSecret: string): boolean {
  return adminSecret.length < ADMIN_SECRET_MIN_LENGTH;
}

/** False and a hop count of 0 both make the socket peer the client. */
export function isTrustProxyOff(trustProxy: GatewayConfig['TRUST_PROXY'] | undefined): boolean {
  return trustProxy === false || trustProxy === 0;
}

/**
 * Behind a load balancer with TRUST_PROXY off every client shares the
 * balancer's address, so ten wrong guesses lock the operator out too. A
 * forwarded header is the visible symptom. Any client can send one, so it is a
 * hint worth a warning, never a reason to trust the header.
 */
export function forwardedForIgnored(
  request: Pick<FastifyRequest, 'headers'>,
  trustProxy: GatewayConfig['TRUST_PROXY'] | undefined,
): boolean {
  return isTrustProxyOff(trustProxy) && request.headers['x-forwarded-for'] !== undefined;
}

export interface AdminWarningOptions {
  /** The current request carries X-Forwarded-For while TRUST_PROXY is off. */
  forwardedForIgnored?: boolean;
}

const BANNER_STYLE =
  'background:#a11919;color:#fff;font-weight:600;padding:.8rem 1rem;border-radius:.4rem;margin:0 0 1rem';

export function renderAdminWarnings(
  adminSecret: string,
  options: AdminWarningOptions = {},
): string {
  const warnings = [
    ...(isWeakAdminSecret(adminSecret) ? [WEAK_ADMIN_SECRET_WARNING] : []),
    ...(options.forwardedForIgnored ? [FORWARDED_FOR_IGNORED_WARNING] : []),
  ];
  return warnings
    .map(
      (warning) =>
        `<div role="alert" class="security-warning" style="${BANNER_STYLE}">${warning}</div>`,
    )
    .join('');
}

/**
 * Route-level onSend hook for the dashboard page: the warnings reach every
 * HTML rendering of the route without the template having to thread them.
 */
export function createAdminWarningsHook(
  adminSecret: string,
  trustProxy?: GatewayConfig['TRUST_PROXY'],
) {
  return function addAdminWarnings(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> {
    const contentType = String(reply.getHeader('content-type') ?? '');
    if (typeof payload !== 'string' || !contentType.startsWith('text/html')) {
      return Promise.resolve(payload);
    }
    return Promise.resolve(
      withAdminWarnings(payload, adminSecret, {
        forwardedForIgnored: forwardedForIgnored(request, trustProxy),
      }),
    );
  };
}

/** Places the warnings first in the page body, above every dashboard section. */
export function withAdminWarnings(
  html: string,
  adminSecret: string,
  options: AdminWarningOptions = {},
): string {
  const warnings = renderAdminWarnings(adminSecret, options);
  if (!warnings) return html;
  const bodyTag = /<body\b[^>]*>/iu.exec(html);
  if (!bodyTag) return warnings + html;
  const insertAt = bodyTag.index + bodyTag[0].length;
  return html.slice(0, insertAt) + warnings + html.slice(insertAt);
}
