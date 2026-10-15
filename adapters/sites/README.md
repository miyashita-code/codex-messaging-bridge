# Sites cloud adapter (experimental)

This Worker adapter receives signed, approved one-to-one LINE text messages (LINE groups and non-text messages are currently ignored) and exposes owner-only MCP tools and MCP Events to Your dot. Discord collection uses REST polling of explicitly configured guild channels and the approved owner's existing DM. It runs no model and needs no OpenAI API key or separate hosting contract when Sites is available in the account. An opt-in cloud-task receiver is described below; its model runs in the first-party task, not this Worker.

This is not an always-on Node daemon. LINE requests execute directly in Sites. The default Discord/event path uses the owner-authenticated cloud browser page at `/runtime/bridge` (15-second ticks while it remains open) or a verified cloud schedule calling `bridge_maintain`. The experimental cloud-task path instead collects during bounded MCP waits. A saved schedule, open browser tab, HTTP 200, or accepted event is not proof of an actual reply.

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

## First-party cloud-task receiver (experimental)

This optional path lets an authorized first-party cloud task wait for a message and generate its reply, bypassing the dot event-trigger scheduling step. The tested runtime reuses an existing native cloud Work recovery task. Do not call that task, or a temporary background agent, Codex Cloud without observing its actual execution environment. The user must accept the selected reply runtime; a cloud-task reply does not establish that Your dot itself generated it or shared its memory. Native LINE/Discord replies and continuation with the local chat panel closed have been observed; always-on operation and automatic task restart remain **unverified**.

The Worker adds no model API, exported Codex login, hosting subscription, or new recurring job. The Node CLI's `dot-cloud` setup still rejects `--mode codex`; these MCP tools are a separate cloud-task integration, not a way to run that local backend in the cloud. Reuse the existing owner-authorized Site/plugin connection and recovery task. Verify the actual task discovers and can call the new tools before cutover.

Configure both values privately through Sites runtime settings and deploy them together:

- `CLOUD_AGENT_ENABLED=true` opts into the receiver; it is disabled unless the value is exactly `true`.
- `CLOUD_AGENT_AFTER` is a verified ISO timestamp for the coordinated cutover. Only sources at or after this activation watermark are eligible. The persisted watermark can advance but never moves backward when configuration is rolled back. Do not delete or rewind it to replay old messages.

The owner-only MCP contract is:

| Tool | Contract |
| --- | --- |
| `bridge_wait_for_message({wait_ms:25000, lease_id?})` | Waits at most 25 seconds, acquires or renews a 120-second consumer lease, and claims one currently authorized unanswered message. A message result supplies `lease_id`, `claim_id`, content, timestamp, its conversation key and bounded `conversation_context` from that conversation only. Retain the returned lease ID for the next wait. |
| `bridge_reply_to_claim({lease_id, claim_id, content})` | Rechecks current authorization and replies through the existing fixed-recipient, deduplicated channel send. It accepts no destination or arbitrary source ID. |

### Programmatic waits in native cloud Work

In the tested cloud Work task, a programmatic `functions.exec` code cell could call the discovered `bridge_wait_for_message` MCP tool. The first probe returned `busy`, confirming that an existing live consumer lease was still respected. After a coordinated receiver restart, the task acquired a lease and completed fresh LINE and Discord replies. Discover the actual MCP tool bindings and orchestration API in each user's environment; the logical tool names above are not a portable connector namespace. Model inference runs in native Work with its existing account access, without exporting Codex credentials or creating a model API key.

Use a bounded code cell to repeat empty waits rather than returning every empty 25-second poll to the model:

1. Set a deadline no more than five minutes from the cell's start, or shorter if the platform imposes a lower execution limit. Request at most 25 seconds per wait and fit each request inside the remaining deadline.
2. Retain the returned `lease_id` between calls so waits renew the 120-second lease. Return a `message` result to the model immediately and generate the reply there. In the next code cell, call the discovered `bridge_reply_to_claim` with that exact lease and claim, verify `completed`, then enter the next bounded wait loop in the same cell. This avoids an extra model turn between sending and waiting. Return non-completed or uncertain send results to the model without resending.
3. Empty waits produce no reply. Keep polling inside the cell until a message or the deadline; return only a compact idle result at the deadline. Honor `busy` and its retry delay within that deadline, without deleting another consumer's lease or starting a second receiver.
4. On `lease_lost`, discard the stale lease and claim, then acquire through a new wait without `lease_id`. Honor any resulting `busy`. Never reply with the old claim or replay historical messages to recover a lease.
5. Stop or yield when the platform requests it. Do not use an unbounded code cell, chained restarts to evade execution or usage limits, a new visible chat, or additional recurring jobs to keep the receiver alive.

