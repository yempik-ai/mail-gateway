import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FEATURE_FLAG_DEFAULTS, type FeatureFlags } from '../../packages/core/src/index.js';
import type { Database } from '../../packages/database/src/index.js';
import type { AuditWriter } from '../../packages/observability/src/index.js';
import { createMcpServer } from '../../apps/mcp-server/src/tools.js';

const AUTH = {
  mcpClientId: 'test-client',
  correlationId: '8b4d1f92-0c3a-4c1d-9f56-2b7a1c8e4d33',
};

const database = {} as Database;
const audit: AuditWriter = { write: () => Promise.resolve() };
const openConnections: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

async function connect(featureFlags: FeatureFlags, db: Database = database) {
  const server = createMcpServer(db, audit, AUTH, { featureFlags });
  const client = new Client({ name: 'gateway-tool-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return client;
}

async function listTools(featureFlags: FeatureFlags) {
  const client = await connect(featureFlags);
  return (await client.listTools()).tools;
}

afterEach(async () => {
  await Promise.all(
    openConnections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

describe('MCP autonomous delivery tool registration', () => {
  it('exposes send_draft as an idempotent external-write tool by default', async () => {
    const tools = await listTools(FEATURE_FLAG_DEFAULTS);
    const send = tools.find((tool) => tool.name === 'send_draft');

    expect(tools).toHaveLength(16);
    expect(send).toBeDefined();
    expect(send?.inputSchema).toMatchObject({
      type: 'object',
      required: ['internalDraftId'],
    });
    expect(Object.keys(send?.inputSchema.properties ?? {})).toEqual(['internalDraftId']);
    expect(send?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('tells agents to retry entries that ran out of the batch time budget', async () => {
    const tools = await listTools(FEATURE_FLAG_DEFAULTS);
    const create = tools.find((tool) => tool.name === 'create_outreach_drafts');

    expect(create?.description).toContain('BATCH_TIME_BUDGET_EXCEEDED');
    expect(create?.description).toContain('retryable');
    expect(create?.description).toContain('errorMessage');
  });

  it('exposes reconcile_draft_send as the repair path for an uncertain send', async () => {
    const tools = await listTools(FEATURE_FLAG_DEFAULTS);
    const reconcile = tools.find((tool) => tool.name === 'reconcile_draft_send');

    expect(reconcile).toBeDefined();
    expect(reconcile?.inputSchema).toMatchObject({ type: 'object', required: ['internalDraftId'] });
    expect(Object.keys(reconcile?.inputSchema.properties ?? {})).toEqual(['internalDraftId']);
    expect(reconcile?.description).toContain('SEND_STATUS_UNKNOWN');
    expect(reconcile?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('omits both delivery tools when the emergency delivery flag is disabled', async () => {
    const tools = await listTools({ ...FEATURE_FLAG_DEFAULTS, SEND_EMAILS: false });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('send_draft');
    expect(names).not.toContain('reconcile_draft_send');
    expect(tools).toHaveLength(14);
  });
});

describe('get_gateway_health', () => {
  const healthOf = async (options: Parameters<typeof createMcpServer>[3], db: Database) => {
    const server = createMcpServer(db, audit, AUTH, options);
    const client = new Client({ name: 'gateway-tool-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    openConnections.push({ client, server });
    const result = await client.callTool({ name: 'get_gateway_health', arguments: {} });
    const content = result.content as Array<{ text: string }>;
    return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
  };
  const reachable = { execute: () => Promise.resolve({ rows: [] }) } as unknown as Database;
  const unreachable = {
    execute: () => Promise.reject(new Error('connection refused')),
  } as unknown as Database;

  it('reports which provider adapters are wired', async () => {
    const health = await healthOf(
      {
        featureFlags: FEATURE_FLAG_DEFAULTS,
        adapters: { gmail: true, microsoft: false, zoho: true },
      },
      reachable,
    );
    expect(health).toEqual({
      status: 'ok',
      database: 'ok',
      configuration: 'ok',
      adapters: { gmail: true, microsoft: false, zoho: true },
    });
  });

  it('reports no adapter by default and a degraded database', async () => {
    const health = await healthOf({ featureFlags: FEATURE_FLAG_DEFAULTS }, unreachable);
    expect(health).toEqual({
      status: 'degraded',
      database: 'unavailable',
      configuration: 'ok',
      adapters: { gmail: false, microsoft: false, zoho: false },
    });
  });
});

describe('draft body inputs', () => {
  type JsonSchema = {
    properties?: Record<string, { type?: string; description?: string; items?: JsonSchema }>;
    required?: string[];
  };

  async function draftToolSchemas() {
    const tools = await listTools(FEATURE_FLAG_DEFAULTS);
    const schemaOf = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema as JsonSchema | undefined;
    return {
      outreach: schemaOf('create_outreach_drafts'),
      reply: schemaOf('create_reply_draft'),
      update: schemaOf('update_outreach_draft'),
    };
  }

  it('accepts a Markdown body next to textBody and htmlBody on every draft-writing tool', async () => {
    const { outreach, reply, update } = await draftToolSchemas();
    const outreachEntry = outreach?.properties?.drafts?.items;

    for (const schema of [outreachEntry, reply, update]) {
      for (const field of ['body', 'textBody', 'htmlBody']) {
        expect(schema?.properties?.[field]).toMatchObject({ type: 'string' });
        expect(schema?.required ?? []).not.toContain(field);
      }
      expect(schema?.properties?.body?.description).toContain('Markdown');
      expect(schema?.properties?.body?.description).toContain('signature');
      expect(schema?.properties?.textBody?.description).toContain('Prefer `body`');
      expect(schema?.properties?.htmlBody?.description).toContain('Prefer `body`');
    }
  });

  it('exposes includeSignature once per call, at the top level', async () => {
    const { outreach, reply, update } = await draftToolSchemas();

    for (const schema of [outreach, reply, update]) {
      expect(schema?.properties?.includeSignature).toMatchObject({ type: 'boolean' });
      expect(schema?.properties?.includeSignature?.description).toContain('default true');
      expect(schema?.required ?? []).not.toContain('includeSignature');
    }
    expect(outreach?.properties?.drafts?.items?.properties?.includeSignature).toBeUndefined();
  });
});

describe('list_mailboxes delivery readiness', () => {
  const registryRow = (overrides: Record<string, unknown>) => ({
    aliases: [],
    enabled: true,
    connection_status: 'connected',
    daily_send_limit: 25,
    daily_send_limits_by_identity: {},
    messages_sent_by_identity: {},
    remaining_daily_capacity: 25,
    remaining_daily_send_capacity: 25,
    last_successful_read_at: null,
    requires_reconnection: false,
    ...overrides,
  });

  async function callListMailboxes(rows: ReturnType<typeof registryRow>[]) {
    const stub = { execute: () => Promise.resolve({ rows }) } as unknown as Database;
    const client = await connect(FEATURE_FLAG_DEFAULTS, stub);
    const result = await client.callTool({ name: 'list_mailboxes', arguments: {} });
    const [content] = result.content as [{ type: 'text'; text: string }];
    return (JSON.parse(content.text) as { mailboxes: Record<string, unknown>[] }).mailboxes;
  }

  it('marks a mailbox whose grant carries every delivery scope as sendable', async () => {
    const [summary] = await callListMailboxes([
      registryRow({
        id: 'primary-gmail',
        provider: 'gmail',
        email_address: 'hello@example.com',
        granted_scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.compose',
        ],
      }),
    ]);

    expect(summary).toMatchObject({
      mailboxId: 'primary-gmail',
      canSend: true,
      missingScopes: [],
    });
  });

  it('reports a connected mailbox whose grant predates Mail.Send as unable to send', async () => {
    const [summary] = await callListMailboxes([
      registryRow({
        id: 'pinned-outlook',
        provider: 'microsoft',
        email_address: 'hello@it.example.com',
        granted_scopes: ['openid', 'profile', 'email', 'Mail.ReadWrite'],
      }),
    ]);

    expect(summary).toMatchObject({
      mailboxId: 'pinned-outlook',
      status: 'connected',
      requiresReconnection: false,
      canSend: false,
      missingScopes: ['https://graph.microsoft.com/Mail.Send'],
    });
  });

  it('never claims a disconnected mailbox can send', async () => {
    const [summary] = await callListMailboxes([
      registryRow({
        id: 'team-zoho',
        provider: 'zoho',
        email_address: 'hello@zoho.example.com',
        connection_status: 'expired',
        requires_reconnection: true,
        granted_scopes: ['ZohoMail.messages.READ', 'ZohoMail.messages.CREATE'],
      }),
    ]);

    expect(summary).toMatchObject({ canSend: false, missingScopes: [] });
  });
});
