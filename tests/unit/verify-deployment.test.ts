import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { buildGatewayHarness, closeAfterTest } from '../support/gateway-server.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/verify-deployment.mjs', import.meta.url));

function runScript(baseUrl: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, baseUrl], (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr });
    });
  });
}

async function listen(app: { listen(options: { host: string; port: number }): Promise<string> }) {
  return app.listen({ host: '127.0.0.1', port: 0 });
}

describe('verify-deployment script', () => {
  it('passes against a correctly configured gateway', async () => {
    const { app } = await buildGatewayHarness();
    const url = await listen(app);

    const result = await runScript(`${url}/`);
    expect(result.output).toContain('All 5 checks passed.');
    expect(result.output).toContain('adapters wired: none');
    expect(result.code).toBe(0);
  });

  it('fails, naming each problem, against a server without the protections', async () => {
    const app = Fastify();
    closeAfterTest(app);
    app.get('/health/live', () => ({ status: 'ok' }));
    app.get('/health/ready', () => ({ status: 'degraded', database: 'unavailable' }));
    app.get('/admin', () => '<html>open</html>');
    const url = await listen(app);

    const result = await runScript(url);
    expect(result.code).toBe(1);
    expect(result.output).toContain('FAIL GET /health/ready answers 200 with the database ok');
    expect(result.output).toContain('database is "unavailable"');
    expect(result.output).toContain('FAIL GET /admin without credentials');
    expect(result.output).toContain('x-frame-options is missing');
    expect(result.output).toContain('5 of 5 checks failed.');
  });

  it('rejects a missing or non-http URL as a usage error', async () => {
    expect((await runScript('')).code).toBe(2);
    expect((await runScript('ftp://example.com')).code).toBe(2);
  });
});
