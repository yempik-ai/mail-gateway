// The MCP authorization endpoint asks the operator before issuing a code.
// Browsers resend cached Basic credentials on cross-site navigations, so a GET
// that minted codes would let any page the operator visits connect a client;
// the code is only issued by the consent form's same-origin POST.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, AuditWriter } from '../../packages/observability/src/index.js';
import {
  formActionSourceFor,
  sha256Base64Url,
  type McpOAuthClientRecord,
  type McpOAuthStore,
  type NewMcpOAuthGrant,
} from '../../apps/mcp-server/src/mcp-oauth.js';
import { HTML_CONTENT_SECURITY_POLICY } from '../../apps/mcp-server/src/http-security.js';
import {
  PUBLIC_BASE_URL,
  STRONG_ADMIN_SECRET,
  basicAuthorization,
  buildGatewayHarness,
  type GatewayApp,
} from '../support/gateway-server.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector/oauth/AbC123_def-4567';
const CLIENT: McpOAuthClientRecord = {
  id: 'dcr-consent-test',
  displayName: 'Claude <b>connector</b>',
  secretHash: 'unused',
};

interface StoredGrant extends NewMcpOAuthGrant {
  id: string;
  consumedAt?: Date;
}

function createMemoryStore(clients: McpOAuthClientRecord[] = [CLIENT]) {
  const grants: StoredGrant[] = [];
  const store: McpOAuthStore = {
    findActiveClient: (clientId) =>
      Promise.resolve(clients.find((client) => client.id === clientId)),
    registerClient: (client) => {
      clients.push(client);
      return Promise.resolve();
    },
    insertGrants: (newGrants) => {
      for (const grant of newGrants) grants.push({ ...grant, id: randomBytes(8).toString('hex') });
      return Promise.resolve();
    },
    findUsableGrant: (tokenHash, kind, now) => {
      const grant = grants.find(
        (candidate) =>
          candidate.tokenHash === tokenHash &&
          candidate.kind === kind &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > now,
      );
      return Promise.resolve(
        grant && {
          id: grant.id,
          mcpClientId: grant.mcpClientId,
          codeChallenge: grant.codeChallenge ?? null,
          redirectUri: grant.redirectUri ?? null,
        },
      );
    },
    consumeGrant: (grantId, now) => {
      const grant = grants.find((candidate) => candidate.id === grantId);
      if (!grant || grant.consumedAt !== undefined) return Promise.resolve(false);
      grant.consumedAt = now;
      return Promise.resolve(true);
    },
  };
  return { store, grants };
}

async function buildConsentHarness() {
  const { store, grants } = createMemoryStore();
  const events: AuditEventInput[] = [];
  const audit: AuditWriter = {
    write: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  const { app } = await buildGatewayHarness({ dependencies: { mcpOAuthStore: store, audit } });
  return { app, grants, events };
}

const verifier = randomBytes(32).toString('base64url');

function authorizationParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: CLIENT.id,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: 'S256',
    state: 'state-from-client',
    ...overrides,
  };
}

const getConsent = (app: GatewayApp, params: Record<string, string>) =>
  app.inject({
    method: 'GET',
    url: `/authorize?${new URLSearchParams(params).toString()}`,
    headers: {
      authorization: basicAuthorization(STRONG_ADMIN_SECRET),
      // How the browser arrives from claude.ai: a cross-site navigation.
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    },
  });

