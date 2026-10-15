# Changelog

## Unreleased — 2026-10-16

- Refresh the public README with a project illustration, runtime selection, private-profile quickstart, Node/Sites feature boundaries and current cloud verification limits. Add contribution and security-reporting guides.
- Expand the GitHub Actions template for Node 22.13, 24 and 26: offline root/Sites tests, syntax checks, Sites build/validation and cloud packaging. Pin third-party actions to reviewed commits and request read-only repository access. Automatic CI remains unenabled because the publishing authorization lacks workflow-write scope.
- Make cloud archive gzip bytes reproducible across packaging times; keep the public-source allowlist and exclude private configuration, preview images and runtime state.
- Add an opt-in first-party cloud-task receiver with bounded MCP waits, a single consumer lease, fixed-source claims and durable send fences. The tested model runtime is native ChatGPT Work, separate from Your dot and Codex Cloud coding tasks.
- Encrypt bounded per-conversation history for cloud-task continuation. Preserve owner/Bot/platform/conversation scope, logical retention and review-only handling of uncertain writes.
- Support one primary plus four additional Discord guild profiles with explicit channel policies and monotonic activation boundaries. Preserve primary-guild and owner-DM history. Collect active public threads only under allowed polling parents.
- Verify the Bot's managed-role mentions through current guild role metadata. Add owner-only recovery of a reviewed missed invocation without rewinding cursors or erasing reply actions.
- Read authorized Discord text attachments by actual source IDs, using bounded UTF-8 pages, current-access rechecks and fixed CDN paths. Fix the request-init compatibility observed in Sites.
- Verify warm cloud Work LINE/Discord replies with owned local receivers stopped and the local cloud-task viewer closed. Verify additional-guild replies, existing DM continuity and source isolation. Confirm public-thread reads and four text attachments reaching EOF in a separate read-only pass. Physical PC-off, unlimited uptime, unattended cold restart and fresh public-thread reply E2E remain unverified.

### Earlier cloud event-path work — 2026-10-15

- Fix empty-argument MCP tool validation so cloud recovery can execute through the installed plugin. Persist separate MCP maintenance evidence and provide an owner-only LINE inbox using the same deduplicated reply path.
- Isolate Discord channel and LINE token failures so other channels and pending callbacks keep recovering. Retry explicit LINE 429 rejections from encrypted state with the original reply content, fixed recipient and push retry key; ambiguous sends remain review-only. Fix Discord-only cloud maintenance so it does not require LINE credentials.
- Include the Sites adapter in the cloud handoff archive and document its distinct event/tool schemas, account-specific recovery cadence, cutover and local autostart rollback.
- Verify actual LINE and Discord mention replies from Your dot while both Mac receivers are stopped. Redeploy the Site with D1/subscriptions preserved; disable the old owned LaunchAgents after successful per-channel cutover. Physical laptop power-off and continuous 24-hour uptime are separate, unperformed tests.

## 0.2.0 — 2026-10-14

- Add `AGENTS.md` and a repository handoff guide so an agent can prepare the dot cloud runtime, use a connected local computer for account setup, resume interrupted work, and verify the real reply path before declaring migration complete.
- Add `setup plan` / `setup prepare` for cloud or local LINE, Discord, and combined profiles. New setup files live privately under `data/setup/`, use pairing codes without expiry, and preserve existing configuration, credentials, and recorded checkpoints.
- Add `channels add --env-path` to write credentials to the selected private profile and guard Node argument boundaries in the shell launcher. Validate mode compatibility, interrupted preparation, unsafe paths, private file permissions, and secret-free output. Enable non-echo terminal input before announcing a credential prompt, including immediate automated pastes.
- Document OAuth / MCP Events, cloud connector registration, coordinated migration and rollback, restart behavior, and proof of independence from local services. Repository import or configuration generation alone does not establish cloud hosting or a live dot connection.
- Automated checks: 180 tests passed, 1 optional Codex smoke test skipped; syntax checks and updated setup-skill validation passed. Existing live LINE / Discord services remain on the Mac; actual dot cloud operation is still unverified.

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
