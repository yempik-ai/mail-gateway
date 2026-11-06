import { auditEvents, type Database } from '@yempik/database';

export interface AuditEventInput {
  mcpClientId?: string;
  tool?: string;
  correlationId: string;
  occurredAt?: Date;
  mailboxId?: string;
  campaignId?: string;
  prospectId?: string;
  resourceId?: string;
  operation: string;
  result: string;
  errorCode?: string;
  retryCount?: number;
  idempotencyKey?: string;
  providerLatencyMs?: number;
  metadata?: Record<string, unknown>;
}

export interface AuditWriter {
  write(event: AuditEventInput): Promise<void>;
}

export function createAuditWriter(database: Database): AuditWriter {
  return {
    async write(event) {
      await database.insert(auditEvents).values({
        correlationId: event.correlationId,
        operation: event.operation,
        result: event.result,
        ...(event.mcpClientId === undefined ? {} : { mcpClientId: event.mcpClientId }),
        ...(event.tool === undefined ? {} : { tool: event.tool }),
        ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
        ...(event.mailboxId === undefined ? {} : { mailboxId: event.mailboxId }),
        ...(event.campaignId === undefined ? {} : { campaignId: event.campaignId }),
        ...(event.prospectId === undefined ? {} : { prospectId: event.prospectId }),
        ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        retryCount: event.retryCount ?? 0,
        ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
        ...(event.providerLatencyMs === undefined
          ? {}
          : { providerLatencyMs: String(event.providerLatencyMs) }),
        metadata: event.metadata ?? {},
      });
    },
  };
}
