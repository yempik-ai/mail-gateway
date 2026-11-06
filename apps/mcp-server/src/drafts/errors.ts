// Gateway error helpers of the draft service: caller mistakes, normalisation of
// unexpected failures, and the timeout every provider call runs under.

import { GatewayError } from '@yempik/core';

export function invalid(message: string, correlationId: string): GatewayError {
  return new GatewayError('INVALID_QUERY', message, { retryable: false, correlationId });
}

export function toGatewayFailure(error: unknown, correlationId: string): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError('INTERNAL_ERROR', 'Unexpected draft failure', {
    retryable: false,
    correlationId,
    cause: error,
  });
}

export async function withProviderTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  mailboxId: string,
  correlationId: string,
): Promise<T> {
  // The provider promise settles even when the timeout wins: absorb its
  // rejection so it never surfaces as an unhandled rejection.
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new GatewayError(
          'PROVIDER_TIMEOUT',
          `Mailbox ${mailboxId} did not answer within ${timeoutMs}ms`,
          { retryable: true, correlationId },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
