// Turning a caller's body into what the provider receives: body validation and
// rendering, the stored signature of the sending identity, and which identity
// a draft sends from.

import { GatewayError, appendSignature, renderEmailBody } from '@yempik/core';
import type { RenderedEmailBody } from '@yempik/core';
import type { StoredSignature } from '../signature-store.js';
import type { DraftServiceContext } from './context.js';
import { invalid } from './errors.js';
import { isValidRecipient } from './records.js';
import type { DraftBodyInput, DraftMailboxRecord, DraftRecord } from './types.js';

const BODY_FIELDS = ['body', 'textBody', 'htmlBody'] as const;
type BodyField = (typeof BODY_FIELDS)[number];

/**
 * Body fields carrying content. LLM clients often send empty strings for the
 * optional fields they do not use, so blank values count as absent.
 */
export function providedBodyFields(input: DraftBodyInput): BodyField[] {
  return BODY_FIELDS.filter((field) => (input[field] ?? '').trim() !== '');
}

/**
 * The body exactly as the caller wrote it. Idempotency hashes this, never the
 * rendered output: a retry stays a duplicate even after the stored signature
 * or the renderer changes. For text/HTML bodies it is the same string the
 * hash used before Markdown bodies existed (`textBody ?? htmlBody`, so textBody
 * when both are given), so existing keys still match.
 */
export function rawDraftBody(input: DraftBodyInput): string {
  const [field] = providedBodyFields(input);
  return field === undefined ? '' : (input[field] ?? '');
}

/**
 * Why a draft body is unusable, or undefined when it is usable: `body` alone,
 * or textBody and/or htmlBody. The text+HTML pair stays accepted because the
 * earlier tool contract told clients to send both for an explicit text part.
 */
export function bodyProblem(input: DraftBodyInput): string | undefined {
  const provided = providedBodyFields(input);
  if (provided.length === 0) {
    return 'A draft needs a body: provide body (Markdown), or textBody and/or htmlBody';
  }
  if (provided.includes('body') && provided.length > 1) {
    return `body (Markdown) cannot be combined with textBody or htmlBody, received ${provided.join(' and ')}`;
  }
  return undefined;
}

/**
 * Renders the caller's body. With both textBody and htmlBody the HTML is
 * rendered and the caller's own text replaces the derived text part, as the
 * explicit plain-text alternative it was always meant to be.
 */
function renderDraftBody(input: DraftBodyInput): RenderedEmailBody {
  const provided = providedBodyFields(input);
  if (provided.includes('textBody') && provided.includes('htmlBody')) {
    const { html } = renderEmailBody({ html: input.htmlBody ?? '' });
    return { text: (input.textBody ?? '').replace(/\r\n?/gu, '\n'), html };
  }
  return renderEmailBody({
    ...(input.body === undefined ? {} : { markdown: input.body }),
    ...(input.textBody === undefined ? {} : { text: input.textBody }),
    ...(input.htmlBody === undefined ? {} : { html: input.htmlBody }),
  });
}

/** A body ready for the provider, plus the From fields the signature row implies. */
export interface ComposedBody {
  textBody: string;
  htmlBody: string;
  from?: string;
  fromDisplayName?: string;
}

export function requireSendingIdentity(
  mailbox: DraftMailboxRecord,
  fromAddress: string | undefined,
  correlationId: string,
): string | undefined {
  if (fromAddress === undefined) return undefined;
  const normalized = fromAddress.trim().toLowerCase();
  const identities = [mailbox.emailAddress, ...mailbox.aliases].map((address) =>
    address.trim().toLowerCase(),
  );
  if (!isValidRecipient(normalized) || !identities.includes(normalized)) {
    throw invalid(
      `${fromAddress} is not a registered sending identity of mailbox ${mailbox.id}`,
      correlationId,
    );
  }
  return normalized;
}

export function sendingIdentityFor(
  mailbox: DraftMailboxRecord,
  selected: string | undefined,
): string {
  return (selected ?? mailbox.emailAddress).trim().toLowerCase();
}

