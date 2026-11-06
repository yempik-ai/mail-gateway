export const GATEWAY_ERROR_CODES = [
  'AUTH_REQUIRED',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'MAILBOX_MISMATCH',
  'MAILBOX_DISABLED',
  'MAILBOX_NOT_FOUND',
  'DAILY_LIMIT_REACHED',
  'PER_RUN_LIMIT_REACHED',
  /**
   * Batch time budget exhausted; retry the remaining drafts. A batch stops
   * starting new provider calls once its remaining time could not cover one
   * more, so the serverless function is never killed mid-write.
   */
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
  /**
   * The provider answered with a definitive non-success HTTP response that maps
   * to no more specific code: the requested operation did not happen.
   */
  'PROVIDER_REJECTED',
  'UNSUPPORTED_OPERATION',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export interface GatewayErrorOptions {
  retryable: boolean;
  retryAfterSeconds?: number;
  correlationId: string;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly correlationId: string;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = options.retryable;
    this.correlationId = options.correlationId;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
      correlationId: this.correlationId,
    };
  }
}

export interface GatewayErrorDefinition {
  httpStatus: number;
  retryable: boolean;
}

export const GATEWAY_ERROR_DEFINITIONS: Readonly<Record<GatewayErrorCode, GatewayErrorDefinition>> =
  {
    AUTH_REQUIRED: { httpStatus: 401, retryable: false },
    TOKEN_EXPIRED: { httpStatus: 401, retryable: false },
    TOKEN_REVOKED: { httpStatus: 401, retryable: false },
    MAILBOX_MISMATCH: { httpStatus: 403, retryable: false },
    MAILBOX_DISABLED: { httpStatus: 409, retryable: false },
    MAILBOX_NOT_FOUND: { httpStatus: 404, retryable: false },
    DAILY_LIMIT_REACHED: { httpStatus: 429, retryable: false },
    PER_RUN_LIMIT_REACHED: { httpStatus: 429, retryable: false },
    BATCH_TIME_BUDGET_EXCEEDED: { httpStatus: 503, retryable: true },
    INVALID_RECIPIENT: { httpStatus: 400, retryable: false },
    INVALID_QUERY: { httpStatus: 400, retryable: false },
    DUPLICATE_DRAFT: { httpStatus: 409, retryable: false },
    MESSAGE_NOT_FOUND: { httpStatus: 404, retryable: false },
    THREAD_NOT_FOUND: { httpStatus: 404, retryable: false },
    DRAFT_NOT_FOUND: { httpStatus: 404, retryable: false },
    SEND_STATUS_UNKNOWN: { httpStatus: 409, retryable: false },
    PROVIDER_RATE_LIMIT: { httpStatus: 429, retryable: true },
    PROVIDER_TIMEOUT: { httpStatus: 504, retryable: true },
    PROVIDER_UNAVAILABLE: { httpStatus: 503, retryable: true },
    PROVIDER_REJECTED: { httpStatus: 502, retryable: false },
    UNSUPPORTED_OPERATION: { httpStatus: 400, retryable: false },
    DATABASE_ERROR: { httpStatus: 503, retryable: true },
    INTERNAL_ERROR: { httpStatus: 500, retryable: false },
  };

export function gatewayErrorHttpStatus(code: GatewayErrorCode): number {
  return GATEWAY_ERROR_DEFINITIONS[code].httpStatus;
}

export function gatewayErrorRetryable(code: GatewayErrorCode): boolean {
  return GATEWAY_ERROR_DEFINITIONS[code].retryable;
}
