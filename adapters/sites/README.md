# Sites cloud adapter (experimental)

This Worker adapter receives signed, approved one-to-one LINE text messages (LINE groups and non-text messages are currently ignored) and exposes owner-only MCP tools and MCP Events to Your dot. Discord collection uses REST polling of explicitly configured guild channels and the approved owner's existing DM. It runs no model and needs no OpenAI API key or separate hosting contract when Sites is available in the account.

This is not an always-on Node daemon. LINE requests execute directly in Sites. Discord collection and failed callback recovery require either the owner-authenticated cloud browser page at `/runtime/bridge` (15-second ticks while it remains open) or a verified cloud schedule calling `bridge_maintain`. A saved schedule, open browser tab, HTTP 200, or accepted event is not proof of an actual dot reply.

## Agent deployment

Use the installed Sites skill and native tools. Do not invent project IDs, deploy with shell credentials, or copy the author's project identity. Register this checkout as a new Site only when no existing user-owned project is selected; persist the returned `project_id` in `.openai/hosting.json`. The D1 migrations are applied by the supported deployment flow. Do not edit applied migration files.

Configure runtime secrets with Sites tools, never source files:

- `BRIDGE_RUNTIME=cloud`, `BRIDGE_OWNER_SITE_ID`: verified Site-scoped owner identity from `bridge_status`.
- `COMPANION_SHARED_KEY`: random 32-byte base64 encryption key; preserve it across deployments. This cloud adapter uses it for encrypted subscription and LINE storage; it needs no companion URL.
- LINE: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_BOT_ID`, `LINE_ALLOWED_USER_IDS` (comma-separated approved U IDs), `LINE_ENABLE_EVENTS=true`, `LINE_ENABLE_REPLIES=true`.
- Short-lived LINE token renewal: `LINE_CHANNEL_ID`, `LINE_TOKEN_EXPIRES_AT` (verified ISO timestamp). A due renewal is verified against the channel and bot, then stored encrypted in D1. An ambiguous issuance is retained for review and is never blindly repeated. Existing tokens are not revoked.
- Discord: `DISCORD_BOT_TOKEN`, `DISCORD_BOT_ID`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_USER_ID`, `DISCORD_ALLOWED_CHANNEL_IDS`, `DISCORD_POLL_CHANNEL_IDS` (specific guild/DM IDs), `DISCORD_ENABLE_REPLIES=true`. Keep `DISCORD_ENABLE_EVENTS=false` until a coordinated cutover. Set `DISCORD_CLOUD_SINCE` to that cutover time, then enable collection. Only the verified owner's one-to-one DM is seeded; unknown DMs are rejected.

### Verify the LINE owner before enabling intake

Sites uses a server-side allowlist and does not issue the Node Gateway's pairing codes. Unknown senders are ignored, so sending a first message before `LINE_ALLOWED_USER_IDS` is configured will not produce a code.