const postDecision = (
  app: GatewayApp,
  params: Record<string, string>,
  headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', origin: PUBLIC_BASE_URL },
) =>
  app.inject({
    method: 'POST',
    url: '/authorize',
    headers: {
      authorization: basicAuthorization(STRONG_ADMIN_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    payload: new URLSearchParams(params).toString(),
  });

function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) {
    fields[match[1] ?? ''] = (match[2] ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"');
  }
  return fields;
}

describe('MCP OAuth consent page', () => {
  it('renders the consent page on GET and issues no code', async () => {
    const { app, grants, events } = await buildConsentHarness();
    const response = await getConsent(app, authorizationParams());

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers.location).toBeUndefined();
    expect(grants).toHaveLength(0);
    expect(events).toHaveLength(0);

    const html = response.body;
    expect(html).toContain('Allow Claude &lt;b&gt;connector&lt;/b&gt; to use this gateway?');
    expect(html).not.toContain('<b>connector</b>');
    expect(html).toContain(`<code>${CLIENT.id}</code>`);
    expect(html).toContain('<code>claude.ai</code>');
    expect(html).toContain('<form method="post" action="/authorize">');
    expect(html).toContain('name="decision" value="approve">Approve</button>');
    expect(html).toContain('name="decision" value="deny">Deny</button>');
    expect(html).not.toMatch(/<script/iu);
    expect(hiddenFields(html)).toEqual(authorizationParams());
  });

  it('lets the consent form reach the validated redirect origin and nothing else', async () => {
    const { app } = await buildConsentHarness();
    const claude = await getConsent(app, authorizationParams());
    expect(claude.headers['content-security-policy']).toBe(
      HTML_CONTENT_SECURITY_POLICY.replace(
        "form-action 'self'",
        "form-action 'self' https://claude.ai",
      ),
    );
    expect(claude.headers['x-frame-options']).toBe('DENY');
    expect(claude.headers['cache-control']).toBe('no-store');

    const chatgpt = await getConsent(app, authorizationParams({ redirect_uri: CHATGPT_CALLBACK }));
    expect(chatgpt.statusCode).toBe(200);
    expect(chatgpt.headers['content-security-policy']).toContain(
      "form-action 'self' https://chatgpt.com;",
    );

    // Every other page keeps the strict policy.
    const dashboard = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basicAuthorization(STRONG_ADMIN_SECRET) },
    });
    expect(dashboard.headers['content-security-policy']).toBe(HTML_CONTENT_SECURITY_POLICY);
  });

  it('still validates every parameter on GET', async () => {
    const { app, grants } = await buildConsentHarness();
    for (const [overrides, reason] of [
      [{ response_type: 'token' }, 'response_type must be code'],
      [{ code_challenge_method: 'plain' }, 'code_challenge_method must be S256'],
      [{ redirect_uri: 'https://evil.example/callback' }, 'redirect_uri is not allowlisted'],
      [{ client_id: 'dcr-unknown' }, 'unknown client_id'],
      [{ code_challenge: '' }, 'client_id, redirect_uri, and code_challenge are required'],
    ] as const) {
      const response = await getConsent(app, authorizationParams(overrides));
      expect(response.statusCode, reason).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request', error_description: reason });
    }
    expect(grants).toHaveLength(0);
  });

  it('refuses a cross-site POST before looking at credentials or parameters', async () => {
    const { app, grants, events } = await buildConsentHarness();
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-site', origin: 'https://evil.example' },
      { origin: 'https://evil.example' },
      {},
    ]) {
      const response = await postDecision(
        app,
        { ...authorizationParams(), decision: 'approve' },
        headers,
      );
      expect(response.statusCode, JSON.stringify(headers)).toBe(403);
      expect(response.body).toContain('Cross-site request refused');
    }
    expect(grants).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('requires the admin password on POST', async () => {
    const { app, grants } = await buildConsentHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/authorize',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      payload: new URLSearchParams({ ...authorizationParams(), decision: 'approve' }).toString(),
    });
    expect(response.statusCode).toBe(401);
    expect(grants).toHaveLength(0);
  });

  it('re-validates the hidden fields: a tampered POST is rejected with 400', async () => {
    const { app, grants } = await buildConsentHarness();
    for (const overrides of [
      { redirect_uri: 'https://evil.example/callback' },
      { redirect_uri: 'https://claude.ai.evil.example/api/mcp/auth_callback' },
      { client_id: 'dcr-unknown' },
      { code_challenge_method: 'plain' },
      { response_type: 'token' },
    ]) {
      const response = await postDecision(app, {
        ...authorizationParams(overrides),
        decision: 'approve',
      });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.json()).toMatchObject({ error: 'invalid_request' });
    }
    // A tampered redirect is not used even to report a denial.
    const denied = await postDecision(app, {
      ...authorizationParams({ redirect_uri: 'https://evil.example/callback' }),
      decision: 'deny',
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.headers.location).toBeUndefined();

    const undecided = await postDecision(app, authorizationParams());
    expect(undecided.statusCode).toBe(400);
    expect(undecided.json()).toMatchObject({
      error_description: 'decision must be approve or deny',
    });
    expect(grants).toHaveLength(0);
  });

  it('issues exactly one single-use code on approve and redirects with 303', async () => {
    const { app, grants, events } = await buildConsentHarness();
    const consent = await getConsent(app, authorizationParams());
    const response = await postDecision(app, {
      ...hiddenFields(consent.body),
      decision: 'approve',
    });

    expect(response.statusCode).toBe(303);
    const location = new URL(String(response.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('state')).toBe('state-from-client');
    const code = location.searchParams.get('code') ?? '';
    expect(code).not.toBe('');

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      mcpClientId: CLIENT.id,
      kind: 'code',
      tokenHash: sha256Base64Url(code),
      codeChallenge: sha256Base64Url(verifier),
      redirectUri: CLAUDE_CALLBACK,
    });
    expect(events).toEqual([
      expect.objectContaining({
        mcpClientId: CLIENT.id,
        operation: 'mcp_oauth_authorize',
        result: 'succeeded',
        metadata: { decision: 'approve' },
      }),
    ]);
    // Identifiers only: neither the code, the challenge nor the state is audited.
    expect(JSON.stringify(events)).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain('state-from-client');

    const exchange = () =>
      app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: CLIENT.id,
          redirect_uri: CLAUDE_CALLBACK,
        }).toString(),
      });
    const first = await exchange();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ token_type: 'Bearer' });
    const replay = await exchange();
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('redirects with access_denied and the state on deny, issuing nothing', async () => {
    const { app, grants, events } = await buildConsentHarness();
    const response = await postDecision(app, { ...authorizationParams(), decision: 'deny' });

    expect(response.statusCode).toBe(303);
    const location = new URL(String(response.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-from-client');
    expect(location.searchParams.has('code')).toBe(false);
    expect(grants).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        mcpClientId: CLIENT.id,
        operation: 'mcp_oauth_authorize',
        result: 'denied',
        metadata: { decision: 'deny', reason: 'operator_denied' },
      }),
    ]);
  });
});

describe('consent form-action source', () => {
  it('is the exact origin for http(s) callbacks and the scheme for custom ones', () => {
    expect(formActionSourceFor(CLAUDE_CALLBACK)).toBe('https://claude.ai');
    expect(formActionSourceFor('http://localhost:6274/oauth/callback')).toBe(
      'http://localhost:6274',
    );
    expect(formActionSourceFor('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('cursor:');
    expect(formActionSourceFor('not a url')).toBeUndefined();
  });
});
