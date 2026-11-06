# Integration tests

Suites here talk to real infrastructure and skip themselves when it is not available, so
`pnpm -r test` stays green on a machine without it.

- `database.migrations.test.ts` applies every migration in `migrations/` to a throwaway schema
  of the PostgreSQL named by `DATABASE_URL`, re-runs them as a no-op and exercises the signature
  store against the real schema. CI provides a `postgres:16` service; locally, export a
  **direct** (non-pooled) `DATABASE_URL` in the shell. The repo-root `.env` is deliberately
  ignored, so a local run never migrates a Neon branch by accident.
