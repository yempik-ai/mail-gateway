import { describe, expect, it } from 'vitest';
import { createAdminBasicAuthHook } from '../../apps/mcp-server/src/oauth.js';

const ADMIN_SECRET = 'an-admin-secret-longer-than-sixteen';

interface FakeReply {
  statusCode: number | undefined;
  sent: unknown;
  headers: Record<string, string>;
}

function createFakeReply() {
  const reply: FakeReply & Record<string, unknown> = {
    statusCode: undefined,
    sent: undefined,
    headers: {},
  };
  reply.header = (name: string, value: string) => {
    reply.headers[name] = value;
    return reply;
  };
  reply.code = (status: number) => {
    reply.statusCode = status;
    return reply;
  };
  reply.send = (payload: unknown) => {
    reply.sent = payload;
    return Promise.resolve(reply);
  };
  return reply;
}

async function run(authorization?: string): Promise<FakeReply> {
  const hook = createAdminBasicAuthHook(ADMIN_SECRET);
  const reply = createFakeReply();
  const headers = authorization === undefined ? {} : { authorization };
  // The hook only reads request.headers and reply.header/code/send.
  await hook(
    { headers } as unknown as Parameters<typeof hook>[0],
    reply as unknown as Parameters<typeof hook>[1],
  );
  return reply;
}

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

describe('admin Basic authentication hook', () => {
  it('rejects requests without credentials and advertises the challenge', async () => {
    const reply = await run();
    expect(reply.statusCode).toBe(401);
    expect(reply.headers['www-authenticate']).toContain('Basic');
  });

  it('rejects a wrong password', async () => {
    const reply = await run(basicHeader('admin', 'wrong-password-entirely'));
    expect(reply.statusCode).toBe(401);
  });

  it('rejects malformed authorization headers', async () => {
    expect((await run('Bearer token')).statusCode).toBe(401);
    expect((await run('Basic not-base64!!')).statusCode).toBe(401);
  });

  it('accepts the admin secret with any username', async () => {
    const asAdmin = await run(basicHeader('admin', ADMIN_SECRET));
    expect(asAdmin.statusCode).toBeUndefined();
    expect(asAdmin.sent).toBeUndefined();
    const asAnyone = await run(basicHeader('alex', ADMIN_SECRET));
    expect(asAnyone.statusCode).toBeUndefined();
  });

  it('accepts passwords containing colons', async () => {
    const secretWithColon = 'colon:separated:secret';
    const hook = createAdminBasicAuthHook(secretWithColon);
    const reply = createFakeReply();
    await hook(
      {
        headers: { authorization: basicHeader('admin', secretWithColon) },
      } as unknown as Parameters<typeof hook>[0],
      reply as unknown as Parameters<typeof hook>[1],
    );
    expect(reply.statusCode).toBeUndefined();
  });
});
