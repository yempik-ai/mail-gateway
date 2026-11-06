## What

<!-- Describe the change in one or two sentences. -->

## Why

<!-- Explain the problem or the need. Link the issue, for example "Closes #123". -->

## How verified

<!-- Describe the tests you added or ran. Never paste real addresses, tokens or message content. -->

## Checklist

- [ ] `pnpm -r typecheck` and `pnpm typecheck:tests` pass
- [ ] `pnpm -r lint` and `pnpm lint:tests` pass
- [ ] `pnpm -r build` passes
- [ ] `pnpm smoke` passes
- [ ] `pnpm exec vitest run` passes (the whole suite, as CI runs it)
- [ ] `pnpm format:check` passes
- [ ] I added or updated tests for this change
- [ ] I updated the documentation and `CHANGELOG.md` where behavior changed
- [ ] A schema change comes with a new migration in `migrations/`
- [ ] The change keeps the draft-first invariant (no arbitrary send, no change to received mail)
- [ ] I did not commit real mailbox data, tokens or secrets
