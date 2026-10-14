# Sites cloud adapter (experimental)

This Worker adapter receives signed LINE webhooks and exposes owner-only MCP tools and MCP Events to Your dot. Discord collection uses REST polling of explicitly configured guild channels and the approved owner's existing DM. It runs no model and needs no OpenAI API key or separate hosting contract when Sites is available in the account.

This is not an always-on Node daemon. LINE requests execute directly in Sites. Discord collection and failed callback recovery require either the owner-authenticated cloud browser page at `/runtime/bridge` (15-second ticks while it remains open) or a verified cloud schedule calling `bridge_maintain`. A saved schedule, open browser tab, HTTP 200, or accepted event is not proof of an actual dot reply.

## Agent deployment

Use the installed Sites skill and native tools. Do not invent project IDs, deploy with shell credentials, or copy the author's project identity. Register this checkout as a new Site only when no existing user-owned project is selected; persist the returned `project_id` in `.openai/hosting.json`. The D1 migrations are applied by the supported deployment flow. Do not edit applied migration files.

Configure runtime secrets with Sites tools, never source files:

- `BRIDGE_RUNTIME=cloud`, `BRIDGE_OWNER_SITE_ID`: verified Site-scoped owner identity from `bridge_status`.
- `COMPANION_SHARED_KEY`: random 32-byte base64 encryption key; preserve it across deployments. This cloud adapter uses it for encrypted subscription and LINE storage; it needs no companion URL.
- LINE: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_BOT_ID`, `LINE_ALLOWED_USER_IDS` (comma-separated approved U IDs), `LINE_ENABLE_EVENTS=true`, `LINE_ENABLE_REPLIES=true`.
- Short-lived LINE token renewal: `LINE_CHANNEL_ID`, `LINE_TOKEN_EXPIRES_AT` (verified ISO timestamp). A due renewal is verified against the channel and bot, then stored encrypted in D1. An ambiguous issuance is retained for review and is never blindly repeated. Existing tokens are not revoked.
- Discord: `DISCORD_BOT_TOKEN`, `DISCORD_BOT_ID`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_USER_ID`, `DISCORD_ALLOWED_CHANNEL_IDS`, `DISCORD_POLL_CHANNEL_IDS` (specific guild/DM IDs), `DISCORD_ENABLE_REPLIES=true`. Keep `DISCORD_ENABLE_EVENTS=false` until a coordinated cutover. Set `DISCORD_CLOUD_SINCE` to that cutover time, then enable collection. Only the verified owner's one-to-one DM is seeded; unknown DMs are rejected.

Publish privately first. Check owner access and configure the existing Site-created plugin. For LINE ingress, the user must request a public receive URL: then change the Site audience through native Sites tools and redeploy the same saved version. `/webhooks/line` requires a valid LINE signature and an approved sender. MCP operations and `/runtime/*` retain owner authorization even on the public Site. Never place the Sites service bearer token in a webhook URL.

After schema changes, rescan tools from the plugin settings. Confirm the actual plugin lists `line_message_read`, `line_reply`, `bridge_maintain`, and `line.message.created`; do not assume a successful Site deployment updated a cached plugin. Tool and event catalogs are stable across runtime configuration so provisioning can discover the complete schema.

Ask the actual dot to subscribe to `line.message.created` with `{}`, and the relevant Discord events with the configured guild and channel IDs. Instruct it to read each event and reply once to the source conversation. Subscriptions are encrypted and refreshed by the MCP client. Verify a real subscription and callback challenge before cutting over.

## Cloud recovery and cutover

Use `/runtime/bridge` in the dot's cloud browser, not the laptop browser. Retain the operational tab with the browser tool's supported lifecycle method. Verify a cloud call to `bridge_maintain` and persisted `cloud_runtime.last_tick_at` before creating a requested recovery schedule. Reuse the Site's existing linked automation; a new cloud schedule must use native Sites tools and the request ID returned by a fresh `get_site`. Keep secrets out of its prompt. The schedule should recover pending deliveries and a missing cloud browser tab, remain quiet when healthy, and report failures needing intervention. The cadence determines the maximum ordinary recovery delay and consumes cloud task capacity; do not promise immediate replies while the fast receiver is closed.

Before switching, drain and stop only the owned Mac bridge services, preserving their launch configuration and the previous LINE URL for rollback. Set LINE's webhook to `/webhooks/line` and run official Verify. Send new messages through actual LINE and Discord user clients. Confirm the dot handles them and each reply appears in the same conversation while the local receiver is stopped. Then test cloud interruption/redeployment and recovery. Never call a local Codex reply or manual tool send a dot E2E pass.

## Checks

```sh
node --test adapters/sites/tests/*.test.mjs
```

For schema changes, install this adapter's dev dependencies in the supported Sites workflow, update `db/schema.ts`, run `npm run db:generate`, inspect the generated migration, and build/package with the Sites source helper. Source identifiers, tokens, database contents, and private evidence are not part of this directory.
