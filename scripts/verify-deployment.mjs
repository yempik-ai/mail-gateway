// Post-deploy check of a running gateway: liveness, readiness with the
// database, the admin challenge and the browser security headers. It sends
// no credentials and changes nothing, so it is safe against production.
//
//   pnpm verify:deployment https://mail.example.com
//
// Vercel deployment protection: set VERCEL_AUTOMATION_BYPASS_SECRET to send
// the bypass header when checking a protected preview deployment.
// Exits 1 when any check fails, 2 on a usage error.

const REQUEST_TIMEOUT_MS = 15_000;

function usage(message) {
  console.error(message);
  console.error('usage: pnpm verify:deployment <base-url>');
  process.exit(2);
}

const rawBaseUrl = process.argv[2];
if (!rawBaseUrl) usage('Missing the deployment base URL.');
let baseUrl;
try {
  const parsed = new URL(rawBaseUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
  baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/u, '');
} catch {
  usage(`Not an http(s) URL: ${rawBaseUrl}`);
}

const commonHeaders = { 'user-agent': 'yempik-verify-deployment' };
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  commonHeaders['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
    headers: { ...commonHeaders, ...init.headers },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json };
}

// Each check returns its problems (empty means it passed) and may add notes.
function expectHeader(problems, headers, name, predicate, expected) {
  const value = headers.get(name);
  if (value === null || !predicate(value)) {
    problems.push(`${name} is ${value === null ? 'missing' : `"${value}"`}, expected ${expected}`);
  }
}

function expectNoStoreNoSniff(problems, headers) {
  expectHeader(problems, headers, 'cache-control', (v) => v.includes('no-store'), 'no-store');
  expectHeader(problems, headers, 'x-content-type-options', (v) => v === 'nosniff', 'nosniff');
}

const checks = [
  {
    name: 'GET /health/live answers 200',
    async run() {
      const problems = [];
      const response = await request('/health/live');
      if (response.status !== 200) problems.push(`status ${response.status}`);
      if (response.json?.status !== 'ok') problems.push('body status is not "ok"');
      expectNoStoreNoSniff(problems, response.headers);
      return problems;
    },
  },
  {
    name: 'GET /health/ready answers 200 with the database ok',
    async run(notes) {
      const problems = [];
      const response = await request('/health/ready');
      if (response.status !== 200) problems.push(`status ${response.status}`);
      if (response.json?.database !== 'ok') {
        problems.push(`database is ${JSON.stringify(response.json?.database)}`);
      }
      const adapters = response.json?.adapters;
      if (adapters && typeof adapters === 'object') {
        const wired = Object.entries(adapters)
          .filter(([, enabled]) => enabled === true)
          .map(([provider]) => provider);
        notes.push(`adapters wired: ${wired.length > 0 ? wired.join(', ') : 'none'}`);
      }
      return problems;
    },
  },
  {
    name: 'GET /admin without credentials answers 401 with the admin headers',
    async run() {
      const problems = [];
      const response = await request('/admin');
      if (response.status !== 401) problems.push(`status ${response.status}`);
      expectHeader(
        problems,
        response.headers,
        'www-authenticate',
        (v) => v.startsWith('Basic'),
        'a Basic challenge',
      );
      expectNoStoreNoSniff(problems, response.headers);
      expectHeader(problems, response.headers, 'x-frame-options', (v) => v === 'DENY', 'DENY');
      expectHeader(
        problems,
        response.headers,
        'content-security-policy',
        (v) => v.includes("frame-ancestors 'none'") && v.includes("default-src 'none'"),
        "default-src 'none' and frame-ancestors 'none'",
      );
      expectHeader(
        problems,
        response.headers,
        'referrer-policy',
        (v) => v === 'same-origin',
        'same-origin',
      );
      return problems;
    },
  },
  {
    // Refused before authentication, so the probe needs and changes nothing.
    name: 'cross-site POST /admin/kill-switch is refused with 403',
    async run() {
      const response = await request('/admin/kill-switch', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'cross-site',
          origin: 'https://verify-deployment.invalid',
        },
        body: 'action=activate',
      });
      return response.status === 403 ? [] : [`status ${response.status}`];
    },
  },
  {
    name: 'unknown routes answer a JSON 404',
    async run() {
      const response = await request('/verify-deployment-unknown-route');
      const problems = [];
      if (response.status !== 404) problems.push(`status ${response.status}`);
      if (response.json?.code !== 'NOT_FOUND') problems.push('body code is not NOT_FOUND');
      return problems;
    },
  },
];

console.log(`Verifying ${baseUrl}`);
let failures = 0;
for (const check of checks) {
  const notes = [];
  let problems;
  try {
    problems = await check.run(notes);
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  if (problems.length === 0) {
    console.log(`ok   ${check.name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${check.name}`);
    for (const problem of problems) console.log(`     - ${problem}`);
  }
  for (const note of notes) console.log(`     ${note}`);
}

if (failures > 0) {
  console.log(`${failures} of ${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks.length} checks passed.`);
