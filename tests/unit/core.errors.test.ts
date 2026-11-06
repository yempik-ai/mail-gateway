import { describe, expect, it } from 'vitest';
import {
  GATEWAY_ERROR_CODES,
  GatewayError,
  gatewayErrorHttpStatus,
  gatewayErrorRetryable,
  type GatewayErrorCode,
} from '../../packages/core/src/index.js';

const expectedCodes: GatewayErrorCode[] = [
  'AUTH_REQUIRED',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'MAILBOX_MISMATCH',
  'MAILBOX_DISABLED',
  'MAILBOX_NOT_FOUND',
  'DAILY_LIMIT_REACHED',
  'PER_RUN_LIMIT_REACHED',
  'BATCH_TIME_BUDGET_EXCEEDED',
  'INVALID_RECIPIENT',
  'INVALID_QUERY',
  'DUPLICATE_DRAFT',
  'MESSAGE_NOT_FOUND',
  'THREAD_NOT_FOUND',
  'DRAFT_NOT_FOUND',
  'SEND_STATUS_UNKNOWN',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'UNSUPPORTED_OPERATION',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
];

describe('GatewayError', () => {
  it('defines and maps every normalized error code', () => {
    expect(GATEWAY_ERROR_CODES).toEqual(expectedCodes);
    for (const code of GATEWAY_ERROR_CODES) {
      expect(gatewayErrorHttpStatus(code)).toBeGreaterThanOrEqual(400);
      expect(gatewayErrorHttpStatus(code)).toBeLessThan(600);
    }
    expect(gatewayErrorRetryable('PROVIDER_TIMEOUT')).toBe(true);
    expect(gatewayErrorRetryable('PROVIDER_RATE_LIMIT')).toBe(true);
    expect(gatewayErrorRetryable('AUTH_REQUIRED')).toBe(false);
    expect(gatewayErrorRetryable('MAILBOX_MISMATCH')).toBe(false);
    expect(gatewayErrorRetryable('INVALID_QUERY')).toBe(false);
    expect(gatewayErrorRetryable('PROVIDER_REJECTED')).toBe(false);
    expect(gatewayErrorHttpStatus('PROVIDER_REJECTED')).toBe(502);
    expect(gatewayErrorRetryable('BATCH_TIME_BUDGET_EXCEEDED')).toBe(true);
  });

  it('serializes retry metadata and correlation ID', () => {
    const error = new GatewayError('PROVIDER_RATE_LIMIT', 'Provider is throttling', {
      retryable: true,
      retryAfterSeconds: 15,
      correlationId: '7ecf9897-5624-4f99-9c7d-93f37f62c557',
    });
    expect(error.toJSON()).toEqual({
      code: 'PROVIDER_RATE_LIMIT',
      message: 'Provider is throttling',
      retryable: true,
      retryAfterSeconds: 15,
      correlationId: '7ecf9897-5624-4f99-9c7d-93f37f62c557',
    });
  });
});
