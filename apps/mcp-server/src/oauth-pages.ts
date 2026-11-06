// The provider connect flows all end in a browser tab, so they share the same
// minimal result page instead of each carrying its own copy. The MCP consent
// page lives here too, in the same style.

import { escapeHtml } from '@yempik/core';

const PAGE_STYLE =
  'body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}h1{font-size:1.25rem}';

export function renderPage(title: string, message: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
  ].join('');
}

export interface ConsentPage {
  /** Self-declared at registration, so shown as a claim next to the facts. */
  clientName: string;
  clientId: string;
  /** Host (or scheme) the browser is sent back to with the code. */
  redirectDestination: string;
  /** The validated authorization request, echoed as hidden form fields. */
  fields: Record<string, string>;
}

const CONSENT_STYLE =
  'dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem}dt{color:#555}dd{margin:0;overflow-wrap:anywhere}' +
  'form{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;cursor:pointer;padding:.5rem 1rem}' +
  '.approve{background:#111;color:#fff;border:1px solid #111}.deny{background:#fff;border:1px solid #999}' +
  '.note{color:#555;font-size:.9rem}';

/**
 * Asks the operator to approve an MCP client before an authorization code is
 * issued. Plain form, no script: the CSP forbids scripts on every page.
 */
export function renderConsentPage(page: ConsentPage): string {
  const title = `Allow ${page.clientName} to use this gateway?`;
  const hiddenFields = Object.entries(page.fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}${CONSENT_STYLE}</style>`,
    `</head><body><h1>${escapeHtml(title)}</h1>`,
    '<p>Approving lets this MCP client call the gateway tools with the mailboxes, ',
    'feature flags and sending limits configured here.</p>',
    '<dl>',
    `<dt>Client name</dt><dd>${escapeHtml(page.clientName)}</dd>`,
    `<dt>Client ID</dt><dd><code>${escapeHtml(page.clientId)}</code></dd>`,
    `<dt>Returns to</dt><dd><code>${escapeHtml(page.redirectDestination)}</code></dd>`,
    '</dl>',
    '<p class="note">The client chose its own name when it registered. ',
    'Approve only if you are connecting this client yourself right now.</p>',
    `<form method="post" action="/authorize">${hiddenFields}`,
    '<button class="approve" type="submit" name="decision" value="approve">Approve</button>',
    '<button class="deny" type="submit" name="decision" value="deny">Deny</button>',
    '</form></body></html>',
  ].join('');
}
