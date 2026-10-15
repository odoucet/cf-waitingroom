# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## Ground rules

- **English** everywhere: code, comments, commit messages, documentation, logs, error messages.
- **Zero runtime dependency.** Development dependencies are limited to wrangler, typescript,
  vitest, the Cloudflare vitest plugin and esbuild (the version wrangler uses, for the waiting page).
  No framework, no Wasm.
- **Budgets:** valid-session path without any Durable Object call, p99 CPU under 1 ms, the bundle
  under 250 KiB (`npm run size`), Durable Object requests justified (see `docs/cost-model.md`).
- **No deployment data**: no domain, account ID, route, IP address or real threshold in the
  repository. Use `example.com`, documentation IP ranges (RFC 5737 / RFC 3849) and generic figures.
- **SPDX header** `SPDX-License-Identifier: Apache-2.0` at the top of every source file (`npm run spdx`).
- Public interfaces (cookie format, admin API, metrics) are versioned: see `docs/interfaces.md`.

## Development

```sh
npm ci
npm run typecheck        # generates runtime types, then tsc --noEmit (strict)
npm test                 # all projects
npm run test:unit        # pure functions
npm run test:sim         # simulations (deterministic clock and PRNG)
npm run test:integration # Workers runtime (miniflare), edge + coordinator
npm run size             # bundle size check
```

The waiting page is edited in `src/edge/templates/waiting.html` (markup, style), `waiting.js.txt`
(script) and `src/edge/waiting.ts` (texts, one entry per language). `scripts/build-templates.mjs`
minifies it into `src/edge/templates/generated/` (git-ignored), and the dashboard page
(`src/shared/templates/dashboard.html` and `dashboard.js.txt`) into `src/shared/templates/generated/`.
The wrangler custom build of the Worker and `vitest.config.ts` run it, so there is no extra command.

Algorithm changes go to `src/core` first, with a unit test or a simulation that shows the effect.
The Workers (`src/edge`, `src/coordinator`) should stay thin wrappers around it.

## Pull requests

- One topic per pull request, with the reasoning in the description.
- CI must pass: typecheck, unit, simulations, integration, bundle size, SPDX.
- Update `CHANGELOG.md` for user-visible changes.

## Releases

Versions follow semantic versioning and are published as git tags (`v0.1.0`). Deployment is done from
your own private repository or protected environment; this repository has no deployment job.

## Repository settings (maintainers)

Enable secret scanning and push protection, private vulnerability reporting, and require the CI
check on `main`.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