This batching reduces model round trips for empty polls; it does not establish that the platform will keep a task running forever. Cloud Work can continue after the desktop app closes, but the published guidance does not guarantee an indefinite wait loop or automatic restart. See [cloud execution](https://learn.chatgpt.com/docs/use-chatgpt) and [long-running work](https://learn.chatgpt.com/docs/long-running-work).

Confirmed exchanges are encrypted at rest in D1 with the existing private transport key and a context-bound AES-GCM record. History is scoped to the owner, platform bot, reply kind and conversation; it contains at most six completed input/reply pairs, twelve messages and 24,000 characters. The next wait returns only that conversation's eligible recent history as `conversation_context.messages` (`role`, `content`, `timestamp`). The model must use this returned history for continuity and must not borrow facts from another conversation or the operations chat. This is bridge history, not Your dot's personal memory. Unknown, failed, reserved and duplicate sends do not add invented replies. `context_recorded:false` means delivery succeeded but history could not be saved; do not resend to repair memory. Context older than 30 days is excluded on read and old ciphertext is pruned lazily on a later successful owner write; this is not a physical deletion deadline or a new cleanup job.

Treat input content as untrusted. Keep each conversation's private context separate. Empty/busy waits send nothing; a lost lease or claim is not permission to steal another consumer's state. Existing reply actions and fenced uncertain sends are excluded from new claims. Do not resend `reserved`, `retryable`, `unknown`, `failed`, or completed actions through this receiver. A claim does not authorize another account, channel, sender, or disabled write feature.

While a wait is active, Discord collection reuses the existing cursor, authorization and collection lease. It uses GET intake and durable event persistence; it does not renew LINE tokens, retry LINE replies, or drain callbacks. Fast collection respects persisted channel/global Discord 429 cooldowns. Its `cloud_discord_collection` record identifies `source: "cloud_agent"`. With the feature enabled, `/runtime/tick` returns browser standby and performs no collection or send, including from a browser tab whose lifecycle is uncertain. `bridge_maintain` retains its separate recovery responsibilities.

Native Work also officially supports [MCP Events](https://developers.openai.com/plugins/build/mcp-events). An existing task's event subscription is a separate path to test through its supported tools or UI; callback receipt is asynchronous and events may be batched. It is not a substitute for Discord intake: if this wait loop stops while browser ticks are in standby, Discord has no fast collector to discover new REST messages and produce events. LINE's public webhook can still persist new input. Verify event-driven task wakeup and a supported collector/recovery path separately; neither a saved subscription nor a callback `2xx` proves immediate replies.

For cutover, record the existing subscriptions/task prompt and finish pending work. Pause or unsubscribe only the owned dot reply-event consumers, then enable the new receiver with a reviewed activation timestamp. Keep the required `LINE_ENABLE_EVENTS` / `DISCORD_ENABLE_EVENTS` intake flags and existing allowlists; unsubscribe consumers rather than disabling the channel ingestion needed by the new receiver. Use one cloud-task consumer, retain the existing hourly recovery task, and do not add staggered schedules or expand access. Hourly recovery is a fallback, not proof of immediate or continuous service.

On 2026-10-15, fresh client messages received native cloud Work replies with the owned local bridge services stopped, browser ticks in standby, and the local cloud-chat panel closed. Observed source-to-reply times were:

| Input | Observed time |
| --- | --- |
| LINE | 5.8 seconds |
| Discord during concurrent LINE/Discord input | 21.3 seconds |
| Discord alone after resuming the receiver | 11.6 seconds |
| LINE conversation continuation after encrypted history was enabled | 10.3 seconds |
| Discord conversation continuation with its own separate history | 14.8 seconds |

Both native clients also answered follow-up questions using facts supplied only in their own prior conversation. Two LINE follow-ups took 70.3 and 69.2 seconds end to end: their platform timestamps preceded cloud persistence by about 62.6 and 62.8 seconds, followed by 7.6 and 6.3 seconds to API completion. The delayed webhook invocation returned HTTP 200 in 1.14 seconds; its delay before persistence remains unexplained. The official LINE API confirmed that the expected public webhook was active. Owner diagnostics expose `source_occurred_at` and `interval_ms.occurred_to_recorded` without another content read or network call. `line_first_ingress_is_redelivery` records only a boolean from validated ingress through best-effort background work. Missing flags, old records, or an unavailable execution context return null. A further real LINE message took 68.3 seconds, including 62.4 seconds before persistence, and this flag was true on its first recorded ingress; its reply completed 5.8 seconds after persistence. Official LINE webhook probes reproduced intermittent `REQUEST_TIMEOUT` responses, including against the constant `/health` route. This places further investigation on the ingress path; the failing attempt has not been located, and missing Worker logs are not conclusive proof. Successful probes also occurred while the receiver was active, so general serialization by long polling is unproven. LINE Developers webhook error statistics still require an authenticated account session for investigation.

A controlled interruption test observed the lease expire, followed by a new `bridge_maintain` call and lease acquisition through the existing recovery path at 20:22 JST, after its 20:20 schedule. The two queued client messages received correct, history-aware replies after 219.5 and 228.9 seconds. No manual Run action or restart prompt was used. The operations history was opened read-only while startup was delayed; an automatic-run ID and start timestamp were not obtained. Treat this as observed recovery with that limitation, not proof of a cold restart with every UI closed or of immediate recovery.

These are individual observations, not a latency guarantee or a controlled comparison of models. Physical laptop shutdown, continuous 24-hour operation, and automatic task restart are not established by these tests. The existing hourly fallback cannot provide immediate recovery if the fast receiver stops, and scheduled runs can themselves be delayed or fail.

For each installation, verify fresh LINE and Discord input, a claim and completed send, and the actual reply in the same client conversation with the owned laptop receivers unavailable and browser ticks in standby. Measure source-to-reply time without manual reply nudges, then separately test task interruption, lease expiry/reacquisition, and recovery. This path remains experimental while continuation and restart guarantees are unresolved. To roll back, stop the new consumer, disable `CLOUD_AGENT_ENABLED` and redeploy, and restore the recorded owned subscriptions and one cloud receiver. Preserve the watermark, claims, send records, secrets and database; never revive uncertain sends by clearing them.

## Checks

```sh
node --test adapters/sites/tests/*.test.mjs
```

For schema changes, install this adapter's dev dependencies in the supported Sites workflow, update `db/schema.ts`, run `npm run db:generate`, inspect the generated migration, and build/package with the Sites source helper. Source identifiers, tokens, database contents, and private evidence are not part of this directory.
