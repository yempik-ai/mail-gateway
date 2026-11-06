# Contributing

Thank you for helping to improve Yempik Mail Gateway. This guide explains how to set up the
project, which checks a change must pass and how to propose it.

For a large change, such as a new provider or a change to the send path, open an issue first so that
we can agree on the shape before you write code.

## Ground rules

- **Never commit real mailbox data, tokens or secrets.** This covers email addresses of real people,
  message content, OAuth client secrets, refresh tokens, encryption keys and database dumps. Use
  placeholders such as `sales@example.com`. If you find such data in the history, report it as a
  security issue (see [SECURITY.md](SECURITY.md)).
- Keep the draft-first invariant. `send_draft` must accept only a gateway draft id. Do not add
  arbitrary send, forward, move or delete operations for received mail. The test in
  `tests/security/forbidden-operations.test.ts` enforces this.
- Be kind and constructive. See the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: Node.js 22, pnpm 11 and a PostgreSQL database. A free Neon branch works well. Docker
is optional.

```sh
git clone https://github.com/yempik-ai/mail-gateway.git
cd mail-gateway
cp .env.example .env
cp mailboxes.example.json mailboxes.json   # optional: or add mailboxes from /admin
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Edit `.env` first. Use a direct `DATABASE_URL` with TLS and local-only secrets. `mailboxes.json` is
ignored by git and holds your mailbox registry; the format is in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md). The full list of
variables is in [docs/OPERATIONS.md](docs/OPERATIONS.md#environment-variables). Provider setup is
in [docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md),
[docs/MICROSOFT_ENTRA_SETUP.md](docs/MICROSOFT_ENTRA_SETUP.md) and
[docs/ZOHO_MAIL_SETUP.md](docs/ZOHO_MAIL_SETUP.md). You can work on most code without connecting a
real mailbox, because the unit tests mock the provider calls.

For the layout of the packages, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quality gates

Every pull request must pass these checks. CI runs them in this order on Node.js 22, with a
PostgreSQL 16 service for the database tests:

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm typecheck:tests
pnpm -r lint
pnpm lint:tests
pnpm -r build
pnpm smoke
pnpm exec vitest run
pnpm format:check
```

| Command                | What it checks                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`    | Strict TypeScript in every package.                                                                       |
| `pnpm typecheck:tests` | The `tests/` tree and `vitest.config.ts`, which sit outside every package (`tsconfig.tests.json`).        |
| `pnpm -r lint`         | ESLint on every package's `src`.                                                                          |
| `pnpm lint:tests`      | ESLint on `tests/` and `vitest.config.ts`.                                                                |
| `pnpm -r build`        | Builds every package.                                                                                     |
| `pnpm smoke`           | Boots the built app with `require(esm)` disabled, as Vercel's function loader does. It needs no database. |
| `pnpm exec vitest run` | The whole `tests/` tree from the root config, once, with the PostgreSQL service for the database tests.   |
| `pnpm format:check`    | Prettier.                                                                                                 |

`pnpm typecheck` and `pnpm lint` are shortcuts that include the test programs. Run `pnpm format` to
fix formatting. `pnpm smoke` catches a CommonJS dependency that pulls in an ESM-only package.

CI runs the suite only once, with `pnpm exec vitest run`. Running `pnpm -r test` there as well
would run every listed file, the PostgreSQL tests included, a second time. Locally,
`pnpm -r test` still runs the test list of each package, which is handy while you work on one
package. `tests/unit/ci-workflow.test.ts` checks that CI keeps a single test step.

The database integration test (`tests/integration/database.migrations.test.ts`) applies every
migration to a throwaway schema and exercises the stores against PostgreSQL. It skips itself when
`DATABASE_URL` is not set in the shell. CI starts a `postgres:16` service and exports the variable.
Locally, export a **direct** (non-pooled) `DATABASE_URL` in the shell before you run the tests, for
example one for a disposable database:

```sh
export DATABASE_URL=postgresql://gateway:gateway@localhost:5432/gateway_test
pnpm exec vitest run tests/integration
```

The test ignores the repo-root `.env`, so a local run never migrates a Neon branch by accident.

After you deploy, check the running gateway with `pnpm verify:deployment <url>`. See
[docs/OPERATIONS.md](docs/OPERATIONS.md#verify-a-deployment).

## Tests

- Put unit tests in `tests/unit`, security tests in `tests/security` and tests that need real
  infrastructure in `tests/integration`.
- Add a test for every bug fix and every new behavior.
- Do not call real provider APIs in tests. Mock the HTTP layer.
- A package's `test` script lists its files in its `package.json`, for local runs with
  `pnpm -r test`. Add new test files there. The root `pnpm exec vitest run`, which CI uses, runs
  every file under `tests/`, listed or not.
- Tests are type-checked and linted like source code. Use `example.com` addresses as fixtures.

## Commit style

Use short, imperative commit subjects with a conventional prefix:

```text
feat(mcp): add a draft status filter
fix(microsoft): keep the quoted conversation on update
docs: explain the reconcile outcomes
```

Common prefixes are `feat`, `fix`, `docs`, `test`, `refactor`, `chore` and `ci`. Add a scope in
parentheses when it helps. Explain the reason for the change in the body, not only the content.

## Pull requests

- Branch from `main`. Keep each pull request focused on one change.
- Fill in the pull request template: what changed, why, how you verified it, and the checklist.
- Update the documentation and `CHANGELOG.md` (under `Unreleased`) when behavior changes.
- Add a migration in `migrations/` for every schema change. Use the next number, keep it additive
  where possible and never edit a migration that has been released.
- A maintainer reviews every pull request. Expect questions about safety and idempotency for
  anything that touches drafts, sending or quotas.

## Adding a provider adapter

A provider adapter translates one mail API into the provider-neutral contracts in
`packages/core/src/mail.ts`.

1. Create `packages/<provider>-adapter` with its own `package.json`, modeled on
   `packages/zoho-adapter`. Add it to the Dockerfile's dependency layer.
2. Implement `MailProviderAdapter` (search, read, thread, connection health) and
   `MailDraftAdapter` (create, reply, update, adopt, delete, check and send a draft). Return the
   normalized types from `packages/core`.
3. Map provider failures to `GatewayError` codes: timeouts to `PROVIDER_TIMEOUT`, throttling to
   `PROVIDER_RATE_LIMIT`, definitive refusals to `PROVIDER_REJECTED`, and an ambiguous send to
   `SEND_STATUS_UNKNOWN`.
4. Implement sending only on an existing draft. Do not add a direct send path. If the provider
   cannot send an existing draft, document the weaker guarantee in an ADR, as ADR 0002 does for
   Zoho.
5. Add an OAuth service in `packages/oauth`. Encrypt tokens with `packages/security`, verify that the
   authenticated address matches the mailbox, and request the minimum scopes.
6. Add the provider to the `mailbox_provider` enum with a migration, to the config schema in
   `packages/core/src/config.ts` and to the adapter factory in `apps/mcp-server/src/adapters.ts`.
7. Add OAuth routes in `apps/mcp-server/src`, modeled on `zoho-oauth.ts`.
8. Write unit tests for search, normalization, drafts and send. Extend the forbidden-operation scan
   for the provider's direct-send call.
9. Add a setup guide in `docs/` and link it from [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Reporting bugs and requesting features

Use the issue templates. Include the gateway version, the provider and the tool name. Remove
addresses, tokens and message content from logs before you paste them. Report security problems
privately, as described in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
