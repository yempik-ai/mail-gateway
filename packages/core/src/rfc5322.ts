// Provider-neutral parsing of the RFC 5322 header forms every mail provider
// eventually hands back as raw text: address lists, message-id chains and dates.
// Adapters share these so a `To:` header normalizes the same way on Gmail,
// Graph and Zoho.

import type { NormalizedEmailAddress } from './types.js';

/**
 * Splits an address list on the separators that actually separate: commas
 * inside a quoted display name or inside angle brackets are part of the
 * address, not a delimiter.
 */
export function splitAddressList(value: string): string[] {
  const addresses: string[] = [];
  let start = 0;
  let quoted = false;
  let angleDepth = 0;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === '<') angleDepth += 1;
    if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && character === ',') {
      addresses.push(value.slice(start, index));
      start = index + 1;
    }
  }
  addresses.push(value.slice(start));
  return addresses;
}

export function unquoteDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\').trim();
  }
  return trimmed;
}

/** Parses a `To:`/`Cc:`/`From:` header value into normalized addresses. */
export function parseAddressHeader(value: string | undefined): NormalizedEmailAddress[] {
  if (!value) return [];
  return splitAddressList(value).flatMap((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const match = /^(.*?)<([^<>]+)>$/.exec(trimmed);
    if (!match) return [{ address: trimmed }];
    const name = unquoteDisplayName(match[1] ?? '');
    const address = (match[2] ?? '').trim();
    if (!address) return [];
    return [name ? { name, address } : { address }];
  });
}

/** Parses a `References:`/`In-Reply-To:` chain into individual message-ids. */
export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  const messageIds = value.match(/<[^>]+>/g);
  return messageIds ?? value.split(/\s+/u).filter(Boolean);
}

/**
 * A `Date:` header as ISO 8601, or undefined when it is missing or does not
 * parse: a malformed date must not fail the read or the quote that uses it.
 */
export function parseHeaderDateIso(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