/**
 * The identity a draft already sends from: a re-rendered body is signed for
 * that identity, not for the primary address. An alias removed from the
 * mailbox since creation is refused rather than replaced by the primary:
 * the body and From would move to the primary while the row kept the old
 * alias, and send quotas would then be charged to the wrong identity. The
 * caller has to pick the identity explicitly with fromAddress.
 */
export function currentIdentityOf(
  mailbox: DraftMailboxRecord,
  record: DraftRecord,
  correlationId: string,
): string | undefined {
  const current = record.sendingIdentityEmail?.trim().toLowerCase();
  if (current === undefined) return undefined;
  const registered = [mailbox.emailAddress, ...mailbox.aliases].map((address) =>
    address.trim().toLowerCase(),
  );
  if (registered.includes(current)) return current;
  throw invalid(
    `Draft ${record.id} sends from ${current}, which is no longer a registered sending identity of mailbox ${mailbox.id}; pass fromAddress to choose the identity the new body is signed for`,
    correlationId,
  );
}

/**
 * Signature row of one sending identity. A lookup failure is surfaced, never
 * swallowed: a draft silently created without its signature would go out
 * looking unfinished, which is worse than a retryable error.
 */
async function loadSignature(
  ctx: DraftServiceContext,
  mailbox: DraftMailboxRecord,
  identity: string,
): Promise<StoredSignature | undefined> {
  const { signatureStore, correlationId } = ctx;
  if (signatureStore === undefined) return undefined;
  try {
    return await signatureStore.getSignature(mailbox.id, identity);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('DATABASE_ERROR', 'The signature registry is unavailable', {
      retryable: true,
      correlationId,
      cause: error,
    });
  }
}

function displayNameOf(signature: StoredSignature | undefined): string | undefined {
  const name = signature?.displayName?.trim();
  return name === undefined || name === '' ? undefined : name;
}

/**
 * Turns the caller's body into the text and HTML parts every provider gets,
 * with the stored signature of the sending identity appended. The display
 * name is applied even when the signature is skipped: it is part of who
 * sends, not of the body. Adapters only honour `fromDisplayName` next to
 * `from`, so an implicit identity is made explicit only when a name exists;
 * otherwise the From header stays exactly as it was before signatures.
 */
export async function composeBody(
  ctx: DraftServiceContext,
  mailbox: DraftMailboxRecord,
  fromAddress: string | undefined,
  input: DraftBodyInput,
  includeSignature: boolean,
  currentIdentity?: string,
): Promise<ComposedBody> {
  let rendered: RenderedEmailBody;
  try {
    rendered = renderDraftBody(input);
  } catch (error) {
    throw invalid(
      error instanceof Error ? error.message : 'The draft body is empty',
      ctx.correlationId,
    );
  }

  const identity = sendingIdentityFor(mailbox, fromAddress ?? currentIdentity);
  const signature = await loadSignature(ctx, mailbox, identity);
  const signed = includeSignature
    ? appendSignature(rendered, {
        ...(signature?.signatureHtml === undefined ? {} : { html: signature.signatureHtml }),
        ...(signature?.signatureText === undefined ? {} : { text: signature.signatureText }),
      })
    : rendered;
  const displayName = displayNameOf(signature);
  const from = fromAddress ?? (displayName === undefined ? undefined : identity);
  return {
    textBody: signed.text,
    htmlBody: signed.html,
    ...(from === undefined ? {} : { from }),
    ...(displayName === undefined ? {} : { fromDisplayName: displayName }),
  };
}

/**
 * From fields of an update that keeps the body: a new identity brings its
 * own display name, so the header does not keep the previous one's.
 */
export async function senderOnly(
  ctx: DraftServiceContext,
  mailbox: DraftMailboxRecord,
  fromAddress: string | undefined,
): Promise<Partial<ComposedBody>> {
  if (fromAddress === undefined) return {};
  const displayName = displayNameOf(await loadSignature(ctx, mailbox, fromAddress));
  return {
    from: fromAddress,
    ...(displayName === undefined ? {} : { fromDisplayName: displayName }),
  };
}
