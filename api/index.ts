import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildServerlessApp } from '@yempik/mcp-server';

let appPromise: ReturnType<typeof buildServerlessApp> | undefined;

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  appPromise ??= buildServerlessApp();
  const app = await appPromise;
  app.server.emit('request', request, response);
}