For an existing bot, review its already verified owner approval and carry only that required user ID and channel policy into runtime settings. For a new bot, open the target Messaging API channel's **Basic settings → Your user ID** in LINE Developers Console using the owner's linked LINE account. Confirm it is the same personal LINE account that will send the test message; a Business ID without a linked LINE account does not display this field. User IDs differ across providers. See [LINE's user-ID guide](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/).

If that account cannot be verified in the console, complete an authorized initial pairing on the existing owned local Gateway and review only the matching approval before migration. Do not use another account's ID, scrape unrelated contacts, or temporarily allow every sender. Store the verified ID privately, enable intake, then send a new owner message and verify the reply. Node CLI `pairing approve` does not configure the Sites allowlist.

Publish privately first. Check owner access and configure the existing Site-created plugin. For LINE ingress, the user must request a public receive URL: then change the Site audience through native Sites tools and redeploy the same saved version. `/webhooks/line` requires a valid LINE signature and an approved sender. MCP operations and `/runtime/*` retain owner authorization even on the public Site. Never place the Sites service bearer token in a webhook URL.

After schema changes, rescan tools from the plugin settings. Confirm the actual plugin lists `line_message_read`, `line_inbox_read`, `line_reply`, `bridge_maintain`, and `line.message.created`; do not assume a successful Site deployment updated a cached plugin. Tool and event catalogs are stable across runtime configuration so provisioning can discover the complete schema.

Ask the actual dot to subscribe to `line.message.created` with `{}`, and the relevant Discord events with the configured guild and channel IDs. Instruct it to read each event and reply once to the source conversation. Subscriptions are encrypted and refreshed by the MCP client. Verify a real subscription and callback challenge before cutting over.

## Cloud recovery and cutover

Use `/runtime/bridge` in the dot's cloud browser, not the laptop browser. Retain the operational tab with the browser tool's supported lifecycle method. Verify a cloud call to `bridge_maintain` and persisted `cloud_runtime.last_tick_at` before creating a requested recovery schedule. Reuse the Site's existing linked automation; a new cloud schedule must use native Sites tools and the request ID returned by a fresh `get_site`. Keep secrets out of its prompt. The schedule should recover pending deliveries, remain quiet when healthy, and report failures needing intervention. Test browser reopening separately before adding it to the schedule: the tested scheduled task could invoke MCP but its browser request to the runtime page was blocked by the client. Preserve that boundary; do not claim or attempt to bypass it. Hourly MCP collection remains the fallback when the cloud browser is closed. The cadence determines recovery latency and consumes cloud task capacity; do not promise immediate replies while the fast receiver is closed. In the verified account on 2026-10-15, Sites rejected a five-minute interval with a one-run-per-hour limit, and accepted an hourly schedule. Use the actual account limit; do not create multiple staggered schedules to evade it. Delivery can take longer if a scheduled run is delayed or fails. Event callback acceptance is also asynchronous: a fresh LINE message received at 16:01 was answered at 16:11 while the local receivers and cloud polling tab were unavailable. Do not promise instant replies or treat callback acceptance as task completion.

Explicit LINE HTTP 429 rejections are retried from an encrypted durable record with the same content, fixed recipient and original push retry key, at most eight total attempts. Ambiguous transport/5xx writes stay `unknown` for review. A failed Discord channel or LINE token renewal must not block the other channel's callback recovery.

Callback acceptance can precede actual model processing. A cloud recovery task can also call `line_inbox_read({limit:20})` to list currently approved one-to-one LINE events with no reply action. It returns only event IDs and times. Follow `next_cursor` even when a page is empty, and start without a cursor on each new run. For each returned ID, read it with `line_message_read` before deciding whether a reply is needed. `line_reply` fixes the recipient to the original conversation and shares the event task's durable action reservation, preventing concurrent duplicate sends. Every existing reply action is excluded from the list, including `reserved`, `retryable`, `unknown`, `failed`, and `completed`; do not treat this as recovery of every missing reply or resend ambiguous writes. Keep event-driven Your dot replies and replies produced by the recovery task distinct in verification records. This adds no API key or new authorization scope.

The owner-only `/runtime/inbox` page shows approved LINE messages and their reply status. It uses the same fixed-recipient, deduplicated write path as the MCP reply tool. It is an operator fallback, not evidence of automatic dot execution.

Before switching, drain and stop only the owned Mac bridge services, preserving their launch configuration and the previous LINE URL for rollback. Once a channel passes its cloud E2E, disable that owned local service's automatic startup too: a retained LaunchAgent must not reclaim the LINE webhook or reply twice after the laptop restarts. Record how to re-enable it during rollback. Set LINE's webhook to `/webhooks/line` and run official Verify. Send new messages through actual LINE and Discord user clients. Confirm the dot handles them and each reply appears in the same conversation while the local receiver is stopped. Then test cloud interruption/redeployment and recovery. Never call a local Codex reply or manual tool send a dot E2E pass.

## Checks

```sh
node --test adapters/sites/tests/*.test.mjs
```

For schema changes, install this adapter's dev dependencies in the supported Sites workflow, update `db/schema.ts`, run `npm run db:generate`, inspect the generated migration, and build/package with the Sites source helper. Source identifiers, tokens, database contents, and private evidence are not part of this directory.
