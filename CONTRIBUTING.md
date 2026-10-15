# Contributing

Bug reports, setup improvements and focused pull requests are welcome. Use invented users, tokens and messages in examples. Report security issues through [SECURITY.md](SECURITY.md), rather than a public Issue.

## Development

Use Node.js 22.13 or newer, npm, Git and a POSIX shell. GNU tar or bsdtar is required for cloud packaging. The root application has no external npm runtime dependencies.

```bash
npm ci --ignore-scripts
npm test
npm run test:sites
npm run check
npm --prefix adapters/sites run build
npm --prefix adapters/sites run validate
npm run package:cloud
```

These checks do not require real service credentials, Codex login or a running Bot. Sites build/validation does not deploy a Site.

The [GitHub Actions template](deploy/github-actions-ci.yml.example) runs these checks on Node 22.13, 24 and 26. Automatic CI is not enabled in this repository. To enable it in your checkout, place the template at `.github/workflows/ci.yml` using GitHub authorization with workflow-write access. The job requests read-only repository access and does not use service credentials.

For a real personal Codex smoke test, explicitly opt in on your own account:

```bash
CODEX_SMOKE=1 node --test --test-name-pattern='real CLI smoke' tests/codex.test.mjs
CODEX_E2E=1 npm run test:codex-e2e
```

The latter performs real model inference and uses account capacity. Never put real Bot credentials or account files into CI or pull requests.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/`, `tests/` | Node Gateway, CLI, local Codex, OAuth / MCP and tests |
| `adapters/sites/worker/`, `adapters/sites/tests/` | Sites Worker / D1, cloud collection and claim-based MCP receiver |
| `docs/` | Setup guides, compatibility and runtime verification |
| `deploy/` | Local service / reverse-proxy examples |
| `scripts/package-cloud.mjs` | Public-source-only cloud archive |

Read [AGENTS.md](AGENTS.md) before using an agent to install or migrate an actual Bot. Preserve existing configuration, approved senders and delivery records.

## Changes and validation

- Keep Node and Sites behavior distinct in documentation and tests. A Node test is not evidence of a cloud deployment.
- Add regression coverage for changed authorization, source scope, pairing, replay boundaries and ambiguous-write handling. Mock tests must not be described as real LINE / Discord E2E.
- For cloud runtime claims, state the selected AI backend and distinguish a running warm task, scheduled recovery, restart persistence and physical PC-off tests.
- Preserve fixed-recipient replies, current authorization checks and durable send reservations. Do not resolve a retry by erasing an uncertain outcome.
- Keep private `.env`, runtime settings, databases, receipts and real conversation screenshots out of commits. New files intended for the cloud archive must be reviewed against its explicit allowlist.

Pull requests should explain the concrete behavior change, relevant checks and remaining limitations. Contributions are distributed under the repository's [MIT license](LICENSE).
