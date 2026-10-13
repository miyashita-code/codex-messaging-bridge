# Changelog

## 0.1.3 — 2026-10-14

- Add per-account `pairingCodeTtlMs` for LINE and Discord. `null` creates pending codes without expiry; positive integers specify milliseconds; omission preserves the OpenClaw-compatible one-hour default. Challenge messages describe the configured expiry.
- Preserve pending codes, their stored expiry, the cap of three pending codes per account, and existing approved connections. Approved connections remain valid until revoked. The previous one-hour deadline applied to unapproved challenge codes.
- Verify exact expiry boundaries, no-expiry persistence across restart, account inheritance, namespace isolation, and both channels' challenge notices. Automated checks: 164 tests passed, 1 optional Codex smoke test skipped; syntax checks passed.
- Confirm actual Discord and LINE bot exchanges with personal Codex on macOS. Discord coverage includes DM pairing, guild mentions, replies and conversation continuity after LaunchAgent migration. LINE coverage includes approval, an actual user's input through Codex to the same conversation's reply, and approval and conversation-context retention after gateway restart with no-expiry codes configured. LINE uses a public HTTPS webhook. Your dot MCP and cloud computer live integration remain unverified.

## 0.1.2 — 2026-10-13

- Fix the portable combined LINE / Discord MCP example to request Discord read and write scopes.
- Add an HTTP OAuth / PKCE regression test using the distributed example's scopes for both channels.

## 0.1.1 — 2026-10-13

- Update LINE onboarding to create an official account and enable Messaging API in LINE Official Account Manager before opening the channel in LINE Developers Console.

## 0.1.0 — 2026-10-13

- Initial prerelease with LINE / Discord channel policies, pairing, durable inbox and replies, personal Codex, Your dot MCP Events, and Discord headless inbox profiles.
