// Readers for the arguments a fake `fetch` records. `fetch` accepts a Request
// object and binary bodies too, which `String()` would turn into
// "[object Request]"; these keep the fakes honest about what they inspect.

/** The URL a fetch call targets, as text, whichever form the caller used. */
export function requestHref(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export function requestUrl(input: string | URL | Request): URL {
  return new URL(requestHref(input));
}

/**
 * The body of a recorded call. The code under test sends JSON or form bodies as
 * strings; anything else is a test failure, not something to stringify.
 */
export function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError(
    `Expected a text or form request body, received ${body === undefined || body === null ? 'none' : typeof body}`,
  );
}
