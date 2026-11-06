import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const correlationStorage = new AsyncLocalStorage<string>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createCorrelationId(candidate?: string): string {
  return candidate && UUID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export function withCorrelationId<T>(correlationId: string, callback: () => T): T {
  return correlationStorage.run(correlationId, callback);
}

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}
